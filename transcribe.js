import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, rmSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join, basename, extname } from 'path';
import { randomBytes } from 'crypto';
import chalk from 'chalk';
import ora from 'ora';

const DEEPGRAM_API = 'https://api.deepgram.com/v1/listen';
const DIRECT_AUDIO = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.opus', '.webm']);
const MIME_MAP = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.opus': 'audio/opus', '.webm': 'audio/webm',
};

// Централизованный реестр временных директорий: чтобы при SIGINT/SIGTERM/exit
// мы могли вычистить ВСЕ активные tmp, а не только ту, которую "видит" конкретная
// функция. Без этого Ctrl-C во время скачивания из Drive оставлял многогигабайтные
// недокачанные файлы в /tmp.
const activeTmpDirs = new Set();
let signalsInstalled = false;

function cleanAllTmpDirs() {
  for (const d of activeTmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  activeTmpDirs.clear();
}

function installSignalHandlers() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  const onSignal = (code) => () => {
    const hadTmps = activeTmpDirs.size > 0;
    cleanAllTmpDirs();
    if (hadTmps) console.error(chalk.dim('\n  Прервано. Временные файлы удалены.'));
    process.exit(code);
  };
  process.on('SIGINT',  onSignal(130));
  process.on('SIGTERM', onSignal(143));
  // Safety net: если finally не отработал (uncaughtException, нестандартный выход)
  process.on('exit', cleanAllTmpDirs);
}

export function makeTmp() {
  const d = join(tmpdir(), `transcribe-${randomBytes(4).toString('hex')}`);
  mkdirSync(d, { recursive: true });
  activeTmpDirs.add(d);
  installSignalHandlers();
  return d;
}

export function cleanTmp(d) {
  activeTmpDirs.delete(d);
  try { rmSync(d, { recursive: true, force: true }); } catch {}
}

export function isUrl(s) { return /^https?:\/\//.test(s.trim()); }

export function sanitizeFilename(name) {
  let c = name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120);
  if (platform() === 'win32') {
    const reserved = new Set(['CON','PRN','AUX','NUL',...[...Array(10)].map((_,i)=>`COM${i}`),...[...Array(10)].map((_,i)=>`LPT${i}`)]);
    if (reserved.has(c.toUpperCase().split('.')[0])) c = `_${c}`;
  }
  return c || 'transcript';
}

function checkBin(name, hint) {
  try {
    execSync(`${platform() === 'win32' ? 'where' : 'which'} ${name}`, { stdio: 'pipe' });
    return true;
  } catch {
    console.log(chalk.red(`${name} не найден. ${hint}`));
    return false;
  }
}

// Окружение для subprocess — принудительный UTF-8 для yt-dlp (Python)
const SUBPROCESS_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

function getVideoTitle(url) {
  try {
    return execSync(`yt-dlp --get-title --no-playlist "${url}"`, {
      encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      env: SUBPROCESS_ENV,
    }).trim().slice(0, 200);
  } catch { return ''; }
}

function downloadAudio(url, tmp) {
  if (!checkBin('yt-dlp', 'pip install yt-dlp')) process.exit(1);
  const out = join(tmp, 'audio.%(ext)s');
  try {
    execSync(`yt-dlp -x --audio-format wav --audio-quality 0 -o "${out}" --no-playlist --concurrent-fragments 4 --quiet "${url}"`, {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 3600000,
      env: SUBPROCESS_ENV,
    });
  } catch (e) {
    const stderr = (e.stderr?.toString() || '').trim();
    if (e.killed || e.signal === 'SIGTERM') {
      throw new Error('Скачивание прервано: превышен таймаут (60 мин). Попробуйте скачать видео вручную через yt-dlp');
    }
    if (stderr.includes('is not a valid URL'))        throw new Error(`Невалидная ссылка: ${url}`);
    if (stderr.includes('Video unavailable'))          throw new Error('Видео недоступно (удалено, приватное или заблокировано в вашем регионе)');
    if (stderr.includes('Private video'))              throw new Error('Видео приватное — нет доступа');
    if (stderr.includes('Sign in to confirm'))         throw new Error('YouTube требует авторизацию для этого видео (возрастное ограничение или региональная блокировка)');
    if (stderr.includes('This live event will begin')) throw new Error('Стрим ещё не начался — дождитесь начала трансляции');
    if (stderr.includes('Premieres in'))               throw new Error('Это премьера — видео ещё не вышло');
    if (stderr.includes('HTTP Error 403'))             throw new Error('Доступ запрещён (403). Попробуйте обновить yt-dlp: pip install -U yt-dlp');
    if (stderr.includes('HTTP Error 429'))             throw new Error('Слишком много запросов (429). Подождите пару минут и попробуйте снова');
    if (stderr.includes('Unable to download'))         throw new Error(`Не удалось скачать: ${stderr.split('\n').pop()}`);
    if (stderr.includes('Unsupported URL'))            throw new Error(`Ссылка не поддерживается: ${url}`);
    throw new Error(`Ошибка скачивания: ${stderr || e.message}`);
  }
  const f = readdirSync(tmp).find(f => f.startsWith('audio'));
  if (!f) throw new Error('yt-dlp завершился без ошибок, но файл не создан. Попробуйте обновить yt-dlp: pip install -U yt-dlp');
  return join(tmp, f);
}

function convertToWav(input, tmp) {
  const hint = platform() === 'darwin' ? 'brew install ffmpeg' : 'choco install ffmpeg';
  if (!checkBin('ffmpeg', hint)) process.exit(1);
  const out = join(tmp, 'converted.wav');
  try {
    execSync(`ffmpeg -i "${input}" -vn -acodec pcm_s16le -ar 16000 -ac 1 -y -loglevel error "${out}"`, {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 20*60000,
    });
  } catch (e) {
    const stderr = (e.stderr?.toString() || '').trim();
    if (e.killed || e.signal === 'SIGTERM') {
      throw new Error('Конвертация прервана: превышен таймаут (20 мин). Файл слишком большой?');
    }
    if (stderr.includes('Invalid data found'))     throw new Error('Файл повреждён или формат не поддерживается ffmpeg');
    if (stderr.includes('No such file'))           throw new Error(`Файл не найден: ${input}`);
    if (stderr.includes('does not contain'))        throw new Error('В файле нет аудиодорожки');
    throw new Error(`Ошибка конвертации: ${stderr || e.message}`);
  }
  if (!existsSync(out)) throw new Error('ffmpeg завершился без ошибок, но WAV-файл не создан');
  return out;
}

async function callDeepgram(filePath, model, language, speakers, apiKey) {
  const ext = extname(filePath).toLowerCase();
  const body = readFileSync(filePath);
  const params = new URLSearchParams({
    model, language, smart_format: 'true', punctuate: 'true', paragraphs: 'true', utterances: 'true',
  });
  if (speakers) params.set('diarize', 'true');

  const resp = await fetch(`${DEEPGRAM_API}?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' },
    body,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err.err_msg || err.message || resp.statusText;
    if (resp.status === 401 || resp.status === 403) {
      const e = new Error(`Deepgram: неверный API-ключ или он деактивирован (${resp.status})`);
      e.isAuthError = true;
      throw e;
    }
    if (resp.status === 402) throw new Error('Deepgram: закончился баланс. Пополните на console.deepgram.com');
    if (resp.status === 413) throw new Error('Deepgram: файл слишком большой. Попробуйте обрезать аудио');
    if (resp.status === 429) throw new Error('Deepgram: слишком много запросов. Подождите минуту');
    if (resp.status >= 500) throw new Error(`Deepgram: сервер недоступен (${resp.status}). Попробуйте позже`);
    throw new Error(`Deepgram (${resp.status}): ${msg}`);
  }
  return resp.json();
}

export function formatTs(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h
    ? `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}

function formatMarkdown(data, speakers, title = '', speakerNames = {}) {
  const lines = [];
  if (title) lines.push(`# ${title}`, '');

  const dur = data?.metadata?.duration || 0;
  if (dur) {
    let s = Math.floor(dur);
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60); s %= 60;
    lines.push(`> Длительность: ${h ? h + ':' + String(m).padStart(2,'0') : m}:${String(s).padStart(2,'0')}`, '');
  }

  const results = data?.results || {};

  if (speakers && results.utterances) {
    for (const u of results.utterances) {
      const name = speakerNames[u.speaker] || `Speaker ${u.speaker ?? '?'}`;
      const ts = formatTs(u.start ?? 0);
      lines.push(`**${name}** [${ts}]`);
      lines.push(u.transcript || '', '');
    }
    return lines.join('\n');
  }

  const alt = results.channels?.[0]?.alternatives?.[0] || {};
  const paras = alt?.paragraphs?.paragraphs || [];
  if (paras.length) {
    for (const p of paras) {
      lines.push((p.sentences || []).map(s => s.text || '').join(' '), '');
    }
    return lines.join('\n');
  }
  lines.push(alt.transcript || '');
  return lines.join('\n');
}

/**
 * Извлекает уникальных спикеров и несколько реплик каждого с таймстампами.
 * Возвращает [{id, lines: [{text, start}]}]
 */
export function getSpeakerPreviews(data) {
  const utterances = data?.results?.utterances || [];
  const seen = new Map();
  for (const u of utterances) {
    const id = u.speaker;
    if (id != null) {
      if (!seen.has(id)) seen.set(id, []);
      const lines = seen.get(id);
      if (lines.length < 4) {
        lines.push({ text: (u.transcript || '').trim(), start: u.start ?? 0 });
      }
    }
  }
  return [...seen.entries()].map(([id, lines]) => ({ id, lines }));
}

export async function runTranscription(source, { speakers, lang, model = 'nova-3', apiKey, outputDir, onSpeakers }) {
  const tmp = makeTmp();
  // Сигналы SIGINT/SIGTERM обрабатываются глобально в makeTmp — он почистит tmp
  // через activeTmpDirs, так что локальный handler больше не нужен.

  let baseName = 'transcript', title = '';
  const spinner = ora({ text: chalk.cyan('Подготовка...'), spinner: 'dots' }).start();

  try {
    let audioPath;

    if (isUrl(source)) {
      spinner.text = chalk.cyan('Определяю название...');
      title = getVideoTitle(source);
      baseName = title ? sanitizeFilename(title) : 'transcript';
      spinner.text = chalk.cyan(`Скачиваю: ${title || source}...`);
      audioPath = downloadAudio(source, tmp);
      spinner.succeed('Скачано');
      spinner.start();
    } else {
      baseName = basename(source, extname(source));
      title = baseName;
      audioPath = source;
      spinner.succeed(`Файл: ${basename(source)}`);
      spinner.start();
    }

    if (!DIRECT_AUDIO.has(extname(audioPath).toLowerCase())) {
      spinner.text = chalk.cyan('Конвертирую аудио...');
      audioPath = convertToWav(audioPath, tmp);
      spinner.succeed('Сконвертировано');
      spinner.start();
    }

    const mb = (statSync(audioPath).size / 1048576).toFixed(1);
    spinner.text = chalk.cyan(`Транскрибирую (${mb} MB)...`);
    const raw = await callDeepgram(audioPath, model, lang, speakers, apiKey);
    spinner.succeed('Транскрибировано');

    // Переименование спикеров
    let speakerNames = {};
    if (speakers && onSpeakers) {
      const previews = getSpeakerPreviews(raw);
      if (previews.length > 1) {
        speakerNames = await onSpeakers(previews);
      }
    }

    // Сохранение
    mkdirSync(outputDir, { recursive: true });
    let outPath = join(outputDir, `${baseName}.md`);
    let c = 1;
    while (existsSync(outPath)) { outPath = join(outputDir, `${baseName}_${c++}.md`); }
    writeFileSync(outPath, formatMarkdown(raw, speakers, title, speakerNames), 'utf-8');

    // Итог
    const d = raw?.metadata?.duration;
    let durStr = '';
    if (d) { let s = Math.floor(d); const h = Math.floor(s/3600); s%=3600; const m = Math.floor(s/60); s%=60; durStr = h ? `${h}ч ${m}мин ${s}сек` : `${m}мин ${s}сек`; }
    const sz = statSync(outPath).size;

    const preview = readFileSync(outPath, 'utf-8').trim().split('\n');
    let prev = preview.slice(0, 5).join('\n');
    if (preview.length > 5) prev += chalk.dim(`\n... еще ${preview.length - 5} строк`);

    console.log();
    console.log(chalk.green('┌─ Готово ─────────────────────────────'));
    console.log(chalk.green('│') + ` Файл:         ${outPath}`);
    console.log(chalk.green('│') + ` Размер:       ${sz > 1024 ? (sz/1024).toFixed(1)+' KB' : sz+' B'}`);
    if (durStr) console.log(chalk.green('│') + ` Длительность: ${durStr}`);
    console.log(chalk.green('│') + ` Превью:`);
    for (const l of prev.split('\n')) console.log(chalk.green('│') + `   ${l}`);
    console.log(chalk.green('└──────────────────────────────────────'));
    console.log();
    return outPath;
  } catch (e) {
    spinner.fail(chalk.red(e.message));
    return null;
  } finally {
    cleanTmp(tmp);
  }
}