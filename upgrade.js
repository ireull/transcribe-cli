import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import chalk from 'chalk';
import ora from 'ora';

const MARKER_PATH = join(homedir(), '.transcribe', 'install-source.json');

function readSource() {
  if (!existsSync(MARKER_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(MARKER_PATH, 'utf-8'));
    return data.path || null;
  } catch {
    return null;
  }
}

function isTranscribeSource(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return pkg.name === 'transcribe-cli';
  } catch {
    return false;
  }
}

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

function errMsg(e) {
  return (e.stderr?.toString() || e.message || '').trim();
}

/**
 * Автоматическое обновление: git pull + npm install + npm pack + npm install -g.
 * Работает только если установка была из git-клона (маркер install-source.json
 * пишется в postinstall.js при первом запуске install.sh).
 */
export async function runUpgrade() {
  console.log();

  const sourceDir = readSource();
  if (!sourceDir) {
    console.log(chalk.red('  Маркер установки не найден.'));
    console.log(chalk.dim(`  Ожидался: ${MARKER_PATH}`));
    console.log(chalk.dim('  Это первый upgrade на новой версии? Запустите install.sh'));
    console.log(chalk.dim('  руками один раз — дальше `transcribe upgrade` будет работать.'));
    return;
  }

  if (!existsSync(sourceDir)) {
    console.log(chalk.red(`  Исходники удалены: ${sourceDir}`));
    console.log(chalk.dim('  Склонируйте репозиторий заново и запустите install.sh.'));
    return;
  }

  if (!isTranscribeSource(sourceDir)) {
    console.log(chalk.red(`  ${sourceDir} — не похоже на исходники transcribe-cli.`));
    return;
  }

  if (!existsSync(join(sourceDir, '.git'))) {
    console.log(chalk.yellow(`  ${sourceDir} — не git-репозиторий.`));
    console.log(chalk.dim('  Автообновление работает только для git clone.'));
    return;
  }

  console.log(chalk.cyan(`  Источник: ${sourceDir}`));
  console.log();

  // ─── 1. Fetch ─────────────────────────────────────────────────────
  const fetchSp = ora({ text: chalk.cyan('git fetch...'), spinner: 'dots' }).start();
  try {
    run('git fetch', sourceDir);
  } catch (e) {
    fetchSp.fail(`git fetch не удался: ${errMsg(e)}`);
    return;
  }

  let local, remote;
  try {
    local = run('git rev-parse HEAD', sourceDir).trim();
    remote = run('git rev-parse @{u}', sourceDir).trim();
  } catch (e) {
    fetchSp.fail(`Не могу определить upstream: ${errMsg(e)}`);
    console.log(chalk.dim('  Ветка не отслеживает remote? Проверьте: git status'));
    return;
  }

  if (local === remote) {
    fetchSp.succeed('Уже последняя версия.');
    return;
  }
  fetchSp.succeed(`Найдены обновления (${local.slice(0, 7)} → ${remote.slice(0, 7)}).`);

  // ─── 2. Pull ──────────────────────────────────────────────────────
  const pullSp = ora({ text: chalk.cyan('git pull --ff-only...'), spinner: 'dots' }).start();
  try {
    run('git pull --ff-only', sourceDir);
    pullSp.succeed('Код обновлён.');
  } catch (e) {
    pullSp.fail(`git pull не удался: ${errMsg(e)}`);
    console.log(chalk.dim('  Локальные изменения или non-fast-forward. Разберитесь в:'));
    console.log(chalk.dim(`    ${sourceDir}`));
    return;
  }

  // ─── 3. Reinstall (повтор install.sh без bash) ────────────────────
  const installSp = ora({ text: chalk.cyan('npm install + pack + install -g (может занять минуту)...'), spinner: 'dots' }).start();
  try {
    run('npm install --production', sourceDir);
    run('npm pack', sourceDir);

    const tgzFiles = readdirSync(sourceDir)
      .filter(f => f.startsWith('transcribe-cli-') && f.endsWith('.tgz'))
      .sort();
    if (!tgzFiles.length) throw new Error('npm pack не создал .tgz');
    const tgz = tgzFiles[tgzFiles.length - 1];

    run(`npm install -g "${tgz}"`, sourceDir);

    // Чистим tgz
    for (const f of tgzFiles) {
      try { unlinkSync(join(sourceDir, f)); } catch {}
    }

    installSp.succeed('Установка завершена.');
  } catch (e) {
    const msg = errMsg(e);
    installSp.fail(`Ошибка установки: ${msg}`);
    const needsSudo = /EACCES|permission denied/i.test(msg);
    if (needsSudo) {
      console.log(chalk.dim('  Нужны права. Запустите вручную:'));
      console.log(chalk.dim(`    cd "${sourceDir}" && sudo ./install.sh`));
    } else if (platform() === 'win32') {
      console.log(chalk.dim('  На Windows запущенный .exe может блокировать перезапись.'));
      console.log(chalk.dim(`  Закройте transcribe и запустите: cd "${sourceDir}" && install.bat`));
    } else {
      console.log(chalk.dim(`  Запустите вручную: cd "${sourceDir}" && ./install.sh`));
    }
    return;
  }

  console.log();
  console.log(
    chalk.green('  ✓ Обновлено ') +
    chalk.dim(`${local.slice(0, 7)}`) +
    chalk.green(' → ') +
    chalk.dim(`${remote.slice(0, 7)}`)
  );
  console.log(chalk.dim('  Изменения применятся при следующем запуске transcribe.'));
}
