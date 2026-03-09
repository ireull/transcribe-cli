import { google } from 'googleapis';
import { createWriteStream, existsSync, readFileSync, copyFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import ora from 'ora';

// SA-ключ всегда рядом со скриптом — работает и локально, и после npm i -g
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SA_KEY_PATH = join(SCRIPT_DIR, 'service-account.json');

/**
 * Проверяет наличие SA-ключа.
 */
export function hasSaKey() {
  return existsSync(SA_KEY_PATH);
}

export function getSaKeyPath() {
  return SA_KEY_PATH;
}

export function getScriptDir() {
  return SCRIPT_DIR;
}

/**
 * Импортирует SA-ключ из указанного файла в папку скрипта.
 * Проверяет что файл — валидный SA JSON.
 * Возвращает { ok, error? }
 */
export function importSaKey(sourcePath) {
  try {
    const raw = readFileSync(sourcePath, 'utf-8');
    const data = JSON.parse(raw);

    // Проверяем что это SA-ключ, а не рандомный JSON
    if (!data.client_email || !data.private_key) {
      return { ok: false, error: 'Файл не похож на SA-ключ (нет client_email или private_key).' };
    }

    copyFileSync(sourcePath, SA_KEY_PATH);
    return { ok: true, email: data.client_email };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Создает авторизованный Drive-клиент.
 */
function getDriveClient() {
  if (!existsSync(SA_KEY_PATH)) {
    throw new Error(
      `SA-ключ не найден: ${SA_KEY_PATH}\n` +
      `  1. Создайте Service Account в Google Cloud Console\n` +
      `  2. Включите Google Drive API\n` +
      `  3. Скачайте JSON-ключ → service-account.json\n` +
      `  4. Положите его в: ${SCRIPT_DIR}\n` +
      `  5. Расшарьте папку Meet Recordings на email SA`
    );
  }

  const key = JSON.parse(readFileSync(SA_KEY_PATH, 'utf-8'));
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  return google.drive({ version: 'v3', auth });
}

/**
 * Ищет папку Meet Recordings (или по имени).
 * SA видит только то, что ему расшарили.
 */
export async function findMeetFolder(drive, folderName = 'Meet Recordings') {
  const res = await drive.files.list({
    q: `mimeType = 'application/vnd.google-apps.folder' and name contains '${folderName}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 20,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files || [];
}

/**
 * Листает видео-файлы в папке.
 * Возвращает [{id, name, size, createdTime, mimeType}]
 */
export async function listRecordings(drive, folderId, limit = 20) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and (mimeType contains 'video/' or mimeType contains 'audio/')`,
    fields: 'files(id, name, size, createdTime, mimeType)',
    orderBy: 'createdTime desc',
    pageSize: limit,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files || [];
}

/**
 * Листает все файлы, доступные SA (если папки нет).
 */
export async function listAllFiles(drive, limit = 20) {
  const res = await drive.files.list({
    q: `trashed = false and (mimeType contains 'video/' or mimeType contains 'audio/')`,
    fields: 'files(id, name, size, createdTime, mimeType)',
    orderBy: 'createdTime desc',
    pageSize: limit,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files || [];
}

/**
 * Скачивает файл по ID в указанную директорию.
 * Возвращает путь к скачанному файлу.
 */
export async function downloadFile(drive, fileId, fileName, destDir) {
  const destPath = join(destDir, fileName);

  const spinner = ora({ text: chalk.cyan(`Скачиваю: ${fileName}...`), spinner: 'dots' }).start();

  try {
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );

    await new Promise((resolve, reject) => {
      const dest = createWriteStream(destPath);
      res.data
        .on('error', reject)
        .pipe(dest)
        .on('finish', resolve)
        .on('error', reject);
    });

    spinner.succeed(`Скачано: ${fileName}`);
    return destPath;
  } catch (e) {
    spinner.fail(`Ошибка скачивания: ${e.message}`);
    throw e;
  }
}

/**
 * Главная функция — получает Drive-клиент и список записей.
 * Возвращает { drive, files } или null при ошибке.
 */
export async function getMeetRecordings(limit = 20) {
  const drive = getDriveClient();

  // Сначала ищем папку Meet Recordings
  const folders = await findMeetFolder(drive);

  let files;
  if (folders.length > 0) {
    // Берем первую найденную
    files = await listRecordings(drive, folders[0].id, limit);
  } else {
    // Нет папки — листаем все доступные файлы
    files = await listAllFiles(drive, limit);
  }

  return { drive, files };
}

/**
 * Форматирует размер файла.
 */
export function formatSize(bytes) {
  if (!bytes) return '?';
  const mb = parseInt(bytes) / (1024 * 1024);
  return mb > 1 ? `${mb.toFixed(1)} MB` : `${(parseInt(bytes) / 1024).toFixed(1)} KB`;
}

/**
 * Форматирует дату.
 */
export function formatDate(dateStr) {
  if (!dateStr) return '?';
  const d = new Date(dateStr);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}