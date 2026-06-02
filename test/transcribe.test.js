import { test } from 'node:test';
import assert from 'node:assert';
import {
  formatTs, sanitizeFilename, isUrl, getSpeakerPreviews,
  formatMarkdown, buildDeepgramParams, opusEncodeArgs,
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
  assert.match(md, /\*\*Speaker 0\*\* \[00:00\]\nПривет\./);
  assert.match(md, /\*\*Speaker 0\*\* \[00:03\]\nКак дела\?/);
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

test('opusEncodeArgs: hq (диаризация) — 96k, без принудительного mono', () => {
  const hq = opusEncodeArgs(true);
  assert.match(hq, /-b:a 96k/);
  assert.doesNotMatch(hq, /-ac 1/);   // каналы сохраняем
});

test('opusEncodeArgs: обычный — 32k mono', () => {
  const lo = opusEncodeArgs(false);
  assert.match(lo, /-b:a 32k/);
  assert.match(lo, /-ac 1/);
});
