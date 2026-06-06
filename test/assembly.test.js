import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { transcribeAssembly } from '../assembly.js';

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

const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// Фейковый API: счётчики вызовов + настраиваемая последовательность ответов поллинга.
// pollScript — массив функций () => Promise<response> | throw; исчерпался → completed.
function fakeApi(pollScript = []) {
  const calls = { upload: 0, submit: 0, poll: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    if (url.endsWith('/upload')) { calls.upload++; return res(200, { upload_url: 'https://u' }); }
    if (url.endsWith('/transcript') && opts.method === 'POST') { calls.submit++; return res(200, { id: 'job1' }); }
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
  await assert.rejects(() => transcribeAssembly(audio, OPTS), /AssemblyAI poll \(401\)/);
  assert.equal(calls.poll, 1, 'ровно один полл — 401 не ретраится');
});

test('status=error от AssemblyAI пробрасывается с текстом', async () => {
  fakeApi([() => res(200, { status: 'error', error: 'audio too short' })]);
  await assert.rejects(() => transcribeAssembly(audio, OPTS), /audio too short/);
});
