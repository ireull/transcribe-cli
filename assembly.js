import { createReadStream, statSync } from 'fs';
import { fetchWithTimeout, isRetriableStatus, sleep, withRetry } from './http.js';

// AssemblyAI — облачный провайдер: транскрипт + диаризация в одном вызове,
// с подсказкой числа спикеров (speakers_expected). Язык задаётся явно или
// определяется AssemblyAI автоматически.
// Возвращает utterances {speaker, start(сек), end, transcript}; speaker — буква
// A/B/C как её отдаёт AssemblyAI (метки «Speaker A/B/C»). formatMarkdown/
// getSpeakerPreviews/assembleMarkdown работают с любым типом метки.
const API = 'https://api.assemblyai.com/v2';
const UPLOAD_TIMEOUT_MS = 30 * 60000;
const SUBMIT_TIMEOUT_MS = 60000;
const POLL_FETCH_TIMEOUT_MS = 30000;

// Поллинг: жёсткий дедлайн на весь job + терпимость к транзиентным сбоям.
// Сколько НЕУДАЧНЫХ опросов подряд терпим, прежде чем сдаться (сеть/5xx/429).
const MAX_POLL_FAILURES = 5;

function assemblyAuthError(stage, status, detail = '') {
  const e = new Error(`AssemblyAI ${stage}: неверный API-ключ или он деактивирован (${status})${detail ? `: ${detail}` : ''}`);
  e.isAuthError = true;
  e.provider = 'assembly';
  return e;
}

// Диаризация иногда схлопывается: на длинной записи AssemblyAI отдаёт одного
// спикера и одну-две utterance на весь файл — навигации по такому транскрипту
// нет. Признак: спикер один И реплики реже одной на COLLAPSE_DENSITY_S, на
// записи от COLLAPSE_MIN_DURATION_S. Спикер один, поэтому переход на абзацы
// ничего не различает хуже — только добавляет таймстампы.
// Оба порога обязаны быть binding: 60 с даёт минимум один таймстамп в минуту,
// 120 с отсекает короткие клипы, где одна реплика на весь файл — норма.
const COLLAPSE_MIN_DURATION_S = 120;
const COLLAPSE_DENSITY_S = 60;

// Доля текста, ниже которой абзацы считаются неполным ответом и отбрасываются:
// оплаченный транскрипт нельзя подменить усечённой версией самого себя.
const COVERAGE_MIN_RATIO = 0.9;

export function isDiarizationCollapsed(utterances, duration) {
  if (!Array.isArray(utterances) || utterances.length === 0) return false;
  if (!(duration >= COLLAPSE_MIN_DURATION_S)) return false;
  const speakers = new Set(utterances.map(u => u.speaker));
  return speakers.size <= 1 && utterances.length < duration / COLLAPSE_DENSITY_S;
}

const textLength = (arr) => arr.reduce((n, u) => n + (u.transcript || '').length, 0);

// Абзацы уже посчитанного job'а — отдельный ресурс того же транскрипта, повторно
// НЕ биллится. Нужны только как фоллбэк, поэтому вызывающий гасит сетевые ошибки:
// транскрипт уже получен, терять его из-за абзацев нельзя.
async function fetchParagraphs(id, {
  apiKey,
  timeoutMs = POLL_FETCH_TIMEOUT_MS,
  retryAttempts = 3,
  retryBaseMs = 1000,
} = {}) {
  const r = await withRetry(
    () => fetchWithTimeout(
      `${API}/transcript/${id}/paragraphs`,
      { headers: { authorization: apiKey } },
      { timeoutMs, service: 'AssemblyAI paragraphs' }
    ),
    { attempts: retryAttempts, baseMs: retryBaseMs }
  );
  if (!r.ok) {
    // Тело читаем всегда: недоеденный body undici держит сокет до GC.
    const detail = (await r.text().catch(() => '')).slice(0, 200);
    throw new Error(`AssemblyAI paragraphs (${r.status})${detail ? `: ${detail}` : ''}`);
  }
  const { paragraphs = [] } = await r.json();
  return paragraphs;
}

export async function uploadAssembly(audioPath, {
  apiKey,
  log = () => {},
  uploadTimeoutMs = UPLOAD_TIMEOUT_MS,
  retryAttempts = 3,
  retryBaseMs = 1000,
} = {}) {
  if (!apiKey) throw new Error('Нет ключа AssemblyAI');

  log('загрузка аудио…');
  const size = statSync(audioPath).size;
  const up = await withRetry(
    () => fetchWithTimeout(`${API}/upload`, {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'content-type': 'application/octet-stream',
        'content-length': String(size),
      },
      body: createReadStream(audioPath),
      duplex: 'half',
    }, { timeoutMs: uploadTimeoutMs, service: 'AssemblyAI upload' }),
    { attempts: retryAttempts, baseMs: retryBaseMs }
  );
  if (!up.ok) {
    const detail = (await up.text()).slice(0, 200);
    if (up.status === 401 || up.status === 403) throw assemblyAuthError('upload', up.status, detail);
    throw new Error(`AssemblyAI upload (${up.status}): ${detail}`);
  }
  const { upload_url } = await up.json();
  return upload_url;
}

export async function transcribeAssembly(audioPath, {
  apiKey, lang = 'ru', detectLanguage = false, speakersExpected = 0, log = () => {},
  pollIntervalMs = 3000,
  pollTimeoutMs = 60 * 60000, // дедлайн всего поллинга; иначе завис job = завис вызывающий
  uploadTimeoutMs = UPLOAD_TIMEOUT_MS,
  submitTimeoutMs = SUBMIT_TIMEOUT_MS,
  pollFetchTimeoutMs = POLL_FETCH_TIMEOUT_MS,
  retryAttempts = 3,
  retryBaseMs = 1000,
  uploadUrl = '',
}) {
  if (!apiKey) throw new Error('Нет ключа AssemblyAI');

  // 1. Загрузка аудио (raw bytes) → upload_url.
  const upload_url = uploadUrl || await uploadAssembly(audioPath, {
    apiKey,
    log,
    uploadTimeoutMs,
    retryAttempts,
    retryBaseMs,
  });

  // 2. Запуск задачи: диаризация + (опц.) подсказка числа спикеров.
  log('распознавание + диаризация…');
  const submitBody = { audio_url: upload_url, speaker_labels: true };
  if (detectLanguage) submitBody.language_detection = true; // авто-язык; language_code НЕ слать
  else submitBody.language_code = lang; // ручной язык
  if (speakersExpected > 0) submitBody.speakers_expected = speakersExpected;
  const sub = await withRetry(
    () => fetchWithTimeout(`${API}/transcript`, {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(submitBody),
    }, { timeoutMs: submitTimeoutMs, service: 'AssemblyAI submit' }),
    // Submit is not idempotent: if AssemblyAI accepted the request but returned
    // 408/429/5xx, retrying can create a second billable job. Retry only throws
    // where fetch did not produce a server response.
    { attempts: retryAttempts, baseMs: retryBaseMs, retryStatuses: false }
  );
  if (!sub.ok) {
    const detail = (await sub.text()).slice(0, 200);
    if (sub.status === 401 || sub.status === 403) throw assemblyAuthError('submit', sub.status, detail);
    throw new Error(`AssemblyAI submit (${sub.status}): ${detail}`);
  }
  const { id } = await sub.json();

  // 3. Поллинг до готовности — с дедлайном и устойчивостью к транзиентным сбоям.
  // Job уже отправлен и БИЛЛИТСЯ: бросить его из-за одного сетевого чиха нельзя —
  // ретрай вызывающего перезальёт аудио и пересабмитит job (двойной счёт). Поэтому
  // сетевые ошибки и 5xx/408/429 ретраим с бэкоффом; жёстко падаем только по
  // дедлайну, по t.status === 'error' или по невосстановимому 4xx (ключ/джоб протух).
  const deadline = Date.now() + pollTimeoutMs;
  let failures = 0; // неудачные опросы ПОДРЯД; сбрасывается успешным ответом
  let t;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`AssemblyAI: job ${id} не завершился за ${Math.round(pollTimeoutMs / 60000)} мин — прекращаю поллинг`);
    }
    await sleep(Math.min(pollIntervalMs * 2 ** failures, 60000)); // сбои → реже опрос
    try {
      const r = await fetchWithTimeout(
        `${API}/transcript/${id}`,
        { headers: { authorization: apiKey } },
        { timeoutMs: pollFetchTimeoutMs, service: 'AssemblyAI poll' }
      );
      if (!r.ok) {
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
          const detail = (await r.text()).slice(0, 200);
          if (r.status === 401 || r.status === 403) {
            throw Object.assign(assemblyAuthError('poll', r.status, detail), { fatal: true });
          }
          // Невосстановимо (401/403/404…): ретраи бессмысленны, падаем сразу.
          throw Object.assign(
            new Error(`AssemblyAI poll (${r.status}): ${detail}`),
            { fatal: true }
          );
        }
        if (isRetriableStatus(r.status)) await r.text().catch(() => {});
        throw new Error(`AssemblyAI poll (${r.status})`); // 5xx/408/429 — транзиентно
      }
      t = await r.json();
      failures = 0;
    } catch (e) {
      if (e.fatal) throw e;
      failures++;
      if (failures > MAX_POLL_FAILURES) {
        throw new Error(`AssemblyAI: поллинг job ${id} не восстановился после ${failures} сбоев подряд: ${e.message}`);
      }
      log(`сбой поллинга (${failures}/${MAX_POLL_FAILURES}): ${e.message} — повторю…`);
      continue;
    }
    if (t.status === 'completed') break;
    if (t.status === 'error') throw new Error(`AssemblyAI: ${t.error || 'ошибка обработки'}`);
    log(`статус: ${t.status}…`);
  }

  // 4. Маппинг utterances: метку спикера (A/B/C) СОХРАНЯЕМ как есть, время мс → сек.
  //    Именование — не дело движка: «Speaker A/B/C» переименовывают позже (Telegram/CLI).
  let utterances = (t.utterances || []).map(u => ({
    speaker: u.speaker,
    start: (u.start || 0) / 1000,
    end: (u.end || 0) / 1000,
    transcript: u.text || '',
  }));
  const duration = t.audio_duration || (utterances.at(-1)?.end ?? 0);

  // 5. Диаризация схлопнулась — режем по абзацам того же job'а (см. isDiarizationCollapsed).
  let diarizationFallback = false;
  if (isDiarizationCollapsed(utterances, duration)) {
    log('диаризация не разделила реплики — беру абзацы');
    try {
      const paragraphs = await fetchParagraphs(id, {
        apiKey, timeoutMs: pollFetchTimeoutMs, retryAttempts, retryBaseMs,
      });
      const byParagraph = paragraphs.map(p => ({
        speaker: utterances[0]?.speaker ?? 'A',
        start: (p.start || 0) / 1000,
        end: (p.end || 0) / 1000,
        transcript: (p.text || '').trim(),
      })).filter(u => u.transcript);
      // Абзацы должны и дробить мельче, и покрывать тот же текст: частичный
      // ответ прошёл бы первую проверку и молча срезал часть оплаченного
      // транскрипта.
      const covered = textLength(byParagraph) >= textLength(utterances) * COVERAGE_MIN_RATIO;
      if (byParagraph.length > utterances.length && covered) {
        utterances = byParagraph;
        diarizationFallback = true;
        log(`абзацев: ${utterances.length}`);
      } else if (!covered) {
        log(`абзацы покрывают лишь часть текста (${textLength(byParagraph)} из ${textLength(utterances)}) — оставляю реплики как есть`);
      }
    } catch (e) {
      // Сетевые сбои и ответы не-2xx гасим: транскрипт уже есть и уже оплачен.
      // Ошибка в самом коде фоллбэка — не то же самое, её надо видеть.
      if (!/AssemblyAI paragraphs|истёк таймаут/.test(e.message || '')) {
        log(`ошибка в фоллбэке на абзацы: ${e.stack || e.message}`);
      } else {
        log(`абзацы недоступны (${e.message}) — оставляю реплики как есть`);
      }
    }
  }

  return {
    utterances,
    duration,
    speakers: new Set(utterances.map(u => u.speaker)).size,
    diarizationFallback,
  };
}
