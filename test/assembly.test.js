import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { transcribeAssembly, uploadAssembly, isDiarizationCollapsed } from '../assembly.js';
import { transcribeToUtterances } from '../engine.js';

// Поллинг AssemblyAI: дедлайн, r.ok, ретраи транзиентных сбоев БЕЗ пересабмита
// job (job биллится — перезаливка = двойной счёт). Всё на фейковом fetch.

const realFetch = globalThis.fetch;
let dir, audio;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'assembly-test-'));
  audio = join(dir, 'a.opus');
  writeFileSync(audio, 'fake-audio-bytes');
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

async function drainBody(body) {
  if (!body?.[Symbol.asyncIterator]) return;
  for await (const _ of body) {}
}

// Фейковый API: счётчики вызовов + настраиваемая последовательность ответов поллинга.
// pollScript — массив функций () => Promise<response> | throw; исчерпался → completed.
function fakeApi(script = {}) {
  const pollScript = Array.isArray(script) ? script : (script.pollScript || []);
  const uploadScript = Array.isArray(script) ? [] : (script.uploadScript || []);
  const submitScript = Array.isArray(script) ? [] : (script.submitScript || []);
  const uploadUrl = Array.isArray(script) ? 'https://u' : (script.uploadUrl || 'https://u');
  const paragraphsScript = Array.isArray(script) ? [] : (script.paragraphsScript || []);
  const calls = { upload: 0, submit: 0, poll: 0, paragraphs: 0, submitBody: null, submitBodies: [] };
  globalThis.fetch = async (url, opts = {}) => {
    if (url.endsWith('/upload')) {
      calls.upload++;
      assert.equal(opts.duplex, 'half');
      assert.equal(opts.headers['content-length'], '16');
      assert.equal(typeof opts.body?.pipe, 'function');
      await drainBody(opts.body);
      const step = uploadScript.shift();
      if (step) return step(opts);
      return res(200, { upload_url: uploadUrl });
    }
    if (url.endsWith('/transcript') && opts.method === 'POST') {
      calls.submit++;
      calls.submitBody = JSON.parse(opts.body);
      calls.submitBodies.push(calls.submitBody);
      const step = submitScript.shift();
      if (step) return step(opts);
      return res(200, { id: `job${calls.submit}` });
    }
    if (url.endsWith('/paragraphs')) {
      calls.paragraphs++;
      const step = paragraphsScript.shift();
      if (step) return step();
      return res(200, { paragraphs: [] });
    }
    calls.poll++;
    const step = pollScript.shift();
    if (step) return step();
    return res(200, {
      status: 'completed',
      audio_duration: 10,
      utterances: [
        { speaker: 'A', start: 0, end: 2000, text: 'привет' },
        { speaker: 'B', start: 2000, end: 4000, text: 'здравствуйте' },
      ],
    });
  };
  return calls;
}

const OPTS = { apiKey: 'k', pollIntervalMs: 1, pollTimeoutMs: 5000 };

test('happy path: буквы A/B сохраняются, мс → сек, ровно 1 upload + 1 submit', async () => {
  const calls = fakeApi([() => res(200, { status: 'processing' })]);
  const r = await transcribeAssembly(audio, OPTS);
  assert.deepEqual(r.utterances.map(u => u.speaker), ['A', 'B']);
  assert.equal(r.utterances[0].end, 2); // 2000 мс → 2 сек
  assert.equal(r.speakers, 2);
  assert.equal(calls.upload, 1);
  assert.equal(calls.submit, 1);
});

test('detectLanguage=true отправляет language_detection без language_code', async () => {
  const calls = fakeApi();
  await transcribeAssembly(audio, { ...OPTS, detectLanguage: true, lang: 'ru' });
  assert.equal(calls.submitBody.language_detection, true);
  assert.ok(!('language_code' in calls.submitBody));
  assert.equal(calls.submitBody.speaker_labels, true);
});

test('detectLanguage=false отправляет явный language_code без language_detection', async () => {
  const calls = fakeApi();
  await transcribeAssembly(audio, { ...OPTS, detectLanguage: false, lang: 'en' });
  assert.equal(calls.submitBody.language_code, 'en');
  assert.ok(!('language_detection' in calls.submitBody));
});

test('транзиентные 5xx/сетевые сбои поллинга переживаются БЕЗ пересабмита job', async () => {
  const calls = fakeApi([
    () => res(503, {}),
    () => { throw new Error('socket hang up'); },
    () => res(429, {}),
    () => res(200, { status: 'processing' }),
  ]);
  const r = await transcribeAssembly(audio, OPTS);
  assert.equal(r.speakers, 2);
  assert.equal(calls.upload, 1, 'аудио НЕ перезаливалось');
  assert.equal(calls.submit, 1, 'job НЕ пересабмитился');
});

test('upload retry: 503 → 200 без падения', async () => {
  const calls = fakeApi({ uploadScript: [() => res(503, { error: 'busy' })] });
  const r = await transcribeAssembly(audio, { ...OPTS, retryBaseMs: 0 });
  assert.equal(r.speakers, 2);
  assert.equal(calls.upload, 2);
  assert.equal(calls.submit, 1);
});

test('submit 429/503 не ретраится, чтобы не создать второй billable job', async () => {
  for (const status of [429, 503]) {
    const calls = fakeApi({ submitScript: [() => res(status, { error: 'busy' }, { 'retry-after': '0' })] });
    await assert.rejects(
      () => transcribeAssembly(audio, { ...OPTS, retryBaseMs: 0 }),
      new RegExp(`AssemblyAI submit \\(${status}\\)`)
    );
    assert.equal(calls.upload, 1);
    assert.equal(calls.submit, 1);
  }
});

test('upload 401 помечается isAuthError + provider=assembly', async () => {
  fakeApi({ uploadScript: [() => res(401, { error: 'bad key' })] });
  await assert.rejects(
    () => uploadAssembly(audio, { apiKey: 'bad', retryBaseMs: 0 }),
    e => e?.isAuthError === true && e?.provider === 'assembly'
  );
});

test('submit 401 помечается isAuthError + provider=assembly', async () => {
  const calls = fakeApi({ submitScript: [() => res(401, { error: 'bad key' })] });
  await assert.rejects(
    () => transcribeAssembly(audio, { ...OPTS, retryBaseMs: 0 }),
    e => e?.isAuthError === true && e?.provider === 'assembly'
  );
  assert.equal(calls.upload, 1);
  assert.equal(calls.submit, 1);
});

test('K1: uploadUrl переиспользуется — upload один, submit два', async () => {
  const calls = fakeApi({ uploadUrl: 'https://cached-upload' });
  const uploadUrl = await uploadAssembly(audio, { apiKey: 'k', retryBaseMs: 0 });
  await transcribeAssembly(audio, { ...OPTS, uploadUrl, retryBaseMs: 0 });
  await transcribeAssembly(audio, { ...OPTS, uploadUrl, speakersExpected: 2, retryBaseMs: 0 });
  assert.equal(uploadUrl, 'https://cached-upload');
  assert.equal(calls.upload, 1);
  assert.equal(calls.submit, 2);
  assert.deepEqual(calls.submitBodies.map(b => b.audio_url), ['https://cached-upload', 'https://cached-upload']);
  assert.equal(calls.submitBodies[0].speakers_expected, undefined);
  assert.equal(calls.submitBodies[1].speakers_expected, 2);
});

test('engine transcribeToUtterances: uploadUrl пропускает upload и input', async () => {
  const calls = fakeApi();
  const r = await transcribeToUtterances({
    uploadUrl: 'https://cached-engine',
    apiKey: 'k',
    pollIntervalMs: 1,
    pollTimeoutMs: 5000,
    retryBaseMs: 0,
  });
  assert.equal(r.speakers, 2);
  assert.equal(calls.upload, 0);
  assert.equal(calls.submit, 1);
  assert.equal(calls.submitBody.audio_url, 'https://cached-engine');
});

test('upload AbortError мапится в понятный timeout', async () => {
  globalThis.fetch = async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await assert.rejects(
    () => transcribeAssembly(audio, { ...OPTS, retryBaseMs: 0 }),
    /таймаут запроса к AssemblyAI upload/
  );
});

test('поллинг сдаётся после серии сбоев подряд (не вечный ретрай)', async () => {
  const calls = fakeApi(Array.from({ length: 20 }, () => () => { throw new Error('ECONNRESET'); }));
  await assert.rejects(() => transcribeAssembly(audio, OPTS), /не восстановился после \d+ сбоев/);
  assert.equal(calls.submit, 1);
  assert.ok(calls.poll <= 7, `поллов было ${calls.poll} — ретраи ограничены`);
});

test('вечный processing обрывается дедлайном (не бесконечный цикл)', async () => {
  fakeApi(Array.from({ length: 10000 }, () => () => res(200, { status: 'processing' })));
  await assert.rejects(
    () => transcribeAssembly(audio, { ...OPTS, pollTimeoutMs: 40 }),
    /не завершился за \d+ мин/
  );
});

test('невосстановимый 4xx на поллинге падает сразу, без ретраев', async () => {
  const calls = fakeApi(Array.from({ length: 10 }, () => () => res(401, { error: 'bad key' })));
  await assert.rejects(
    () => transcribeAssembly(audio, OPTS),
    e => e?.isAuthError === true && e?.provider === 'assembly' && /AssemblyAI poll/.test(e.message)
  );
  assert.equal(calls.poll, 1, 'ровно один полл — 401 не ретраится');
});

test('status=error от AssemblyAI пробрасывается с текстом', async () => {
  fakeApi([() => res(200, { status: 'error', error: 'audio too short' })]);
  await assert.rejects(() => transcribeAssembly(audio, OPTS), /audio too short/);
});

// ─── Схлопнувшаяся диаризация → абзацы ──────────────────────────────────────
// AssemblyAI на длинных записях иногда отдаёт одного спикера и одну utterance
// на весь файл: транскрипт становится стеной текста с единственным таймстампом.
// Абзацы того же job'а повторно не биллятся, поэтому берём их.

const collapsed = (duration, utterances) => () => res(200, {
  status: 'completed', audio_duration: duration, utterances,
});
const ONE_UTTERANCE = [{ speaker: 'A', start: 20011, end: 5399842, text: 'вся запись одним куском' }];

test('isDiarizationCollapsed: один спикер + редкие реплики на длинной записи', () => {
  assert.equal(isDiarizationCollapsed(ONE_UTTERANCE, 5401), true);
});

test('isDiarizationCollapsed: короткая запись и пустой список не считаются схлопнувшимися', () => {
  assert.equal(isDiarizationCollapsed(ONE_UTTERANCE, 60), false);
  assert.equal(isDiarizationCollapsed([], 5401), false);
});

test('isDiarizationCollapsed: диалог и плотный монолог не трогаем', () => {
  const dialogue = [{ speaker: 'A' }, { speaker: 'B' }];
  assert.equal(isDiarizationCollapsed(dialogue, 5401), false);
  const dense = Array.from({ length: 250 }, () => ({ speaker: 'A' }));
  assert.equal(isDiarizationCollapsed(dense, 5401), false);
});

test('схлопнувшаяся диаризация: реплики берутся из абзацев, метка спикера сохраняется', async () => {
  const calls = fakeApi({
    pollScript: [collapsed(5401, ONE_UTTERANCE)],
    paragraphsScript: [() => res(200, { paragraphs: [
      { start: 20011, end: 37000, text: 'первый абзац' },
      { start: 37000, end: 56000, text: 'второй абзац' },
      { start: 56000, end: 81000, text: '  ' },
    ] })],
  });
  const r = await transcribeAssembly(audio, OPTS);
  assert.equal(calls.paragraphs, 1);
  assert.equal(calls.submit, 1);            // повторной (платной) транскрипции нет
  assert.equal(r.diarizationFallback, true);
  assert.equal(r.utterances.length, 2);     // пустой абзац отброшен
  assert.equal(r.utterances[0].start, 20.011);
  assert.equal(r.utterances[1].transcript, 'второй абзац');
  assert.deepEqual([...new Set(r.utterances.map(u => u.speaker))], ['A']);
  assert.equal(r.duration, 5401);
});

test('абзацы недоступны → транскрипт не теряем, падения нет', async () => {
  const calls = fakeApi({
    pollScript: [collapsed(5401, ONE_UTTERANCE)],
    paragraphsScript: [
      () => res(500, { error: 'boom' }),
      () => res(500, { error: 'boom' }),
      () => res(500, { error: 'boom' }),
    ],
  });
  const r = await transcribeAssembly(audio, { ...OPTS, retryBaseMs: 1 });
  assert.equal(calls.paragraphs, 3);
  assert.equal(r.diarizationFallback, false);
  assert.equal(r.utterances.length, 1);
  assert.equal(r.utterances[0].transcript, 'вся запись одним куском');
});

test('абзацев не больше, чем реплик → остаёмся на репликах', async () => {
  fakeApi({
    pollScript: [collapsed(5401, ONE_UTTERANCE)],
    paragraphsScript: [() => res(200, { paragraphs: [{ start: 0, end: 10, text: 'один' }] })],
  });
  const r = await transcribeAssembly(audio, OPTS);
  assert.equal(r.diarizationFallback, false);
  assert.equal(r.utterances[0].transcript, 'вся запись одним куском');
});

test('нормальный диалог: за абзацами не ходим', async () => {
  const calls = fakeApi([() => res(200, { status: 'processing' })]);
  const r = await transcribeAssembly(audio, OPTS);
  assert.equal(calls.paragraphs, 0);
  assert.equal(r.diarizationFallback, false);
  assert.equal(r.speakers, 2);
});

test('isDiarizationCollapsed: оба порога binding — 119 с нет, 120 с да', () => {
  assert.equal(isDiarizationCollapsed(ONE_UTTERANCE, 119), false); // короче минимума
  assert.equal(isDiarizationCollapsed(ONE_UTTERANCE, 120), true);
  // плотность: 3 реплики на 180 с — это ровно одна в минуту, уже не схлопнулось
  const three = [{ speaker: 'A' }, { speaker: 'A' }, { speaker: 'A' }];
  assert.equal(isDiarizationCollapsed(three, 180), false);
  assert.equal(isDiarizationCollapsed(three.slice(0, 2), 180), true);
});

test('isDiarizationCollapsed: без длительности не гадаем', () => {
  assert.equal(isDiarizationCollapsed(ONE_UTTERANCE, undefined), false);
  assert.equal(isDiarizationCollapsed(ONE_UTTERANCE, 0), false);
});

test('усечённые абзацы не подменяют оплаченный транскрипт', async () => {
  fakeApi({
    pollScript: [collapsed(5401, ONE_UTTERANCE)],
    // Формально абзацев больше (2 > 1), но текста в них почти нет — это обрезок.
    paragraphsScript: [() => res(200, { paragraphs: [
      { start: 0, end: 1000, text: 'вся' },
      { start: 1000, end: 2000, text: 'запись' },
    ] })],
  });
  const r = await transcribeAssembly(audio, OPTS);
  assert.equal(r.diarizationFallback, false);
  assert.equal(r.utterances.length, 1);
  assert.equal(r.utterances[0].transcript, 'вся запись одним куском');
});

test('404 на абзацах не ретраится', async () => {
  const calls = fakeApi({
    pollScript: [collapsed(5401, ONE_UTTERANCE)],
    paragraphsScript: [() => res(404, { error: 'not found' })],
  });
  const r = await transcribeAssembly(audio, { ...OPTS, retryBaseMs: 1 });
  assert.equal(calls.paragraphs, 1);
  assert.equal(r.diarizationFallback, false);
});

test('diarizationFallback доходит до transcribeToUtterances', async () => {
  fakeApi({
    pollScript: [collapsed(5401, ONE_UTTERANCE)],
    paragraphsScript: [() => res(200, { paragraphs: [
      { start: 20011, end: 37000, text: 'первый абзац подлиннее' },
      { start: 37000, end: 56000, text: 'второй абзац подлиннее' },
    ] })],
  });
  const r = await transcribeToUtterances({ uploadUrl: 'https://u', apiKey: 'k', pollIntervalMs: 1 });
  assert.equal(r.diarizationFallback, true);
  assert.equal(r.utterances.length, 2);
});

test('нормальный диалог: diarizationFallback=false доходит до transcribeToUtterances', async () => {
  fakeApi();
  const r = await transcribeToUtterances({ uploadUrl: 'https://u', apiKey: 'k', pollIntervalMs: 1 });
  assert.equal(r.diarizationFallback, false);
  assert.equal(r.speakers, 2);
});
