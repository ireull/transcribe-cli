import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  formatTs, sanitizeFilename, isUrl, getSpeakerPreviews, splitBySpeaker, speakerLabel,
  formatMarkdown, buildDeepgramParams, opusEncodeArgs,
  runTranscription, callDeepgram,
} from '../transcribe.js';

test('formatTs: mm:ss и h:mm:ss', () => {
  assert.equal(formatTs(0), '00:00');
  assert.equal(formatTs(65), '01:05');
  assert.equal(formatTs(3661), '1:01:01');
});

test('isUrl', () => {
  assert.equal(isUrl('https://youtu.be/x'), true);
  assert.equal(isUrl('http://a.b'), true);
  assert.equal(isUrl('/local/file.mp4'), false);
  assert.equal(isUrl('ftp://x'), false);
});

test('sanitizeFilename: режет спецсимволы и длину', () => {
  assert.equal(sanitizeFilename('a/b:c*?"<>|d'), 'a_b_c______d');
  assert.equal(sanitizeFilename('  hi  '), 'hi');
  assert.equal(sanitizeFilename(''), 'transcript');
  assert.ok(sanitizeFilename('x'.repeat(300)).length <= 120);
});

const utterData = {
  metadata: { duration: 65 },
  results: {
    utterances: [
      { speaker: 0, start: 0, transcript: 'Привет.' },
      { speaker: 0, start: 3, transcript: 'Как дела?' },
      { speaker: 1, start: 5, transcript: 'Нормально.' },
      { speaker: 0, start: 8, transcript: 'Отлично.' },
    ],
  },
};

test('formatMarkdown: склейка подряд идущих реплик одного спикера', () => {
  const md = formatMarkdown(utterData, true, 'T', { 0: 'Иван', 1: 'Мария' }, true);
  assert.match(md, /# T/);
  assert.match(md, /\*\*Иван\*\* \[00:00\]\nПривет\. Как дела\?/);
  assert.match(md, /\*\*Мария\*\* \[00:05\]\nНормально\./);
  // после Марии снова Иван — отдельный блок
  assert.match(md, /\*\*Иван\*\* \[00:08\]\nОтлично\./);
  // три блока спикеров
  assert.equal((md.match(/\*\*/g) || []).length / 2, 3);
});

test('formatMarkdown: merge=false — каждая реплика отдельным блоком', () => {
  const md = formatMarkdown(utterData, true, '', {}, false);
  assert.equal((md.match(/\*\*Speaker/g) || []).length, 4);
  assert.match(md, /\*\*Speaker 1\*\* \[00:00\]\nПривет\./);
  assert.match(md, /\*\*Speaker 1\*\* \[00:03\]\nКак дела\?/);
});

test('speakerLabel: номера Deepgram с единицы, буквы AssemblyAI как есть', () => {
  assert.equal(speakerLabel(0), 'Speaker 1');
  assert.equal(speakerLabel(3), 'Speaker 4');
  assert.equal(speakerLabel('A'), 'Speaker A');
  assert.equal(speakerLabel(undefined), 'Speaker ?');
});

test('formatMarkdown: имя ключуется исходным id, метка без имени — с единицы', () => {
  const md = formatMarkdown(utterData, true, '', { 1: 'Мария' }, false);
  assert.match(md, /\*\*Speaker 1\*\* \[00:00\]/);
  assert.match(md, /\*\*Мария\*\* \[00:05\]/);
  assert.doesNotMatch(md, /Speaker 2/);
});

test('formatMarkdown: блок саммари вставляется', () => {
  const md = formatMarkdown(utterData, true, 'T', {}, true, 'Обсудили релиз.');
  assert.match(md, /## Краткое содержание\n\nОбсудили релиз\./);
  // саммари идёт до транскрипта
  assert.ok(md.indexOf('Краткое содержание') < md.indexOf('Привет'));
});

test('formatMarkdown: без спикеров — параграфы', () => {
  const data = {
    results: { channels: [{ alternatives: [{ paragraphs: { paragraphs: [
      { sentences: [{ text: 'Раз.' }, { text: 'Два.' }] },
    ] } }] }] },
  };
  const md = formatMarkdown(data, false);
  assert.match(md, /Раз\. Два\./);
});

test('getSpeakerPreviews: уникальные спикеры, максимум 4 реплики', () => {
  const data = { results: { utterances: [
    { speaker: 0, start: 0, transcript: 'a' }, { speaker: 0, start: 1, transcript: 'b' },
    { speaker: 0, start: 2, transcript: 'c' }, { speaker: 0, start: 3, transcript: 'd' },
    { speaker: 0, start: 4, transcript: 'e' }, { speaker: 1, start: 5, transcript: 'x' },
  ] } };
  const p = getSpeakerPreviews(data);
  assert.equal(p.length, 2);
  const sp0 = p.find(x => x.id === 0);
  assert.equal(sp0.lines.length, 4); // ограничение в 4
});

// ─── Смена спикера внутри реплики ───────────────────────────────────────────
// Deepgram режет utterances не по смене спикера: слова двух людей лежат в одной
// реплике, а `speaker` у неё один — вторая фраза уходила первому спикеру.

const word = (text, speaker, start) => ({ word: text.toLowerCase(), punctuated_word: text, speaker, start, end: start + 1 });

const mixedUtterance = {
  speaker: 0, start: 15, end: 20, transcript: 'Когда будет отчёт? Завтра пришлю.',
  words: [
    word('Когда', 0, 15), word('будет', 0, 16), word('отчёт?', 0, 17),
    word('Завтра', 1, 18), word('пришлю.', 1, 19),
  ],
};

test('splitBySpeaker: реплика двух спикеров режется по меткам слов', () => {
  const r = splitBySpeaker([mixedUtterance, { speaker: 1, start: 20, end: 21, transcript: 'Да.', words: [word('Да.', 1, 20)] }]);
  assert.deepEqual(r.map(u => u.speaker), [0, 1, 1]);
  assert.equal(r[0].transcript, 'Когда будет отчёт?');
  assert.equal(r[1].transcript, 'Завтра пришлю.');
  assert.deepEqual([r[1].start, r[1].end], [18, 20]);   // таймстамп — от своего первого слова
  assert.deepEqual(r[1].words.map(w => w.word), ['завтра', 'пришлю.']);
});

test('splitBySpeaker: реплика одного спикера не меняется', () => {
  const u = { speaker: 0, start: 1, end: 3, transcript: 'Текст  как есть.', words: [word('Текст', 0, 1), word('как', 0, 2), word('есть.', 0, 3)] };
  assert.strictEqual(splitBySpeaker([u])[0], u);
});

// Метки слов богаче меток реплик: на них всплывают «спикеры» из одного слова.
// Это лишние имена в переименовании — ровно то, на что и так жалуются.
test('splitBySpeaker: метка только на словах не создаёт нового спикера', () => {
  const u = { speaker: 0, start: 1, end: 4, transcript: 'раз два три', words: [word('раз', 0, 1), word('два', 7, 2), word('три', 0, 3)] };
  assert.strictEqual(splitBySpeaker([u])[0], u);
});

const reply = { speaker: 1, start: 30, end: 31, transcript: 'Да.', words: [word('Да.', 1, 30)] };

// На реальных записях метки слов откалывали от фразы куски в одно-два слова:
// «релиз будет / через / неделю» с чужим спикером на «через».
test('splitBySpeaker: короткий кусок посреди фразы остаётся с её продолжением', () => {
  const u = {
    speaker: 0, start: 1, end: 4, transcript: 'будет через неделю',
    words: [word('будет', 0, 1), word('через', 1, 2), word('неделю', 0, 3)],
  };
  assert.deepEqual(splitBySpeaker([u, reply]), [u, reply]);
});

test('splitBySpeaker: короткий кусок перед чужой фразой уходит к её спикеру', () => {
  const r = splitBySpeaker([{
    speaker: 0, start: 1, end: 5, transcript: 'А что нового по проекту?',
    words: [word('А', 0, 1), word('что', 0, 2), word('нового', 1, 3), word('по', 1, 4), word('проекту?', 1, 5)],
  }, reply]);
  assert.deepEqual(r.map(u => [u.speaker, u.transcript]), [[1, 'А что нового по проекту?'], [1, 'Да.']]);
});

// Длинный кусок — уже не шум: реплика вполне могла прерваться на полуслове.
test('splitBySpeaker: длинный кусок без знака на конце отделяется', () => {
  const r = splitBySpeaker([{
    speaker: 0, start: 1, end: 7, transcript: 'Окей, мы вроде решили не срочно',
    words: [word('Окей,', 1, 1), word('мы', 1, 2), word('вроде', 1, 3), word('решили', 1, 4), word('не', 0, 5), word('срочно', 0, 6)],
  }, reply]);
  assert.deepEqual(r.map(u => u.speaker), [1, 0, 1]);
});

// speaker_confidence намеренно не используется: её шкала разная от записи к записи,
// и порог, подходящий одной записи, на другой отбрасывал верные смены спикера.
test('splitBySpeaker: законченная короткая реплика отделяется при любой уверенности', () => {
  const u = {
    speaker: 0, start: 1, end: 4, transcript: 'Договоримся заранее. Согласен.',
    words: [word('Договоримся', 0, 1), word('заранее.', 0, 2), { ...word('Согласен.', 1, 3), speaker_confidence: 0.4 }],
  };
  const r = splitBySpeaker([u, reply]);
  assert.deepEqual(r.map(x => x.transcript), ['Договоримся заранее.', 'Согласен.', 'Да.']);
});

test('splitBySpeaker: без меток на словах реплика не меняется', () => {
  const bare = { speaker: 0, start: 0, end: 1, transcript: 'нет слов' };
  const unlabeled = { speaker: 0, start: 1, end: 2, transcript: 'без меток', words: [{ word: 'без' }, { word: 'меток' }] };
  assert.deepEqual(splitBySpeaker([bare, unlabeled]), [bare, unlabeled]);
});

test('runTranscription: Deepgram — смена спикера внутри реплики видна в файле и в превью', async () => {
  const orig = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), 'tx-run-split-'));
  const audio = join(dir, 'a.opus');
  writeFileSync(audio, 'audio');
  globalThis.fetch = async (_url, opts = {}) => {
    await drainBody(opts.body);
    return httpResp(200, { metadata: { duration: 21 }, results: { utterances: [
      mixedUtterance,
      { speaker: 1, start: 20, end: 21, transcript: 'Да.', words: [word('Да.', 1, 20)] },
    ] } });
  };
  let previews;
  try {
    const out = await runTranscription(audio, {
      speakers: true,
      lang: 'ru',
      apiKey: 'k',
      merge: false,
      outputDir: dir,
      quiet: true,
      onSpeakers: async p => { previews = p; return {}; },
    });
    const md = readFileSync(out, 'utf-8');
    assert.match(md, /\*\*Speaker 1\*\* \[00:15\]\nКогда будет отчёт\?\n/);
    assert.match(md, /\*\*Speaker 2\*\* \[00:18\]\nЗавтра пришлю\.\n/);
    assert.equal(previews.find(p => p.id === 1).lines[0].text, 'Завтра пришлю.');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildDeepgramParams: авто-язык + спикеры + числа', () => {
  const p = buildDeepgramParams({ autoLang: true, speakers: true, numerals: true });
  assert.equal(p.get('detect_language'), 'true');
  assert.equal(p.get('language'), null);          // не слать вместе с detect_language
  assert.equal(p.get('diarize_model'), 'latest'); // v2
  assert.equal(p.get('diarize'), null);           // legacy не слать
  assert.equal(p.get('numerals'), 'true');
  assert.equal(p.get('model'), 'nova-3');
});

test('buildDeepgramParams: явный язык, без спикеров/чисел', () => {
  const p = buildDeepgramParams({ lang: 'ru', autoLang: false, speakers: false, numerals: false });
  assert.equal(p.get('language'), 'ru');
  assert.equal(p.get('detect_language'), null);
  assert.equal(p.get('diarize_model'), null);
  assert.equal(p.get('numerals'), null);
});

test('opusEncodeArgs: hq (диаризация) — 128k, без принудительного mono', () => {
  const hq = opusEncodeArgs(true);
  assert.match(hq, /-b:a 128k/);
  assert.doesNotMatch(hq, /-ac 1/);   // каналы сохраняем
});

test('opusEncodeArgs: обычный — 32k mono', () => {
  const lo = opusEncodeArgs(false);
  assert.match(lo, /-b:a 32k/);
  assert.match(lo, /-ac 1/);
});

const httpResp = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: { get: () => null },
});

async function drainBody(body) {
  if (!body?.[Symbol.asyncIterator]) return;
  for await (const _ of body) {}
}

test('runTranscription: isAuthError пробрасывается наружу', async () => {
  const orig = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), 'tx-run-auth-'));
  const audio = join(dir, 'a.opus');
  writeFileSync(audio, 'audio');
  globalThis.fetch = async (_url, opts = {}) => {
    await drainBody(opts.body);
    return httpResp(401, { message: 'bad key' });
  };
  try {
    await assert.rejects(
      () => runTranscription(audio, {
        speakers: false,
        lang: 'ru',
        apiKey: 'bad',
        outputDir: dir,
        quiet: true,
      }),
      e => e?.isAuthError === true && /Deepgram/.test(e.message)
    );
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTranscription: прочие ошибки возвращают null', async () => {
  const orig = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), 'tx-run-null-'));
  const audio = join(dir, 'a.opus');
  writeFileSync(audio, 'audio');
  globalThis.fetch = async (_url, opts = {}) => {
    await drainBody(opts.body);
    return httpResp(402, { message: 'no balance' });
  };
  try {
    const out = await runTranscription(audio, {
      speakers: false,
      lang: 'ru',
      apiKey: 'k',
      outputDir: dir,
      quiet: true,
    });
    assert.equal(out, null);
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callDeepgram: retry 503 → 200 и stream upload с Content-Length', async () => {
  const orig = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), 'tx-dg-retry-'));
  const audio = join(dir, 'a.opus');
  writeFileSync(audio, 'audio-bytes');
  let calls = 0;
  const bodies = [];
  globalThis.fetch = async (_url, opts = {}) => {
    calls++;
    bodies.push(opts.body);
    assert.equal(opts.headers['Content-Length'], '11');
    assert.equal(opts.duplex, 'half');
    assert.equal(typeof opts.body?.pipe, 'function');
    await drainBody(opts.body);
    if (calls === 1) return httpResp(503, { message: 'busy' });
    return httpResp(200, { results: { channels: [] } });
  };
  try {
    const r = await callDeepgram(audio, {
      model: 'nova-3',
      lang: 'ru',
      autoLang: false,
      speakers: false,
      numerals: true,
      apiKey: 'k',
      retryAttempts: 2,
      retryBaseMs: 0,
    });
    assert.deepEqual(r, { results: { channels: [] } });
    assert.equal(calls, 2);
    assert.notEqual(bodies[0], bodies[1], 'на retry нужен новый stream');
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callDeepgram: 401 → isAuthError без retry', async () => {
  const orig = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), 'tx-dg-auth-'));
  const audio = join(dir, 'a.opus');
  writeFileSync(audio, 'audio');
  let calls = 0;
  globalThis.fetch = async (_url, opts = {}) => {
    calls++;
    await drainBody(opts.body);
    return httpResp(401, { message: 'bad key' });
  };
  try {
    await assert.rejects(
      () => callDeepgram(audio, {
        model: 'nova-3',
        lang: 'ru',
        autoLang: false,
        speakers: false,
        numerals: true,
        apiKey: 'bad',
        retryAttempts: 3,
        retryBaseMs: 0,
      }),
      e => e?.isAuthError === true && e?.provider === 'deepgram'
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Один спикер ────────────────────────────────────────────────────────────
// Склейка подряд идущих реплик одного спикера у монолога «подряд идущие» — это
// вся запись: без потолка блок разрастался на часы и от транскрипта оставался
// один таймстамп. Потолок — MERGE_MAX_SPAN_S.

const soloData = {
  metadata: { duration: 5401 },
  results: { utterances: [
    { speaker: 'A', start: 20, end: 37, transcript: 'Первый абзац.' },
    { speaker: 'A', start: 37, end: 56, transcript: 'Второй абзац.' },
    { speaker: 'A', start: 3700, end: 3720, transcript: 'Через час.' },
  ] },
};

test('formatMarkdown: монолог — склейка не переходит границу MERGE_MAX_SPAN_S', () => {
  const md = formatMarkdown(soloData, true, '', {}, true);
  // 20 и 37 — в одном окне, 3700 — уже в другом
  assert.match(md, /\*\*\[00:20\]\*\*\nПервый абзац\. Второй абзац\./);
  assert.match(md, /\*\*\[1:01:40\]\*\*\nЧерез час\./);
  assert.equal((md.match(/^\*\*\[/gm) || []).length, 2);
});

test('formatMarkdown: монолог — метка «Speaker A» не печатается', () => {
  const md = formatMarkdown(soloData, true, '', {}, true);
  assert.ok(!md.includes('Speaker'));
});

test('formatMarkdown: монолог с именем — имя показываем в каждом блоке', () => {
  const md = formatMarkdown(soloData, true, '', { A: 'Вадим' }, true);
  assert.equal((md.match(/\*\*Вадим\*\*/g) || []).length, 2);
});

test('formatMarkdown: часовой монолог из пофразовых реплик (как у Deepgram) не даёт ни стены, ни блока на фразу', () => {
  // Deepgram отдаёт реплики уровня предложения: раз в ~3 секунды.
  const utterances = Array.from({ length: 1200 }, (_, i) => ({
    speaker: 0, start: i * 3, end: i * 3 + 3, transcript: `Фраза ${i}.`,
  }));
  const md = formatMarkdown({ metadata: { duration: 3600 }, results: { utterances } }, true, '', {}, true);
  const blocks = (md.match(/^\*\*\[/gm) || []).length;
  assert.ok(blocks > 1, 'не одна стена текста');
  assert.ok(blocks < 100, `не блок на фразу, а ${blocks} блоков`);
  assert.match(md, /\*\*\[00:00\]\*\*\nФраза 0\. Фраза 1\./);
});

test('formatMarkdown: диалог — склейка по спикеру работает как раньше', () => {
  const md = formatMarkdown(utterData, true, '', {}, true);
  assert.match(md, /\*\*Speaker 1\*\* \[00:00\]\nПривет\. Как дела\?/);
  assert.equal((md.match(/^\*\*Speaker/gm) || []).length, 3);
});
