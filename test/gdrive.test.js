import { test } from 'node:test';
import assert from 'node:assert';
import { cleanMeetName, formatSize, renameDriveFile, driveRenameTarget } from '../gdrive.js';

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

test('renameDriveFile: вызывает files.update с новым именем и supportsAllDrives', async () => {
  let called;
  const drive = { files: { update: async (args) => { called = args; return { data: {} }; } } };
  await renameDriveFile(drive, 'FILE_ID', 'Планёрка — 2026-05-26');
  assert.equal(called.fileId, 'FILE_ID');
  assert.equal(called.requestBody.name, 'Планёрка — 2026-05-26');
  assert.equal(called.supportsAllDrives, true);
});

test('driveRenameTarget: имя из саммари — переименовываем', () => {
  assert.equal(
    driveRenameTarget('/out/Планёрка по релизу — 2026-05-26.md', 'bbb-tupg-phm'),
    'Планёрка по релизу — 2026-05-26'
  );
});

test('driveRenameTarget: дефолт «Запись — дата» (саммари выкл) — не переименовываем', () => {
  assert.equal(driveRenameTarget('/out/Запись — 2026-05-26.md', 'bbb-tupg-phm'), null);
  assert.equal(driveRenameTarget('/out/Запись.md', 'bbb-tupg-phm'), null);
});

test('driveRenameTarget: коллизийный суффикс _N сохраняется (осмысленное не режем)', () => {
  assert.equal(driveRenameTarget('/out/Sprint_2.md', 'abc-defg-hij'), 'Sprint_2');
});

test('driveRenameTarget: сохраняет медиа-расширение исходника', () => {
  assert.equal(driveRenameTarget('/out/Планёрка.md', 'abc-defg-hij.mp4'), 'Планёрка.mp4');
});

test('driveRenameTarget: точки в имени исходника не считаются расширением', () => {
  assert.equal(driveRenameTarget('/out/Планёрка.md', 'bbb-tupg-phm (2026.05.26)'), 'Планёрка');
});

test('driveRenameTarget: имя уже совпадает — null', () => {
  assert.equal(driveRenameTarget('/out/Team sync.md', 'Team sync'), null);
});
