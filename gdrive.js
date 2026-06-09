import { drive as driveApi } from '@googleapis/drive';
import { GoogleAuth } from 'google-auth-library';
import { createWriteStream, existsSync, readFileSync, copyFileSync, mkdirSync, renameSync, rmSync } from 'fs';
import { join, basename } from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { sanitizeFilename } from './transcribe.js';
import { CONFIG_DIR } from './config.js';

// SA-ключ лежит рядом с config.json в XDG-папке — не зависит от npm,
// переживает переустановку.
const SA_KEY_PATH = join(CONFIG_DIR, 'service-account.json');

/**
 * Проверяет наличие SA-ключа.
 */
export function hasSaKey() {
  return existsSync(SA_KEY_PATH);
}

export function getSaKeyPath() {
  return SA_KEY_PATH;
}

/**
 * Импортирует SA-ключ из указанного файла.
 * Проверяет что файл — валидный SA JSON.
 * Возвращает { ok, error? }
 */
export function importSaKey(sourcePath) {
  try {
    const raw = readFileSync(sourcePath, 'utf-8');
    const data = JSON.parse(raw);

    if (!data.client_email || !data.private_key) {
      return { ok: false, error: 'Файл не похож на SA-ключ (нет client_email или private_key).' };
    }

    mkdirSync(CONFIG_DIR, { recursive: true });
    copyFileSync(sourcePath, SA_KEY_PATH);
    return { ok: true, email: data.client_email };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Создает авторизованный Drive-клиент.
 */
function getDriveClient(write = false) {
  if (!existsSync(SA_KEY_PATH)) {
    throw new Error(
      `SA-ключ не найден: ${SA_KEY_PATH}\n` +
      `  Добавьте через: transcribe → Meet → выбрать файл`
    );
  }

  const key = JSON.parse(readFileSync(SA_KEY_PATH, 'utf-8'));
  const auth = new GoogleAuth({
    credentials: key,
    // По умолчанию readonly; полный `drive` (read+write) запрашиваем только
    // когда нужна запись — переименование исходника. Least privilege.
    scopes: [write
      ? 'https://www.googleapis.com/auth/drive'
      : 'https://www.googleapis.com/auth/drive.readonly'],
  });

  return driveApi({ version: 'v3', auth });
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
 * Прокручивает все страницы по запросу `q`, пока не наберёт `limit` файлов.
 * Drive отдаёт максимум 1000 за раз — для поиска нам нужно широкое окно
 * (фильтрация в UI локальная, без запроса на каждую букву), поэтому
 * листаем с пагинацией, а не одним вызовом с маленьким pageSize.
 */
async function paginateFiles(drive, q, limit) {
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id, name, size, createdTime, mimeType)',
      orderBy: 'createdTime desc',
      pageSize: Math.min(1000, limit - files.length),
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken && files.length < limit);
  return files.slice(0, limit);
}

/**
 * Листает видео/аудио-файлы в папке (свежие сверху).
 * Возвращает [{id, name, size, createdTime, mimeType}]
 */
export async function listRecordings(drive, folderId, limit = 500) {
  return paginateFiles(
    drive,
    `'${folderId}' in parents and trashed = false and (mimeType contains 'video/' or mimeType contains 'audio/')`,
    limit
  );
}

/**
 * Листает все файлы, доступные SA (если папки нет).
 */
export async function listAllFiles(drive, limit = 500) {
  return paginateFiles(
    drive,
    `trashed = false and (mimeType contains 'video/' or mimeType contains 'audio/')`,
    limit
  );
}

/**
 * Скачивает файл по ID в указанную директорию.
 * Возвращает путь к скачанному файлу.
 */
export async function downloadFile(drive, fileId, fileName, destDir) {
  const safeName = sanitizeFilename(fileName);
  const destPath = join(destDir, safeName);
  const partPath = `${destPath}.part`;

  const spinner = ora({ text: chalk.cyan(`Скачиваю: ${safeName}...`), spinner: 'dots' }).start();

  try {
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );

    await new Promise((resolve, reject) => {
      const dest = createWriteStream(partPath);
      const fail = (err) => {
        dest.destroy();
        reject(err);
      };
      res.data.on('error', fail);
      dest.on('error', fail);
      dest.on('finish', resolve);
      res.data.pipe(dest);
    });

    renameSync(partPath, destPath);
    spinner.succeed(`Скачано: ${safeName}`);
    return destPath;
  } catch (e) {
    try { rmSync(partPath, { force: true }); } catch {}
    spinner.fail(`Ошибка скачивания: ${e.message}`);
    throw e;
  }
}

/**
 * Главная функция — получает Drive-клиент и список записей.
 * Возвращает { drive, files } или null при ошибке.
 */
export async function getMeetRecordings({ limit = 500, write = false } = {}) {
  const drive = getDriveClient(write);

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
 * Переименовывает файл на Google Drive (metadata-only update — контент не
 * трогается). Требует write-scope у клиента (getDriveClient(true)) и доступа
 * «Редактор» у SA к файлу; иначе Drive вернёт 403 — вызывающий ловит ошибку.
 */
export async function renameDriveFile(drive, fileId, newName) {
  await drive.files.update({
    fileId,
    requestBody: { name: newName },
    supportsAllDrives: true,
  });
}

/**
 * Вычисляет имя для переименования исходника на Диске — или `null`, если
 * переименовывать не нужно. Берём ровно имя выходного `.md` (то, что увидел
 * пользователь, включая коллизийный суффикс `_N` — ничего не режем). Возвращаем
 * `null`, когда имя бессмысленное: fallback `transcript` или дефолт
 * «Запись[ — дата]» (саммари выкл/упало — переименовывать код в код не нужно),
 * либо когда имя уже совпадает с текущим. Сохраняем исходное медиа-расширение,
 * если оно реально было (regex заякорен на `$` и на whitelist — точки в датах
 * вида `2026.05.26` за расширение не принимаются).
 */
export function driveRenameTarget(outPath, originalName) {
  const newBase = basename(outPath, '.md');
  if (!newBase || newBase === 'transcript' || /^Запись( —|$)/.test(newBase)) return null;
  const m = (originalName || '').match(/\.(mp4|mkv|webm|mov|avi|m4a|mp3|wav|ogg|flac)$/i);
  const ext = m ? m[0] : '';
  const target = ext && !newBase.toLowerCase().endsWith(ext.toLowerCase()) ? `${newBase}${ext}` : newBase;
  return target === originalName ? null : target;
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

/**
 * Чистит авто-имя записи Google Meet до «Ядро — YYYY-MM-DD».
 * Срезает «– Recording N», таймзоны/время, нормализует дату.
 * Определяет «дефолтные» имена (код встречи xxx-xxxx-xxx или пусто) —
 * для них имя осмысленным не считается (потом возьмём из саммари LLM).
 *
 * Возвращает { clean, isGeneric }.
 *   "Planning & Status check - 2026/06/01 15:30 CEST – Recording 2"
 *     → { clean: "Planning & Status check — 2026-06-01", isGeneric: false }
 *   "bbb-tupg-phm (2026-05-26 20:02 GMT+2)"
 *     → { clean: "Запись — 2026-05-26", isGeneric: true }
 */
export function cleanMeetName(raw) {
  let s = String(raw || '').trim();

  // 1. Дата в любом из распространённых форматов → YYYY-MM-DD.
  let date = '';
  const md = s.match(/(\d{4})[/.-](\d{2})[/.-](\d{2})/);
  if (md) date = `${md[1]}-${md[2]}-${md[3]}`;

  // 2. Хвост «– Recording», «- Recording 2», «(Recording)».
  s = s.replace(/[\s\-–—]*\(?\bRecording\b\s*\d*\)?\s*$/i, '');
  // 3. Скобки с датой/временем/таймзоной (но не «(Имя Фамилия)»).
  s = s.replace(/\(\s*\d{4}[/.-]\d{2}[/.-]\d{2}[^)]*\)/g, '');
  // 4. Хвост « - 2026/06/01 15:30 CEST» (всё от даты после тире).
  s = s.replace(/[\s\-–—]+\d{4}[/.-]\d{2}[/.-]\d{2}.*$/i, '');
  // 5. Остатки времени и таймзон.
  s = s.replace(/\b\d{1,2}:\d{2}\b/g, '')
       .replace(/\b(CEST|CET|GMT|UTC|MSK|EST|EDT|PST|PDT)([+-]\d{1,2})?\b/gi, '');

  const core = s.replace(/\s{2,}/g, ' ').replace(/[\s\-–—]+$/, '').trim();

  // Код встречи Google Meet: xxx-xxxx-xxx.
  const isCode = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(core);
  const isGeneric = !core || isCode;

  const clean = isGeneric
    ? (date ? `Запись — ${date}` : 'Запись')
    : (date ? `${core} — ${date}` : core);

  return { clean, isGeneric };
}
