import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { cleanMeetName, formatSize, renameDriveFile, driveRenameTarget, downloadFile, mergeRecordings, collectRecordings } from '../gdrive.js';

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

test('downloadFile: успех пишет финальный файл и убирает .part', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gdrive-ok-'));
  const drive = {
    files: {
      get: async () => ({ data: Readable.from(['hello']) }),
    },
  };
  try {
    const out = await downloadFile(drive, 'id', 'meet.mp4', dir);
    assert.equal(readFileSync(out, 'utf-8'), 'hello');
    assert.equal(existsSync(`${out}.part`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── mergeRecordings ──────────────────────────────────────────────────────────

test('mergeRecordings: дедуп по id — дубль из второго списка отбрасывается', () => {
  const a = [{ id: '1', createdTime: '2026-06-01T10:00:00Z' }];
  const b = [
    { id: '1', createdTime: '2026-06-01T10:00:00Z' },
    { id: '2', createdTime: '2026-05-01T10:00:00Z' },
  ];
  const result = mergeRecordings([a, b], 100);
  assert.equal(result.length, 2);
  assert.equal(result.find(r => r.id === '1') !== undefined, true);
  assert.equal(result.find(r => r.id === '2') !== undefined, true);
});

test('mergeRecordings: сортировка по createdTime desc', () => {
  const lists = [
    [{ id: 'old', createdTime: '2026-01-01T00:00:00Z' }],
    [{ id: 'new', createdTime: '2026-06-01T00:00:00Z' }],
  ];
  const result = mergeRecordings(lists, 100);
  assert.equal(result[0].id, 'new');
  assert.equal(result[1].id, 'old');
});

test('mergeRecordings: обрезка до limit', () => {
  const list = [
    { id: 'a', createdTime: '2026-06-03T00:00:00Z' },
    { id: 'b', createdTime: '2026-06-02T00:00:00Z' },
    { id: 'c', createdTime: '2026-06-01T00:00:00Z' },
  ];
  const result = mergeRecordings([list], 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'a');
});

test('mergeRecordings: пустые списки — пустой результат', () => {
  assert.deepEqual(mergeRecordings([], 100), []);
  assert.deepEqual(mergeRecordings([[], []], 100), []);
});

// ── collectRecordings ─────────────────────────────────────────────────────────

test('collectRecordings: записи из ОБЕИХ папок присутствуют (regression: folder[1] не терялся)', async () => {
  const folder1Recording = { id: 'rec1', name: 'Meet1.mp4', createdTime: '2026-06-01T10:00:00Z', mimeType: 'video/mp4', size: '1000' };
  const folder2Recording = { id: 'rec2', name: 'Meet2.mp4', createdTime: '2026-05-01T10:00:00Z', mimeType: 'video/mp4', size: '2000' };

  const drive = {
    files: {
      list: async ({ q }) => {
        if (q.includes('application/vnd.google-apps.folder')) {
          return { data: { files: [{ id: 'f1', name: 'Meet Recordings' }, { id: 'f2', name: 'Meet Recordings' }] } };
        }
        if (q.includes("'f1' in parents")) return { data: { files: [folder1Recording] } };
        if (q.includes("'f2' in parents")) return { data: { files: [folder2Recording] } };
        return { data: { files: [] } };
      },
    },
  };

  const files = await collectRecordings(drive, 500);
  assert.equal(files.length, 2);
  assert.ok(files.find(f => f.id === 'rec1'), 'запись из папки 1 присутствует');
  assert.ok(files.find(f => f.id === 'rec2'), 'запись из папки 2 присутствует');
  assert.equal(files[0].id, 'rec1', 'новейшая сверху');
});

test('collectRecordings: 0 папок — fallback в listAllFiles', async () => {
  const allFile = { id: 'any', name: 'random.mp4', createdTime: '2026-06-01T00:00:00Z', mimeType: 'video/mp4', size: '500' };
  const drive = {
    files: {
      list: async ({ q }) => {
        if (q.includes('application/vnd.google-apps.folder')) return { data: { files: [] } };
        return { data: { files: [allFile] } };
      },
    },
  };

  const files = await collectRecordings(drive, 500);
  assert.equal(files.length, 1);
  assert.equal(files[0].id, 'any');
});

test('collectRecordings: частичный сбой — запись из живой папки сохраняется', async () => {
  const rec1 = { id: 'rec1', name: 'Meet1.mp4', createdTime: '2026-06-01T10:00:00Z', mimeType: 'video/mp4', size: '1000' };
  const drive = {
    files: {
      list: async ({ q }) => {
        if (q.includes('application/vnd.google-apps.folder')) {
          return { data: { files: [{ id: 'f1', name: 'Meet Recordings' }, { id: 'f2', name: 'Meet Recordings' }] } };
        }
        if (q.includes("'f1' in parents")) return { data: { files: [rec1] } };
        if (q.includes("'f2' in parents")) throw new Error('403 Forbidden');
        return { data: { files: [] } };
      },
    },
  };

  const files = await collectRecordings(drive, 500);
  assert.equal(files.length, 1);
  assert.equal(files[0].id, 'rec1', 'запись из живой папки присутствует');
});

test('collectRecordings: полный сбой всех папок — пробрасывает ошибку', async () => {
  const drive = {
    files: {
      list: async ({ q }) => {
        if (q.includes('application/vnd.google-apps.folder')) {
          return { data: { files: [{ id: 'f1', name: 'Meet Recordings' }, { id: 'f2', name: 'Meet Recordings' }] } };
        }
        throw new Error('401 Unauthorized');
      },
    },
  };

  await assert.rejects(() => collectRecordings(drive, 500), /401 Unauthorized/);
});

// ─────────────────────────────────────────────────────────────────────────────

test('downloadFile: ошибка stream удаляет .part и пробрасывается', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gdrive-fail-'));
  const drive = {
    files: {
      get: async () => ({
        data: new Readable({
          read() {
            this.destroy(new Error('stream boom'));
          },
        }),
      }),
    },
  };
  const out = join(dir, 'broken.mp4');
  try {
    await assert.rejects(() => downloadFile(drive, 'id', 'broken.mp4', dir), /stream boom/);
    assert.equal(existsSync(`${out}.part`), false);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
