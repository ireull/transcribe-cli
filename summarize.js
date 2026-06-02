import chalk from 'chalk';

// OpenRouter — OpenAI-совместимый chat completions. Только Authorization +
// Content-Type обязательны (HTTP-Referer/X-Title опциональны, для CLI не нужны).
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';

// Транскрипт длинной встречи влезает в контекст бесплатных Qwen (131K+ токенов),
// но на всякий случай режем совсем уж гигантское — саммари не нужен весь текст
// дословно, а так не упрёмся в лимиты провайдера.
const MAX_CHARS = 200_000;

const SYSTEM = 'Ты ассистент, который кратко излагает транскрипты рабочих встреч. ' +
  'Отвечай на том же языке, что и транскрипт (обычно русский). ' +
  'Возвращай СТРОГО JSON без markdown-обёртки: ' +
  '{"title": "...", "summary": "..."}. ' +
  'title — короткое название встречи для имени файла (3–7 слов, без даты, без кавычек). ' +
  'summary — 2–4 предложения о сути встречи и решениях.';

/**
 * Парсит ответ модели в { title, paragraph }.
 * Модель может вернуть JSON в ```-блоке или с мусором вокруг — достаём
 * первый {...}. Фолбэк: первая строка = title, остальное = paragraph.
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
    } catch { /* падаем во фолбэк */ }
  }
  // Фолбэк: первая непустая строка — заголовок, остальное — абзац.
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  return { title: (lines[0] || '').slice(0, 80), paragraph: lines.slice(1).join(' ') || raw };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Резюмирует транскрипт через OpenRouter.
 * Возвращает { title, paragraph }. Бросает Error при неудаче — вызывающий
 * сам решает, что делать (в нашем CLI — предупреждение и сохранение без саммари).
 *
 * Ретраим только 429 (рейт-лимит апстрим-провайдера у free-моделей) с бэкоффом.
 */
export async function summarizeTranscript(text, { apiKey, model, retryDelays = [0, 2000, 5000] }) {
  if (!apiKey) throw new Error('Нет ключа OpenRouter');
  const transcript = (text || '').slice(0, MAX_CHARS);
  if (transcript.replace(/\s/g, '').length < 30) {
    throw new Error('Слишком короткий транскрипт для саммари');
  }

  const body = JSON.stringify({
    model: model || 'qwen/qwen3-8b:free',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Транскрипт встречи:\n\n${transcript}` },
    ],
  });

  let lastErr;
  for (const delay of retryDelays) { // 1 попытка + ретраи на 429/сеть
    if (delay) await sleep(delay);
    let resp;
    try {
      resp = await fetch(OPENROUTER_API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
      });
    } catch (e) {
      lastErr = new Error(`Сеть упала при запросе к OpenRouter: ${e.cause?.code || e.message}`);
      continue;
    }
    if (resp.status === 429) { lastErr = new Error('OpenRouter: лимит запросов (429)'); continue; }
    if (resp.status === 401) throw new Error('OpenRouter: неверный ключ (401)');
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`OpenRouter (${resp.status}): ${err?.error?.message || resp.statusText}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenRouter вернул пустой ответ');
    return parseSummary(content);
  }
  throw lastErr || new Error('OpenRouter недоступен');
}
