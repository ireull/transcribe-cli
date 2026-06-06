import { readFileSync } from 'fs';

// AssemblyAI — облачный провайдер: транскрипт + диаризация в одном вызове,
// с подсказкой числа спикеров (speakers_expected). Русский поддерживается.
// Возвращает utterances {speaker, start(сек), end, transcript}; speaker — буква
// A/B/C как её отдаёт AssemblyAI (метки «Speaker A/B/C»). formatMarkdown/
// getSpeakerPreviews/assembleMarkdown работают с любым типом метки.
const API = 'https://api.assemblyai.com/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Поллинг: жёсткий дедлайн на весь job + терпимость к транзиентным сбоям.
// Сколько НЕУДАЧНЫХ опросов подряд терпим, прежде чем сдаться (сеть/5xx/429).
const MAX_POLL_FAILURES = 5;

export async function transcribeAssembly(audioPath, {
  apiKey, lang = 'ru', speakersExpected = 0, log = () => {},
  pollIntervalMs = 3000,
  pollTimeoutMs = 60 * 60000, // дедлайн всего поллинга; иначе завис job = завис вызывающий
}) {
  if (!apiKey) throw new Error('Нет ключа AssemblyAI');

  // 1. Загрузка аудио (raw bytes) → upload_url.
  log('загрузка аудио…');
  const up = await fetch(`${API}/upload`, {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/octet-stream' },
    body: readFileSync(audioPath),
  });
  if (!up.ok) throw new Error(`AssemblyAI upload (${up.status}): ${(await up.text()).slice(0, 200)}`);
  const { upload_url } = await up.json();

  // 2. Запуск задачи: диаризация + (опц.) подсказка числа спикеров.
  log('распознавание + диаризация…');
  const submitBody = { audio_url: upload_url, speaker_labels: true, language_code: lang };
  if (speakersExpected > 0) submitBody.speakers_expected = speakersExpected;
  const sub = await fetch(`${API}/transcript`, {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(submitBody),
  });
  if (!sub.ok) throw new Error(`AssemblyAI submit (${sub.status}): ${(await sub.text()).slice(0, 200)}`);
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
      const r = await fetch(`${API}/transcript/${id}`, { headers: { authorization: apiKey } });
      if (!r.ok) {
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
          // Невосстановимо (401/403/404…): ретраи бессмысленны, падаем сразу.
          throw Object.assign(
            new Error(`AssemblyAI poll (${r.status}): ${(await r.text()).slice(0, 200)}`),
            { fatal: true }
          );
        }
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
  const utterances = (t.utterances || []).map(u => ({
    speaker: u.speaker,
    start: (u.start || 0) / 1000,
    end: (u.end || 0) / 1000,
    transcript: u.text || '',
  }));
  return {
    utterances,
    duration: t.audio_duration || (utterances.at(-1)?.end ?? 0),
    speakers: new Set(utterances.map(u => u.speaker)).size,
  };
}
