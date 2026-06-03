import chalk from 'chalk';

// Саммари через Google Gemini (free-tier). Русский саммаризирует отлично,
// в отличие от Deepgram (там audio-intelligence только англ.). Ключ — бесплатно
// на https://aistudio.google.com/app/apikey (карта не нужна).
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';

// Транскрипт длинной встречи влезает в контекст Gemini Flash (1M токенов),
// но совсем гигантское режем — саммари не нужен весь текст дословно.
const MAX_CHARS = 200_000;

const SYSTEM = 'Ты ассистент, который кратко излагает транскрипты рабочих встреч. ' +
  'Отвечай на том же языке, что и транскрипт (обычно русский). ' +
  'Верни СТРОГО JSON: {"title": "...", "summary": "..."}. ' +
  'title — короткое название встречи для имени файла (3–7 слов, без даты, без кавычек). ' +
  'summary — 2–4 предложения о сути встречи и решениях.';

/**
 * Парсит ответ модели в { title, paragraph }. Gemini с responseMimeType=json
 * обычно отдаёт чистый JSON, но оставляем фолбэк на всякий случай.
 */
export function parseSummary(text) {
  const raw = (text || '').trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const title = String(obj.title || '').trim();
      const paragraph = String(obj.summary || obj.paragraph || '').trim();
      if (title || paragraph) return { title, paragraph };
    } catch { /* фолбэк ниже */ }
  }
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  return { title: (lines[0] || '').slice(0, 80), paragraph: lines.slice(1).join(' ') || raw };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Резюмирует транскрипт через Gemini. Возвращает { title, paragraph }.
 * Бросает Error при неудаче — вызывающий решает (в CLI: предупреждение и
 * сохранение без саммари). Ретраит только 429 (rate-limit) с бэкоффом.
 */
export async function summarizeTranscript(text, { apiKey, model, retryDelays = [0, 2000, 5000] }) {
  if (!apiKey) throw new Error('Нет ключа Gemini');
  const transcript = (text || '').slice(0, MAX_CHARS);
  if (transcript.replace(/\s/g, '').length < 30) {
    throw new Error('Слишком короткий транскрипт для саммари');
  }

  const m = model || 'gemini-3.5-flash';
  const url = `${GEMINI_API}/${m}:generateContent`;
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ parts: [{ text: `Транскрипт встречи:\n\n${transcript}` }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
  });

  let lastErr;
  for (const delay of retryDelays) {
    if (delay) await sleep(delay);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body,
      });
    } catch (e) {
      lastErr = new Error(`Сеть упала при запросе к Gemini: ${e.cause?.code || e.message}`);
      continue;
    }
    if (resp.status === 429) { lastErr = new Error('Gemini: лимит запросов (429)'); continue; }
    if (resp.status === 401 || resp.status === 403) throw new Error(`Gemini: неверный ключ (${resp.status})`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Gemini (${resp.status}): ${err?.error?.message || resp.statusText}`);
    }
    const data = await resp.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) {
      const fr = data?.candidates?.[0]?.finishReason;
      throw new Error(`Gemini вернул пустой ответ${fr ? ` (${fr})` : ''}`);
    }
    return parseSummary(content);
  }
  throw lastErr || new Error('Gemini недоступен');
}
