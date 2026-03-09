import { existsSync, writeFileSync, unlinkSync, chmodSync } from 'fs';
import { execSync } from 'child_process';
import { platform, homedir } from 'os';
import { join } from 'path';
import chalk from 'chalk';

const IS_MAC = platform() === 'darwin';
const IS_WIN = platform() === 'win32';
const NAME = 'Transcribe';

function getDesktop() {
  if (IS_WIN) {
    const od = process.env.OneDrive;
    if (od) { const p = join(od, 'Desktop'); if (existsSync(p)) return p; }
    return join(homedir(), 'Desktop');
  }
  return join(homedir(), 'Desktop');
}

export function shortcutExists() {
  const d = getDesktop();
  if (IS_MAC) return existsSync(join(d, `${NAME}.command`));
  if (IS_WIN) return existsSync(join(d, `${NAME}.bat`)) || existsSync(join(d, `${NAME}.lnk`));
  return existsSync(join(d, `${NAME}.desktop`));
}

export function createShortcut() {
  const d = getDesktop();
  if (!existsSync(d)) { console.log(chalk.red(`Рабочий стол не найден: ${d}`)); return false; }
  try {
    if (IS_MAC) return macShortcut(d);
    if (IS_WIN) return winShortcut(d);
    return linuxShortcut(d);
  } catch (e) { console.log(chalk.red(`Ошибка: ${e.message}`)); return false; }
}

export function removeShortcut() {
  const d = getDesktop();
  const names = IS_MAC ? [`${NAME}.command`] : IS_WIN ? [`${NAME}.bat`, `${NAME}.lnk`] : [`${NAME}.desktop`];
  let ok = false;
  for (const n of names) { const p = join(d, n); if (existsSync(p)) { unlinkSync(p); ok = true; } }
  return ok;
}

function macShortcut(d) {
  const p = join(d, `${NAME}.command`);
  writeFileSync(p, `#!/bin/bash\ncd ~\ntranscribe\n`, 'utf-8');
  chmodSync(p, 0o755);
  console.log(chalk.green(`✓ Ярлык: ${p}`));
  console.log(chalk.dim('  Двойной клик откроет Terminal.'));
  return true;
}

function winShortcut(d) {
  // .lnk через PowerShell
  try {
    const p = join(d, `${NAME}.lnk`).replace(/\\/g, '\\\\');
    const ps = `$ws=New-Object -ComObject WScript.Shell;$s=$ws.CreateShortcut('${p}');$s.TargetPath='cmd.exe';$s.Arguments='/k transcribe';$s.WorkingDirectory=$env:USERPROFILE;$s.Save()`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 10000 });
    if (existsSync(join(d, `${NAME}.lnk`))) {
      console.log(chalk.green(`✓ Ярлык: ${join(d, NAME + '.lnk')}`));
      return true;
    }
  } catch {}
  // fallback .bat
  const p = join(d, `${NAME}.bat`);
  writeFileSync(p, `@echo off\ncd /d "%USERPROFILE%"\ntranscribe\npause\n`, 'utf-8');
  console.log(chalk.green(`✓ Ярлык: ${p}`));
  return true;
}

function linuxShortcut(d) {
  const p = join(d, `${NAME}.desktop`);
  writeFileSync(p, `[Desktop Entry]\nType=Application\nName=${NAME}\nExec=bash -c 'transcribe; exec bash'\nTerminal=true\n`, 'utf-8');
  chmodSync(p, 0o755);
  console.log(chalk.green(`✓ Ярлык: ${p}`));
  return true;
}
