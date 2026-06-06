// ─────────────────────────────────────────────────────────────────────────
// engine.js — единое НЕинтерактивное ядро транскрипции.
//
// Один движок, две оболочки:
//   • CLI (app.js → transcribe.js) оборачивает ядро спиннером/меню/именованием;
//   • сервис transcriber вызывает ядро напрямую (вендорится в transcriber/vendor/).
//
// КОНТРАКТ ЯДРА (жёсткий):
//   • НИКАКОГО ввода: ни prompt, ни readline, ни чтения process.stdin, ни TUI.
//   • НИКАКОГО process.exit — только throw Error (решает вызывающий).
//   • НИКАКОГО именования спикеров: ядро отдаёт «Speaker A/B/C» как есть.
//     Переименование происходит позже (в CLI или через Telegram).
//   • Зависимости только от стандартной библиотеки Node + global fetch + ./assembly.js.
//     Ни chalk, ни ora, ни @inquirer — чтобы модуль вендорился копированием.
//
// Если какой-либо путь в этом файле ждёт ввода — это БАГ.
// ─────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join, extname, dirname } from 'path';
import { transcribeAssembly } from './assembly.js';

// Форматы, которые AssemblyAI/ffmpeg-апстрим принимают как аудио напрямую —
// для них конвертация в opus не нужна.
export const DIRECT_AUDIO = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.opus', '.webm']);

export const MIME_MAP = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.opus': 'audio/opus', '.webm': 'audio/webm',
};

// ─── Утилиты времени/кодирования ────────────────────────────────────────

export function formatTs(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// Аудио-аргументы ffmpeg для opus.
//  - обычный режим: 32 kbps mono voip — для распознавания СЛОВ хватает с запасом.
//  - hq (диаризация): 128 kbps + сохраняем каналы (не mono). Диаризация строит
//    голосовые эмбеддинги по тонким спектральным признакам; на 32k mono тихих/
//    редко говорящих спикеров она сливает. 128k — компактный потолок из ресёрча.
export function opusEncodeArgs(hq) {
  return hq
    ? '-c:a libopus -b:a 128k -ar 16000 -application audio'
    : '-c:a libopus -b:a 32k -ar 16000 -ac 1 -application voip';
}

// Проверка наличия бинарника. В ОТЛИЧИЕ от CLI — бросает Error, не зовёт process.exit.
function ensureBin(name) {
  try {
    execFileSync(platform() === 'win32' ? 'where' : 'which', [name], { stdio: 'pipe' });
  } catch {
    throw new Error(`${name} не найден в PATH (нужен для конвертации аудио)`);
  }
}

// Конвертация в opus. Бросает Error при любой проблеме — НЕ process.exit, НЕ chalk.
// execFileSync с argv (не shell-строкой): путь — реальный, инъекции `$(...)` нет.
export function convertToOpus(input, outDir, { hq = false } = {}) {
  ensureBin('ffmpeg');
  const out = join(outDir, 'converted.opus');
  try {
    execFileSync(
      'ffmpeg',
      ['-i', input, '-vn', ...opusEncodeArgs(hq).split(' '), '-y', '-loglevel', 'error', out],
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 20 * 60000 }
    );
  } catch (e) {
    const stderr = (e.stderr?.toString() || '').trim();
    if (e.killed || e.signal === 'SIGTERM') {
      throw new Error('Конвертация прервана: превышен таймаут (20 мин). Файл слишком большой?');
    }
    if (stderr.includes('Unknown encoder') && stderr.includes('libopus')) {
      throw new Error('ffmpeg собран без libopus — переустановите ffmpeg с поддержкой libopus');
    }
    if (stderr.includes('Invalid data found')) throw new Error('Файл повреждён или формат не поддерживается ffmpeg');
    if (stderr.includes('No such file')) throw new Error(`Файл не найден: ${input}`);
    if (stderr.includes('does not contain')) throw new Error('В файле нет аудиодорожки');
    throw new Error(`Ошибка конвертации: ${stderr || e.message}`);
  }
  if (!existsSync(out)) throw new Error('ffmpeg завершился без ошибок, но opus-файл не создан');
  return out;
}

// ─── Сборка Markdown ─────────────────────────────────────────────────────

/**
 * Собирает Markdown-транскрипт из реплик с диаризацией.
 * Метка спикера по умолчанию — «Speaker <label>» (для AssemblyAI это буквы A/B/C).
 * speakerNames (опц.) перебивает метку: {A:'Иван'} → «**Иван**». По умолчанию пусто —
 * ядро НИКОГО не переименовывает; имена приходят позже (CLI/Telegram).
 *
 * @param {{utterances:Array<{speaker:any,start:number,transcript:string}>,
 *          duration?:number, title?:string, speakerNames?:object,
 *          merge?:boolean, summary?:string}} arg
 * @returns {string}
 */
export function assembleMarkdown({ utterances = [], duration = 0, title = '', speakerNames = {}, merge = true, summary = '' } = {}) {
  const lines = [];
  if (title) lines.push(`# ${title}`, '');

  if (duration) {
    let s = Math.floor(duration);
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60); s %= 60;
    lines.push(`> Длительность: ${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`, '');
  }

  if (summary) lines.push('## Краткое содержание', '', summary.trim(), '');

  let i = 0;
  while (i < utterances.length) {
    const spk = utterances[i].speaker;
    const name = speakerNames[spk] || `Speaker ${spk ?? '?'}`;
    const ts = formatTs(utterances[i].start ?? 0);
    lines.push(`**${name}** [${ts}]`);
    if (merge) {
      // Склеиваем подряд идущие реплики одного спикера в один блок:
      // чище читать и меньше токенов при последующей обработке LLM.
      const parts = [];
      while (i < utterances.length && utterances[i].speaker === spk) {
        parts.push((utterances[i].transcript || '').trim());
        i++;
      }
      lines.push(parts.join(' ').trim(), '');
    } else {
      lines.push(utterances[i].transcript || '', '');
      i++;
    }
  }
  return lines.join('\n');
}

// ─── Транскрипция ──────────────────────────────────────────────────────────

/**
 * Низкоуровневый шаг: файл → реплики с диаризацией (AssemblyAI).
 * Конвертирует в opus при необходимости, заливает, диаризует, опрашивает статус.
 * Возвращает реплики с метками спикеров A/B/C. НЕ пишет файлов, НЕ форматирует Markdown.
 *
 * @returns {Promise<{utterances:Array, duration:number, speakers:number}>}
 */
export async function transcribeToUtterances({
  input,
  lang = 'ru',
  diarization = true,
  speakersExpected = 0,
  apiKey = process.env.ASSEMBLYAI_API_KEY,
  pollIntervalMs,
  pollTimeoutMs,
  log = () => {},
} = {}) {
  if (!input) throw new Error('engine: не указан input (путь к медиафайлу)');
  if (!existsSync(input)) throw new Error(`engine: файл не найден: ${input}`);
  if (!apiKey) throw new Error('engine: нужен ключ AssemblyAI (apiKey или ASSEMBLYAI_API_KEY)');

  // Свой временный каталог под конвертацию; чистим в finally. Глобальные
  // обработчики сигналов НЕ ставим — библиотека не должна звать process.exit
  // и перехватывать сигналы за хост-процесс (это решает вызывающий сервис).
  const tmp = mkdtempSync(join(tmpdir(), 'tx-engine-'));
  try {
    let audioPath = input;
    if (!DIRECT_AUDIO.has(extname(audioPath).toLowerCase())) {
      log('конвертация в opus');
      audioPath = convertToOpus(audioPath, tmp, { hq: diarization });
    }
    log('загрузка + диаризация');
    const result = await transcribeAssembly(audioPath, {
      apiKey,
      lang,
      speakersExpected,
      // Поллинг-ручки пробрасываем только если заданы — дефолты живут в assembly.js.
      ...(pollIntervalMs != null ? { pollIntervalMs } : {}),
      ...(pollTimeoutMs != null ? { pollTimeoutMs } : {}),
      log,
    });
    return { utterances: result.utterances, duration: result.duration, speakers: result.speakers };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Высокоуровневый вход для сервиса: медиафайл → Russian Markdown с диаризацией.
 * Чистая сигнатура: input (путь), опции, outputPath (путь). Без TUI/prompt/stdin.
 *
 * @param {{input:string, outputPath?:string, lang?:string, diarization?:boolean,
 *          speakersExpected?:number, apiKey?:string, title?:string, merge?:boolean,
 *          pollIntervalMs?:number, pollTimeoutMs?:number, log?:(m:string)=>void}} arg
 * @returns {Promise<{outputPath:string, markdown:string, speakers:number,
 *                    duration:number, utterances:Array}>}
 */
export async function transcribeFile({
  input,
  outputPath = '',
  lang = 'ru',
  diarization = true,
  speakersExpected = 0,
  apiKey = process.env.ASSEMBLYAI_API_KEY,
  title = '',
  merge = true,
  pollIntervalMs,
  pollTimeoutMs,
  log = () => {},
} = {}) {
  const { utterances, duration, speakers } = await transcribeToUtterances({
    input, lang, diarization, speakersExpected, apiKey, pollIntervalMs, pollTimeoutMs, log,
  });
  const markdown = assembleMarkdown({ utterances, duration, title, merge });
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, markdown, 'utf-8');
  }
  return { outputPath: outputPath || '', markdown, speakers, duration, utterances };
}
