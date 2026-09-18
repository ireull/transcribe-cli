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

// Корневые папки Meet на Диске. «Meet Recordings» — старая плоская схема (до
// июля 2026 все записи лежали в ней одним списком). «Google Meet» — новая:
// внутри подпапка на каждую встречу (повторяющиеся делят одну), а старую папку
// Google переносит внутрь как «Legacy Meet Recordings». Спец-маркеров
// (appProperties/mimeType) у этих папок нет — опознаём только по имени.
export const MEET_ROOT_NAMES = ['Google Meet', 'Meet Recordings', 'Legacy Meet Recordings'];
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const FILE_FIELDS = 'id, name, size, createdTime, mimeType, parents, owners(emailAddress), shortcutDetails(targetId, targetMimeType)';
const isMedia = (mime) => /^(video|audio)\//.test(mime || '');

/**
 * Ищет корневые папки Meet (см. MEET_ROOT_NAMES): точные имена плюс
 * `contains 'Meet Recordings'` — для старых папок, переименованных руками.
 * SA видит только то, что ему расшарили. `ownedOnly` — только папки самого
 * аккаунта (`'me' in owners`): для OAuth-клиента под пользователем, чтобы
 * не подхватывать чужие Meet-папки, расшаренные ему.
 */
export async function findMeetFolders(drive, { ownedOnly = false } = {}) {
  const exact = MEET_ROOT_NAMES.map(n => `name = '${n}'`).join(' or ');
  const res = await drive.files.list({
    q: `mimeType = '${FOLDER_MIME}' and trashed = false${ownedOnly ? " and 'me' in owners" : ''} and (${exact} or name contains 'Meet Recordings')`,
    fields: 'files(id, name)',
    pageSize: 50,
    orderBy: 'createdTime',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files || [];
}

/**
 * Прокручивает страницы по запросу `q`, пока не наберёт `limit` файлов.
 * Drive отдаёт максимум 1000 за раз — для поиска нам нужно широкое окно
 * (фильтрация в UI локальная, без запроса на каждую букву), поэтому
 * листаем с пагинацией. `pick(file)` — локальный фильтр/преобразование:
 * вернул объект — берём его, вернул null — пропускаем; лимит считается по
 * взятым, так что отсев не съедает окно.
 */
async function paginateFiles(drive, q, limit, { fields = FILE_FIELDS, pick = f => f } = {}) {
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q,
      fields: `nextPageToken, files(${fields})`,
      orderBy: 'createdTime desc',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files || []) {
      const kept = pick(f);
      if (kept) files.push(kept);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken && files.length < limit);
  return files.slice(0, limit);
}

/**
 * Подпапки одного уровня (новая схема: папка встречи внутри «Google Meet»).
 */
async function listSubfolders(drive, folderId, limit = 2000) {
  return paginateFiles(
    drive,
    `'${folderId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    limit,
    { fields: 'id, name' }
  );
}

/**
 * Ярлык (shortcut) на медиа разворачивается в целевой файл: у участников
 * встречи в их «Google Meet» лежат именно ярлыки, а не файлы. Подменяем
 * id/mimeType на target, чтобы скачивание и переименование шли по настоящему
 * файлу; исходный id ярлыка — в `shortcutId`. Не-медиа и ярлыки на не-медиа
 * отбрасываются (null). size/createdTime/name у ярлыка свои (size вообще
 * пустой) — их дочитывает resolveShortcutTargets.
 */
function resolveMedia(f) {
  if (f.mimeType !== SHORTCUT_MIME) return isMedia(f.mimeType) ? f : null;
  const t = f.shortcutDetails || {};
  if (!t.targetId || !isMedia(t.targetMimeType)) return null;
  return { ...f, id: t.targetId, mimeType: t.targetMimeType, shortcutId: f.id };
}

/**
 * Дочитывает у ярлыков метаданные целевого файла (имя, размер, дата — иначе
 * в списке «?» и дата создания ярлыка вместо даты записи). Ярлык, чья цель
 * SA недоступна (файл организатора не расшарен на SA — обычный случай для
 * папки участника), выпадает из списка: скачать его всё равно нельзя.
 * Ярлыков обычно единицы, но на всякий случай — пачками, не все разом.
 */
async function resolveShortcutTargets(drive, shortcuts, batch = 20) {
  const out = [];
  for (let i = 0; i < shortcuts.length; i += batch) {
    const results = await Promise.allSettled(shortcuts.slice(i, i + batch).map(async s => {
      const r = await drive.files.get({ fileId: s.id, fields: 'id, name, size, createdTime, mimeType, owners(emailAddress)', supportsAllDrives: true });
      return { ...s, ...r.data };
    }));
    for (const r of results) if (r.status === 'fulfilled') out.push(r.value);
  }
  return out;
}

/**
 * Все видео/аудио (и ярлыки на них), доступные клиенту, где бы они ни лежали —
 * свежие сверху. `keep(file)` — доп. локальный фильтр (например, по папке).
 * `ownedOnly` — только файлы самого аккаунта; ярлыки при этом не берём вовсе
 * (ярлык ведёт на чужую запись, а нужны свои).
 */
export async function listAllFiles(drive, limit = 500, keep = () => true, { ownedOnly = false } = {}) {
  const media = ownedOnly
    ? `'me' in owners and (mimeType contains 'video/' or mimeType contains 'audio/')`
    : `(mimeType contains 'video/' or mimeType contains 'audio/' or mimeType = '${SHORTCUT_MIME}')`;
  return paginateFiles(
    drive,
    `trashed = false and ${media}`,
    limit,
    {
      pick: f => {
        if (ownedOnly && f.mimeType === SHORTCUT_MIME) return null;
        const m = resolveMedia(f);
        return m && keep(m) ? m : null;
      },
    }
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
 * Объединяет списки записей из нескольких папок: дедуп по id,
 * сортировка по createdTime desc (ISO-строки сортируются лексикографически),
 * обрезка до limit.
 */
export function mergeRecordings(lists, limit) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const item of list) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
  }
  merged.sort((a, b) => {
    const ta = a.createdTime || '';
    const tb = b.createdTime || '';
    return tb < ta ? -1 : tb > ta ? 1 : 0;
  });
  return merged.slice(0, limit);
}

/**
 * Собирает записи по переданному drive-клиенту (инжектируемый для тестов).
 * Возвращает { files, roots }: `roots` — найденные корневые папки Meet
 * (для диагностики в UI).
 *
 * Схема: корни по имени → их подпапки (один уровень: папки встреч в
 * «Google Meet», а также «Legacy Meet Recordings», когда Google уже перенёс
 * старую папку внутрь) → ОДИН глобальный запрос медиа, доступных SA, с
 * локальным фильтром по родителю. Не по запросу на папку: папок встреч со
 * временем сотни. Записи из папки встречи получают `folderName` — оттуда
 * берётся название, если файл назван кодом встречи (см. recordingName).
 *
 * Если корней нет — все медиа SA без фильтра (расшарено что-то другое).
 * Недоступный корень (403/5xx на подпапках) не обрывает запрос — его прямые
 * записи всё равно придут глобальным запросом. Если ВСЕ корни отклонились —
 * пробрасываем первую ошибку (это уже проблема авторизации).
 * Ярлык и настоящий файл на одну запись — оставляем настоящий; у остальных
 * ярлыков дочитываем метаданные цели (недоступные — выпадают).
 *
 * Опции: `ownedOnly` — только папки и файлы самого аккаунта (см.
 * findMeetFolders/listAllFiles; без корней — пусто, а не все видео аккаунта),
 * `rootIds` — явные корни по ID в дополнение к найденным по имени (например,
 * папка из конфига; недоступный ID — ошибка, это неверная настройка, а не
 * «нет записей»).
 */
export async function collectRecordings(drive, limit = 500, { ownedOnly = false, rootIds = [] } = {}) {
  const roots = await findMeetFolders(drive, { ownedOnly });
  for (const id of rootIds || []) {
    if (!id || roots.some(r => r.id === id)) continue;
    const r = await drive.files.get({ fileId: id, fields: 'id, name', supportsAllDrives: true });
    roots.push({ id: r.data.id, name: r.data.name });
  }
  let files;
  if (roots.length === 0) {
    // Без корней: SA видит только расшаренное, так что «все медиа» — разумный
    // fallback. Но при ownedOnly (OAuth под аккаунтом) это были бы ВСЕ видео
    // аккаунта, а не записи Meet — тогда честнее пусто.
    files = ownedOnly ? [] : await listAllFiles(drive, limit);
  } else {
    const subs = await Promise.allSettled(roots.map(r => listSubfolders(drive, r.id)));
    if (subs.every(s => s.status === 'rejected')) throw subs[0].reason;

    const folders = new Map(roots.map(r => [r.id, { ...r, isRoot: true }]));
    for (const s of subs) {
      if (s.status !== 'fulfilled') continue;
      for (const f of s.value) {
        if (!folders.has(f.id)) folders.set(f.id, { ...f, isRoot: MEET_ROOT_NAMES.includes(f.name) });
      }
    }

    const parentOf = f => (f.parents || []).find(p => folders.has(p));
    const found = await listAllFiles(drive, limit, f => parentOf(f) !== undefined, { ownedOnly });
    files = found.map(f => {
      const folder = folders.get(parentOf(f));
      return folder.isRoot ? f : { ...f, folderName: folder.name };
    });
  }

  const real = files.filter(f => !f.shortcutId);
  const realIds = new Set(real.map(f => f.id));
  const shortcuts = await resolveShortcutTargets(drive, files.filter(f => f.shortcutId && !realIds.has(f.id)));
  // `account` — чей это Диск: запись Meet принадлежит аккаунту организатора
  // (у ярлыка — владелец цели, он уже дочитан). На Shared Drive owners нет.
  const withAccount = mergeRecordings([real, shortcuts], limit)
    .map(f => ({ ...f, account: accountLabel(f.owners?.[0]?.emailAddress) }));
  return { files: withAccount, roots };
}

/**
 * Короткая метка аккаунта для UI: у gmail — только имя ящика («londeren»),
 * у доменных аккаунтов — весь адрес, чтобы «vadim@a.com» и «vadim@b.com» не
 * слипались. Без email — пустая строка.
 */
export function accountLabel(email) {
  const m = String(email || '').toLowerCase().match(/^([^@]+)@(gmail|googlemail)\.com$/);
  return m ? m[1] : String(email || '');
}

/**
 * Сводка «имя ×N» по списку строк, в порядке первого появления:
 * ['a','b','a'] → «a ×2, b ×1».
 */
export function describeCounts(names) {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  return [...counts].map(([name, n]) => `${name} ×${n}`).join(', ');
}

/**
 * Имя записи для транскрипта. В новой схеме файл может называться кодом
 * встречи («ycw-hgwf-vvd (2026-09-11 15:02 GMT+3)»), а осмысленное название —
 * на папке встречи; тогда берём его оттуда. Возвращает { clean, isGeneric }
 * как cleanMeetName.
 */
export function recordingName(file) {
  const own = cleanMeetName(file.name);
  if (!own.isGeneric || !file.folderName) return own;
  const alt = cleanMeetName(file.folderName);
  if (alt.isGeneric) return own;
  // Папка серии (recurring) может быть без даты — дата тогда есть только у
  // файла; без неё записи одной серии слипались бы в одно имя.
  const date = own.clean.match(/\d{4}-\d{2}-\d{2}$/)?.[0];
  if (date && !/\d{4}-\d{2}-\d{2}$/.test(alt.clean)) return { ...alt, clean: `${alt.clean} — ${date}` };
  return alt;
}

/**
 * Сводка по найденным корневым папкам для UI: «Google Meet ×1, Meet Recordings ×2».
 */
export function describeRoots(roots) {
  return describeCounts(roots.map(r => r.name));
}

/**
 * Главная функция — получает Drive-клиент и список записей.
 * Возвращает { drive, files, roots }.
 */
export async function getMeetRecordings({ limit = 500, write = false, ...opts } = {}) {
  const drive = getDriveClient(write);
  const { files, roots } = await collectRecordings(drive, limit, opts);
  return { drive, files, roots };
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
