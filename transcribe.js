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

function makeTmp() {
  const d = join(tmpdir(), `transcribe-${randomBytes(4).toString('hex')}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function cleanTmp(d) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

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
  execSync(`yt-dlp -x --audio-format wav --audio-quality 0 -o "${out}" --no-playlist --quiet "${url}"`, {
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 600000,
    env: SUBPROCESS_ENV,
  });
  const f = readdirSync(tmp).find(f => f.startsWith('audio'));
  if (!f) throw new Error('Скачанный файл не найден');
  return join(tmp, f);
}

function convertToWav(input, tmp) {
  const hint = platform() === 'darwin' ? 'brew install ffmpeg' : 'choco install ffmpeg';
  if (!checkBin('ffmpeg', hint)) process.exit(1);
  const out = join(tmp, 'converted.wav');
  execSync(`ffmpeg -i "${input}" -vn -acodec pcm_s16le -ar 16000 -ac 1 -y -loglevel error "${out}"`, {
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 600000,
  });
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
    throw new Error(`Deepgram (${resp.status}): ${err.err_msg || err.message || resp.statusText}`);
  }
  return resp.json();
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
    let cur = null;
    for (const u of results.utterances) {
      if (u.speaker !== cur) {
        cur = u.speaker;
        const name = speakerNames[cur] || `Speaker ${cur ?? '?'}`;
        lines.push(`**${name}:**`);
      }
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
 * Извлекает уникальных спикеров и первую реплику каждого.
 * Возвращает [{id, firstLine}]
 */
export function getSpeakerPreviews(data) {
  const utterances = data?.results?.utterances || [];
  const seen = new Map();
  for (const u of utterances) {
    const id = u.speaker;
    if (id != null && !seen.has(id)) {
      const preview = (u.transcript || '').slice(0, 80);
      seen.set(id, preview + (u.transcript.length > 80 ? '...' : ''));
    }
  }
  return [...seen.entries()].map(([id, firstLine]) => ({ id, firstLine }));
}

export async function runTranscription(source, { speakers, lang, model = 'nova-3', apiKey, outputDir, onSpeakers }) {
  const tmp = makeTmp();
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
  } finally { cleanTmp(tmp); }
}