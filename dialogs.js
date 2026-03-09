import { execSync } from 'child_process';
import { platform } from 'os';

const IS_MAC = platform() === 'darwin';
const IS_WIN = platform() === 'win32';

export function pickFile(initialDir = '') {
  try {
    if (IS_MAC) return pickFileMac(initialDir);
    if (IS_WIN) return pickFileWin(initialDir);
    return null;
  } catch { return null; }
}

export function pickFiles(initialDir = '') {
  try {
    if (IS_MAC) return pickFilesMac(initialDir);
    if (IS_WIN) return pickFilesWin(initialDir);
    return [];
  } catch { return []; }
}

export function pickFolder(initialDir = '') {
  try {
    if (IS_MAC) return pickFolderMac(initialDir);
    if (IS_WIN) return pickFolderWin(initialDir);
    return null;
  } catch { return null; }
}

// ─── macOS ─────────────────────────────────────────────────────────

function pickFileMac(dir) {
  const clause = dir ? `default location POSIX file "${dir}"` : '';
  const script = `set f to choose file ${clause} with prompt "Выберите аудио/видео файл" of type {"public.movie","public.audio"}\nreturn POSIX path of f`;
  return execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 120000 }).trim() || null;
}

function pickFilesMac(dir) {
  const clause = dir ? `default location POSIX file "${dir}"` : '';
  const script = [
    `set fList to choose file ${clause} with prompt "Выберите файлы (Cmd+клик)" of type {"public.movie","public.audio"} with multiple selections allowed`,
    `set output to ""`,
    `repeat with f in fList`,
    `set output to output & POSIX path of f & "\\n"`,
    `end repeat`,
    `return output`,
  ].join('\n');
  return execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 120000 }).trim().split('\n').filter(Boolean);
}

function pickFolderMac(dir) {
  const clause = dir ? `default location POSIX file "${dir}"` : '';
  const script = `set f to choose folder ${clause} with prompt "Куда сохранить?"\nreturn POSIX path of f`;
  return execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 120000 }).trim() || null;
}

// ─── Windows ───────────────────────────────────────────────────────

const PS_UTF8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8';

function runPs(script) {
  return execSync(
    `powershell -NoProfile -Command "& { ${PS_UTF8}; ${script} }"`,
    { encoding: 'utf-8', timeout: 120000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }
  ).trim();
}

function pickFileWin(dir) {
  const initDir = dir ? dir.replace(/\//g, '\\') : '';
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    "$d.Title = 'Select audio/video file'",
    "$d.Filter = 'Media|*.mp4;*.mkv;*.avi;*.mov;*.webm;*.mp3;*.wav;*.ogg;*.flac;*.m4a;*.opus;*.aac|All|*.*'",
    initDir ? `$d.InitialDirectory = '${initDir}'` : '',
    "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }",
  ].filter(Boolean).join('; ');
  return runPs(ps) || null;
}

function pickFilesWin(dir) {
  const initDir = dir ? dir.replace(/\//g, '\\') : '';
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    "$d.Title = 'Select files'",
    "$d.Filter = 'Media|*.mp4;*.mkv;*.avi;*.mov;*.webm;*.mp3;*.wav;*.ogg;*.flac;*.m4a;*.opus;*.aac|All|*.*'",
    '$d.Multiselect = $true',
    initDir ? `$d.InitialDirectory = '${initDir}'` : '',
    "if ($d.ShowDialog() -eq 'OK') { $d.FileNames | ForEach-Object { Write-Output $_ } }",
  ].filter(Boolean).join('; ');
  return runPs(ps).split('\n').map(s => s.trim()).filter(Boolean);
}

function pickFolderWin(dir) {
  const initDir = dir ? dir.replace(/\//g, '\\') : '';
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Select folder'",
    initDir ? `$d.SelectedPath = '${initDir}'` : '',
    "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }",
  ].filter(Boolean).join('; ');
  return runPs(ps) || null;
}

/**
 * Открывает диалог выбора JSON-файла (для SA-ключа).
 */
export function pickJsonFile(initialDir = '') {
  try {
    if (IS_MAC) {
      const clause = initialDir ? `default location POSIX file "${initialDir}"` : '';
      const script = `set f to choose file ${clause} with prompt "Выберите service-account.json" of type {"public.json"}\nreturn POSIX path of f`;
      return execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 120000 }).trim() || null;
    }
    if (IS_WIN) {
      const initDir = initialDir ? initialDir.replace(/\//g, '\\') : '';
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        "$d.Title = 'Select service-account.json'",
        "$d.Filter = 'JSON|*.json|All|*.*'",
        initDir ? `$d.InitialDirectory = '${initDir}'` : '',
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }",
      ].filter(Boolean).join('; ');
      return runPs(ps) || null;
    }
    return null;
  } catch { return null; }
}