import { readFileSync } from 'fs';

// AssemblyAI — облачный провайдер: транскрипт + диаризация в одном вызове,
// с подсказкой числа спикеров (speakers_expected). Русский поддерживается.
// Возвращает utterances в формате Deepgram ({speaker, start(сек), end, transcript}),
// который понимает formatMarkdown/getSpeakerPreviews — остальной пайплайн не меняется.
const API = 'https://api.assemblyai.com/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function transcribeAssembly(audioPath, { apiKey, lang = 'ru', speakersExpected = 0, log = () => {} }) {
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

  // 3. Поллинг до готовности.
  let t;
  for (;;) {
    await sleep(3000);
    const r = await fetch(`${API}/transcript/${id}`, { headers: { authorization: apiKey } });
    t = await r.json();
    if (t.status === 'completed') break;
    if (t.status === 'error') throw new Error(`AssemblyAI: ${t.error || 'ошибка обработки'}`);
    log(`статус: ${t.status}…`);
  }

  // 4. Маппинг utterances: спикер A/B/C → 0/1/2, время мс → сек.
  const utterances = (t.utterances || []).map(u => ({
    speaker: typeof u.speaker === 'string' && /^[A-Z]$/.test(u.speaker) ? u.speaker.charCodeAt(0) - 65 : u.speaker,
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
