import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';
import chalk from 'chalk';
import ora from 'ora';

// package.json лежит рядом с upgrade.js в папке глобальной установки пакета.
// Отсюда берём имя пакета (для npm) и текущую версию.
const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(PKG_DIR, 'package.json');

function readPkg() {
  try {
    return JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function compareVersions(a, b) {
  const parse = (v) => String(v || '').split('-')[0].split('.').map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });

  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const diff = (aa[i] || 0) - (bb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function getInstalledVersion() {
  return readPkg()?.version || '';
}

/**
 * Достаёт последнюю опубликованную версию из npm-реестра без установки.
 * Читает packument напрямую (GET registry) и берёт dist-tags.latest — быстрее,
 * чем спавнить `npm view`. Scoped-имя (@scope/pkg) в пути реестра валидно как есть.
 * Возвращает null при сетевой ошибке или 404 (пакет ещё не опубликован).
 */
async function fetchLatestVersion(name, timeoutMs = 2500) {
  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const r = await fetch(`https://registry.npmjs.org/${name}`, { signal: controller.signal });
    if (!r.ok) return null;
    const data = await r.json();
    return data['dist-tags']?.latest || null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkForUpdate({ timeoutMs } = {}) {
  try {
    const pkg = readPkg();
    const name = pkg?.name;
    const current = pkg?.version;
    if (!name || !current) return null;
    const latest = await fetchLatestVersion(name, timeoutMs);
    return {
      name,
      current,
      latest,
      hasUpdate: !!(latest && compareVersions(latest, current) > 0),
    };
  } catch {
    return null;
  }
}

/**
 * Автоматическое обновление через npm-реестр: `npm install -g <name>@latest`.
 *
 * npm сам скачивает свежий тарбол из реестра, ставит зависимости и обновляет
 * глобальную установку — локальная папка с исходниками не нужна, пакет публичный
 * (никаких токенов для установки не требуется).
 *
 * Имя пакета читается из поля `name` собственного package.json установленной
 * версии. Перед установкой сверяем latest из реестра с установленной версией —
 * если совпали, ранний выход без запуска npm (экономит ~20 секунд).
 */
export async function runUpgrade() {
  console.log();

  const pkg = readPkg();
  if (!pkg?.name) {
    console.log(chalk.red('  Не могу прочитать package.json установки.'));
    console.log(chalk.dim(`  Ожидался: ${PKG_PATH}`));
    return false;
  }

  const name = pkg.name;
  const oldVersion = pkg.version;
  const npmUrl = `https://www.npmjs.com/package/${name}`;
  const target = `${name}@latest`;
  console.log(chalk.cyan(`  Текущая версия: ${oldVersion}`));
  console.log(chalk.cyan(`  Пакет:          ${name}`));
  console.log();

  // ─── 1. Проверка последней версии в реестре (без установки) ───────
  const checkSp = ora({ text: chalk.cyan('Проверяю последнюю версию...'), spinner: 'dots' }).start();
  const remoteVersion = await fetchLatestVersion(name);
  if (remoteVersion) {
    if (compareVersions(remoteVersion, oldVersion) <= 0) {
      checkSp.succeed(`Уже последняя версия (${oldVersion}).`);
      return false;
    }
    checkSp.succeed(`Доступна версия ${remoteVersion} (у вас ${oldVersion}).`);
  } else {
    checkSp.warn('Не удалось проверить версию — продолжаю установку.');
  }

  // ─── 2. Установка ─────────────────────────────────────────────────
  const installSp = ora({
    text: chalk.cyan(`npm install -g ${target}`),
    spinner: 'dots',
  }).start();
  try {
    execSync(`npm install -g "${target}"`, { stdio: 'pipe', encoding: 'utf-8' });
    installSp.succeed('Установка завершена.');
  } catch (e) {
    const msg = (e.stderr?.toString() || e.message || '').trim();
    installSp.fail(`Ошибка установки: ${msg.split('\n')[0] || 'unknown'}`);

    if (/EACCES|permission denied/i.test(msg)) {
      console.log(chalk.dim('  Нужны права. Запустите вручную:'));
      console.log(chalk.dim(`    sudo npm install -g "${target}"`));
    } else if (platform() === 'win32') {
      console.log(chalk.dim('  На Windows запущенный процесс transcribe может блокировать перезапись.'));
      console.log(chalk.dim('  Закройте все окна transcribe и повторите команду.'));
    } else {
      console.log(chalk.dim('  Запустите вручную:'));
      console.log(chalk.dim(`    npm install -g "${target}"`));
    }
    console.log(chalk.dim(`  Страница пакета: ${npmUrl}`));

    if (msg) {
      console.log();
      console.log(chalk.dim('  Полный текст ошибки:'));
      for (const line of msg.split('\n').slice(0, 10)) console.log(chalk.dim(`    ${line}`));
    }
    return false;
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
  return true;
}
