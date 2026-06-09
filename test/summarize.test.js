import { test } from 'node:test';
import assert from 'node:assert';
import { parseSummary, summarizeTranscript } from '../summarize.js';

// ─── parseSummary ────────────────────────────────────────────────────

test('parseSummary: чистый JSON', () => {
  const r = parseSummary('{"title":"Планерка","summary":"Обсудили релиз."}');
  assert.equal(r.title, 'Планерка');
  assert.equal(r.paragraph, 'Обсудили релиз.');
});

test('parseSummary: JSON в markdown-блоке', () => {
  const r = parseSummary('```json\n{"title":"Стратсессия","summary":"Цели."}\n```');
  assert.equal(r.title, 'Стратсессия');
  assert.equal(r.paragraph, 'Цели.');
});

test('parseSummary: JSON с болтовнёй вокруг', () => {
  const r = parseSummary('Конечно!\n{"title":"Дейли","summary":"Статусы."}\nГотово.');
  assert.equal(r.title, 'Дейли');
});

test('parseSummary: не-JSON → фолбэк (первая строка = title)', () => {
  const r = parseSummary('Обсуждение бюджета\nРешили урезать на 10%.');
  assert.equal(r.title, 'Обсуждение бюджета');
  assert.equal(r.paragraph, 'Решили урезать на 10%.');
});

// ─── summarizeTranscript: guards (без сети) ──────────────────────────

test('summarizeTranscript: нет ключа → бросает', async () => {
  await assert.rejects(() => summarizeTranscript('текст '.repeat(50), { apiKey: '' }), /ключа/i);
});

test('summarizeTranscript: слишком короткий текст → бросает', async () => {
  await assert.rejects(() => summarizeTranscript('ок', { apiKey: 'k' }), /короткий/i);
});

// ─── summarizeTranscript: мок fetch ──────────────────────────────────

const LONG = 'разговор про релиз '.repeat(20);
const okResp = (content) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: content }] } }] }) });

test('summarizeTranscript: успешный ответ', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => okResp('{"title":"Релиз 1.8","summary":"Договорились о QA."}');
  try {
    const r = await summarizeTranscript(LONG, { apiKey: 'k', model: 'm' });
    assert.equal(r.title, 'Релиз 1.8');
    assert.match(r.paragraph, /QA/);
  } finally { globalThis.fetch = orig; }
});

test('summarizeTranscript: 429 → ретрай → успех', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
    return okResp('{"title":"T","summary":"S"}');
  };
  try {
    const r = await summarizeTranscript(LONG, { apiKey: 'k', retryDelays: [0, 0, 0] });
    assert.equal(r.title, 'T');
    assert.ok(calls >= 2, 'должен был повторить после 429');
  } finally { globalThis.fetch = orig; }
});

test('summarizeTranscript: 401 → бросает без ретраев', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 401, json: async () => ({}) }; };
  try {
    await assert.rejects(() => summarizeTranscript(LONG, { apiKey: 'bad' }), /401/);
    assert.equal(calls, 1, '401 не ретраим');
  } finally { globalThis.fetch = orig; }
});

test('summarizeTranscript: сетевая ошибка → бросает', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('fail'), { cause: { code: 'ENOTFOUND' } }); };
  try {
    await assert.rejects(() => summarizeTranscript(LONG, { apiKey: 'k', retryDelays: [0, 0, 0] }), /Gemini|сеть/i);
  } finally { globalThis.fetch = orig; }
});

test('summarizeTranscript: AbortError → понятный timeout', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  try {
    await assert.rejects(
      () => summarizeTranscript(LONG, { apiKey: 'k', retryDelays: [0, 0, 0] }),
      /таймаут запроса к Gemini/
    );
  } finally { globalThis.fetch = orig; }
});
