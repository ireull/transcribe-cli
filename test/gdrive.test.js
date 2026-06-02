import { test } from 'node:test';
import assert from 'node:assert';
import { cleanMeetName, formatSize } from '../gdrive.js';

test('cleanMeetName: осмысленное имя — чистится, дата нормализуется', () => {
  const r = cleanMeetName('Planning & Status check - 2026/06/01 15:30 CEST – Recording 2');
  assert.equal(r.clean, 'Planning & Status check — 2026-06-01');
  assert.equal(r.isGeneric, false);
});

test('cleanMeetName: дефолтный код встречи Google Meet — generic', () => {
  const r = cleanMeetName('bbb-tupg-phm (2026-05-26 20:02 GMT+2)');
  assert.equal(r.isGeneric, true);
  assert.equal(r.clean, 'Запись — 2026-05-26');
});

test('cleanMeetName: скобка с именем сохраняется, дата/таймзона срезается', () => {
  const r = cleanMeetName('Strategic session (Yaroslav Denisenko) - 2026/06/01 13:00 CEST – Recording');
  assert.equal(r.clean, 'Strategic session (Yaroslav Denisenko) — 2026-06-01');
  assert.equal(r.isGeneric, false);
});

test('cleanMeetName: дефис в имени не путается с разделителем даты', () => {
  const r = cleanMeetName('Pre-planning - 2026/06/01 10:45 CEST – Recording');
  assert.equal(r.clean, 'Pre-planning — 2026-06-01');
});

test('cleanMeetName: чистое имя без мусора — как есть', () => {
  const r = cleanMeetName('Team sync');
  assert.equal(r.clean, 'Team sync');
  assert.equal(r.isGeneric, false);
});

test('cleanMeetName: пустое — generic', () => {
  assert.equal(cleanMeetName('').isGeneric, true);
  assert.equal(cleanMeetName('   ').isGeneric, true);
});

test('formatSize', () => {
  assert.equal(formatSize(12 * 1024 * 1024), '12.0 MB');
  assert.equal(formatSize(500 * 1024), '500.0 KB');
  assert.equal(formatSize(0), '?');
  assert.equal(formatSize(undefined), '?');
});
