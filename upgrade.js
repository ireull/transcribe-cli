import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';
import chalk from 'chalk';
import ora from 'ora';

// package.json лежит рядом с upgrade.js в папке глобальной установки пакета.
// Отсюда берём текущую версию и git-URL для обновления.
const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(PKG_DIR, 'package.json');

function readPkg() {
  try {
    return JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Парсит repository.url из package.json в:
 *   - install: строка для `npm install -g <...>` (с префиксом git+)
 *   - display: человекочитаемый https://github.com/user/repo для показа пользователю
 *   - slug:   { user, repo } для fetch к raw.githubusercontent.com
 */
function parseRepoUrl(repoField) {
  const raw = typeof repoField === 'string' ? repoField : repoField?.url;
  if (!raw) return null;

  const install = raw.startsWith('git+') ? raw : `git+${raw}`;

  // github.com/<user>/<repo> — матчит и /, и : в разделителе (scp-style git@host:user/repo)
  const m = raw.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  const display = m ? `https://github.com/${m[1]}/${m[2]}` : raw;
  const slug = m ? { user: m[1], repo: m[2] } : null;

  return { install, display, slug };
}

/**
 * Пытается достать version из package.json на GitHub без клонирования.
 * Работает только для публичных репозиториев. Пробует master, затем main.
 * Возвращает null при сетевой ошибке или для приватных репо (404).
 */
async function fetchRemoteVersion(slug) {
  if (!slug) return null;
  for (const branch of ['master', 'main']) {
    try {
      const url = `https://raw.githubusercontent.com/${slug.user}/${slug.repo}/${branch}/package.json`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const remote = await r.json();
      if (remote.version) return remote.version;
    } catch {
      // сетевая ошибка — пробуем следующую ветку
    }
  }
  return null;
}

/**
 * Автоматическое обновление: `npm install -g git+https://github.com/.../transcribe-cli.git`.
 *
 * npm сам клонирует в temp, ставит зависимости, вызывает postinstall и устанавливает
 * глобально — никакого локального git clone держать не нужно. Репозиторий публичный,
 * поэтому HTTPS URL — никакие SSH-ключи не требуются.
 *
 * Источник читается из поля `repository` в собственном package.json установленной версии.
 * Перед установкой проверяется remote-версия через raw.githubusercontent.com — если
 * она совпадает с установленной, ранний выход без запуска npm (экономит ~20 секунд).
 */
export async function runUpgrade() {
  console.log();

  const pkg = readPkg();
  if (!pkg) {
    console.log(chalk.red('  Не могу прочитать package.json установки.'));
    console.log(chalk.dim(`  Ожидался: ${PKG_PATH}`));
    return;
  }

  const repo = parseRepoUrl(pkg.repository);
  if (!repo) {
    console.log(chalk.red('  В package.json нет поля repository — не знаю, откуда качать.'));
    console.log(chalk.dim('  Обновитесь вручную: npm install -g git+https://github.com/<owner>/transcribe-cli.git'));
    return;
  }

  const oldVersion = pkg.version;
  console.log(chalk.cyan(`  Текущая версия: ${oldVersion}`));
  console.log(chalk.cyan(`  Источник:       ${repo.display}`));
  console.log();

  // ─── 1. Проверка версии на GitHub (без клонирования) ──────────────
  const checkSp = ora({ text: chalk.cyan('Проверяю последнюю версию...'), spinner: 'dots' }).start();
  const remoteVersion = await fetchRemoteVersion(repo.slug);
  if (remoteVersion) {
    if (remoteVersion === oldVersion) {
      checkSp.succeed(`Уже последняя версия (${oldVersion}).`);
      return;
    }
    checkSp.succeed(`Доступна версия ${remoteVersion} (у вас ${oldVersion}).`);
  } else {
    checkSp.warn('Не удалось проверить версию — продолжаю установку.');
  }

  // ─── 2. Установка ─────────────────────────────────────────────────
  const installSp = ora({
    text: chalk.cyan(`npm install -g ${repo.install}`),
    spinner: 'dots',
  }).start();
  try {
    execSync(`npm install -g "${repo.install}"`, { stdio: 'pipe', encoding: 'utf-8' });
    installSp.succeed('Установка завершена.');
  } catch (e) {
    const msg = (e.stderr?.toString() || e.message || '').trim();
    installSp.fail(`Ошибка установки: ${msg.split('\n')[0] || 'unknown'}`);

    if (/EACCES|permission denied/i.test(msg)) {
      console.log(chalk.dim('  Нужны права. Запустите вручную:'));
      console.log(chalk.dim(`    sudo npm install -g "${repo.install}"`));
    } else if (platform() === 'win32') {
      console.log(chalk.dim('  На Windows запущенный процесс transcribe может блокировать перезапись.'));
      console.log(chalk.dim('  Закройте все окна transcribe и повторите команду.'));
    } else {
      console.log(chalk.dim('  Запустите вручную:'));
      console.log(chalk.dim(`    npm install -g "${repo.install}"`));
    }

    if (msg) {
      console.log();
      console.log(chalk.dim('  Полный текст ошибки:'));
      for (const line of msg.split('\n').slice(0, 10)) console.log(chalk.dim(`    ${line}`));
    }
    return;
  }

  // ─── Покажем новую версию, перечитав package.json с диска ─────────
  // npm заменил файл по тому же пути — старые данные у нас в памяти,
  // но readFileSync вернёт свежие.
  const newPkg = readPkg();
  const newVersion = newPkg?.version;

  console.log();
  if (newVersion && newVersion !== oldVersion) {
    console.log(chalk.green('  ✓ Обновлено: ') + chalk.dim(`${oldVersion} → ${newVersion}`));
  } else if (newVersion === oldVersion) {
    console.log(chalk.green(`  ✓ Переустановлено (версия не изменилась: ${oldVersion}).`));
  } else {
    console.log(chalk.green('  ✓ Обновлено.'));
  }
  console.log(chalk.dim('  Изменения применятся при следующем запуске transcribe.'));
}
