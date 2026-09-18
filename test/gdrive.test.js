import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { cleanMeetName, formatSize, renameDriveFile, driveRenameTarget, downloadFile, mergeRecordings, collectRecordings, recordingName, describeRoots, describeCounts, accountLabel } from '../gdrive.js';

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
//
// Мок Drive различает три запроса collectRecordings по тексту `q`:
//   roots  — корневые папки по имени (`name = 'Google Meet' …`)
//   subs   — подпапки корня (`'<id>' in parents and mimeType = folder`)
//   media  — глобальный список видео/аудио/ярлыков (`mimeType contains 'video/'`)
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
//   files.get — метаданные цели ярлыка (`targets[id]`; Error → бросается)
const mockDrive = ({ roots = [], subs = {}, media = [], targets = {}, gets = [] }) => ({
  files: {
    get: async ({ fileId }) => {
      gets.push(fileId);
      const t = targets[fileId];
      if (!t) throw new Error(`404 File not found: ${fileId}`);
      if (t instanceof Error) throw t;
      return { data: t };
    },
    list: async ({ q, pageToken }) => {
      if (q.includes("name = 'Google Meet'")) return { data: { files: roots } };
      if (q.includes(`mimeType = '${FOLDER}'`)) {
        const id = q.match(/^'([^']+)' in parents/)[1];
        const r = subs[id];
        if (r instanceof Error) throw r;
        return { data: { files: r || [] } };
      }
      if (q.includes("mimeType contains 'video/'")) {
        if (media instanceof Error) throw media;
        if (typeof media === 'function') return media(pageToken);
        return { data: { files: media } };
      }
      throw new Error(`неожиданный запрос: ${q}`);
    },
  },
});
const rec = (id, parent, createdTime, extra = {}) =>
  ({ id, name: `${id}.mp4`, createdTime, mimeType: 'video/mp4', size: '1000', parents: [parent], ...extra });

test('collectRecordings: старая схема — записи из ОБЕИХ «Meet Recordings», чужие медиа отсеяны', async () => {
  const drive = mockDrive({
    roots: [{ id: 'f1', name: 'Meet Recordings' }, { id: 'f2', name: 'Meet Recordings' }],
    media: [
      rec('rec2', 'f2', '2026-05-01T10:00:00Z'),
      rec('rec1', 'f1', '2026-06-01T10:00:00Z'),
      rec('noise', 'somewhere-else', '2026-07-01T10:00:00Z'),
    ],
  });

  const { files, roots } = await collectRecordings(drive, 500);
  assert.deepEqual(files.map(f => f.id), ['rec1', 'rec2'], 'обе записи, новейшая сверху, чужая отсеяна');
  assert.equal(files[0].folderName, undefined, 'запись прямо в корне — без folderName');
  assert.equal(roots.length, 2);
});

test('collectRecordings: новая схема — записи из подпапок «Google Meet», folderName с папки встречи', async () => {
  const drive = mockDrive({
    roots: [{ id: 'gm', name: 'Google Meet' }],
    subs: {
      gm: [
        { id: 'm1', name: 'ycw-hgwf-vvd - 2026/09/11 15:02 MSK' },
        { id: 'legacy', name: 'Legacy Meet Recordings' },
      ],
    },
    media: [
      rec('new', 'm1', '2026-09-11T13:34:53Z', { name: 'ycw-hgwf-vvd (2026-09-11 15:02 GMT+3)' }),
      rec('old', 'legacy', '2026-09-10T19:22:43Z'),
      rec('noise', 'other', '2026-09-12T00:00:00Z'),
    ],
  });

  const { files } = await collectRecordings(drive, 500);
  assert.deepEqual(files.map(f => f.id), ['new', 'old']);
  assert.equal(files[0].folderName, 'ycw-hgwf-vvd - 2026/09/11 15:02 MSK', 'папка встречи → folderName');
  assert.equal(files[1].folderName, undefined, '«Legacy Meet Recordings» внутри «Google Meet» — корень, не папка встречи');
});

test('collectRecordings: ярлык → целевой файл с его метаданными; настоящий файл побеждает дубль-ярлык; недоступная цель выпадает', async () => {
  const gets = [];
  const drive = mockDrive({
    roots: [{ id: 'gm', name: 'Google Meet' }, { id: 'mr', name: 'Meet Recordings' }],
    subs: { gm: [{ id: 'm1', name: 'Planning - 2026/09/12 10:00 CEST' }] },
    media: [
      { id: 'sc-doc', name: 'Notes', createdTime: '2026-09-12T10:00:00Z', mimeType: SHORTCUT, parents: ['m1'],
        shortcutDetails: { targetId: 'DOC', targetMimeType: 'application/vnd.google-apps.document' } },
      { id: 'sc-only', name: 'Only shortcut', createdTime: '2026-09-12T09:00:00Z', mimeType: SHORTCUT, parents: ['m1'],
        shortcutDetails: { targetId: 'T2', targetMimeType: 'video/mp4' } },
      { id: 'sc-dead', name: 'Dead shortcut', createdTime: '2026-09-12T08:30:00Z', mimeType: SHORTCUT, parents: ['m1'],
        shortcutDetails: { targetId: 'T3', targetMimeType: 'video/mp4' } },
      { id: 'sc-dup', name: 'Planning', createdTime: '2026-09-12T08:00:00Z', mimeType: SHORTCUT, parents: ['m1'],
        shortcutDetails: { targetId: 'T1', targetMimeType: 'video/mp4' } },
      rec('T1', 'mr', '2026-09-12T07:59:00Z', { name: 'Planning' }),
    ],
    targets: {
      // Цель ярлыка старше самого ярлыка и с реальным размером — в списке должны быть ЕЁ данные.
      T2: { id: 'T2', name: 'Planning (2026-09-12 07:00 GMT+2)', size: '555', createdTime: '2026-09-12T05:00:00Z', mimeType: 'video/mp4' },
      T3: new Error('403 The caller does not have permission'),
    },
    gets,
  });

  const { files } = await collectRecordings(drive, 500);
  assert.deepEqual(files.map(f => f.id), ['T1', 'T2'], 'ярлык на документ и ярлык с недоступной целью отброшены; дубль схлопнут; порядок по дате ЦЕЛИ');
  const viaShortcut = files.find(f => f.id === 'T2');
  assert.equal(viaShortcut.shortcutId, 'sc-only');
  assert.equal(viaShortcut.name, 'Planning (2026-09-12 07:00 GMT+2)', 'имя — целевого файла');
  assert.equal(viaShortcut.size, '555', 'размер — целевого файла (у ярлыка его нет)');
  assert.equal(viaShortcut.createdTime, '2026-09-12T05:00:00Z', 'дата — целевого файла');
  assert.equal(viaShortcut.mimeType, 'video/mp4');
  assert.equal(viaShortcut.folderName, 'Planning - 2026/09/12 10:00 CEST');
  const real = files.find(f => f.id === 'T1');
  assert.equal(real.shortcutId, undefined, 'при дубле остаётся настоящий файл, не ярлык');
  assert.deepEqual(gets.sort(), ['T2', 'T3'], 'files.get только для ярлыков без настоящего дубля');
});

test('collectRecordings: 0 корневых папок — fallback: все медиа SA без фильтра по папке (ярлыки тоже разворачиваются)', async () => {
  const drive = mockDrive({
    media: [
      rec('any', 'wherever', '2026-06-01T00:00:00Z'),
      { id: 'txt', name: 'chat.txt', createdTime: '2026-06-02T00:00:00Z', mimeType: 'text/plain', parents: ['wherever'] },
      { id: 'sc', name: 'Shortcut', createdTime: '2026-06-03T00:00:00Z', mimeType: SHORTCUT, parents: ['wherever'],
        shortcutDetails: { targetId: 'T', targetMimeType: 'audio/mpeg' } },
    ],
    targets: { T: { id: 'T', name: 'Target', size: '7', createdTime: '2026-05-01T00:00:00Z', mimeType: 'audio/mpeg' } },
  });

  const { files, roots } = await collectRecordings(drive, 500);
  assert.deepEqual(files.map(f => f.id), ['any', 'T']);
  assert.equal(files[1].size, '7');
  assert.deepEqual(roots, []);
});

test('collectRecordings: отсев по папке не съедает лимит — листаем следующую страницу', async () => {
  const calls = [];
  const drive = mockDrive({
    roots: [{ id: 'f1', name: 'Meet Recordings' }],
    media: (pageToken) => {
      calls.push(pageToken);
      if (!pageToken) return { data: { files: [rec('n1', 'x', '2026-06-03T00:00:00Z'), rec('n2', 'x', '2026-06-02T00:00:00Z')], nextPageToken: 'p2' } };
      return { data: { files: [rec('rec1', 'f1', '2026-06-01T00:00:00Z')] } };
    },
  });

  const { files } = await collectRecordings(drive, 1);
  assert.deepEqual(files.map(f => f.id), ['rec1']);
  assert.deepEqual(calls, [undefined, 'p2']);
});

test('collectRecordings: сбой подпапок одного корня — его прямые записи всё равно приходят', async () => {
  const drive = mockDrive({
    roots: [{ id: 'f1', name: 'Meet Recordings' }, { id: 'f2', name: 'Meet Recordings' }],
    subs: { f2: new Error('403 Forbidden') },
    media: [rec('rec1', 'f1', '2026-06-01T10:00:00Z'), rec('rec2', 'f2', '2026-05-01T10:00:00Z')],
  });

  const { files } = await collectRecordings(drive, 500);
  assert.deepEqual(files.map(f => f.id), ['rec1', 'rec2']);
});

test('collectRecordings: полный сбой всех корней — пробрасывает ошибку', async () => {
  const drive = mockDrive({
    roots: [{ id: 'f1', name: 'Meet Recordings' }, { id: 'f2', name: 'Meet Recordings' }],
    subs: { f1: new Error('401 Unauthorized'), f2: new Error('401 Unauthorized') },
  });

  await assert.rejects(() => collectRecordings(drive, 500), /401 Unauthorized/);
});

// ── recordingName / describeRoots ─────────────────────────────────────────────

test('recordingName: файл назван кодом встречи, папка осмысленная — имя с папки', () => {
  const r = recordingName({ name: 'ycw-hgwf-vvd (2026-09-11 15:02 GMT+3)', folderName: 'Planning & Status check - 2026/09/11 15:02 MSK' });
  assert.equal(r.clean, 'Planning & Status check — 2026-09-11');
  assert.equal(r.isGeneric, false);
});

test('recordingName: и файл, и папка — код встречи → generic с датой из файла', () => {
  const r = recordingName({ name: 'ycw-hgwf-vvd (2026-09-11 15:02 GMT+3)', folderName: 'ycw-hgwf-vvd - 2026/09/11 15:02 MSK' });
  assert.equal(r.isGeneric, true);
  assert.equal(r.clean, 'Запись — 2026-09-11');
});

test('recordingName: папка серии без даты — дата берётся из файла', () => {
  const r = recordingName({ name: 'ycw-hgwf-vvd (2026-09-11 15:02 GMT+3)', folderName: 'Planning & Status check (recurring)' });
  assert.equal(r.clean, 'Planning & Status check (recurring) — 2026-09-11');
  assert.equal(r.isGeneric, false);
});

test('recordingName: осмысленное имя файла — папка не смотрится', () => {
  const r = recordingName({ name: 'Pre-planning - 2026/09/07 10:44 CEST – Recording', folderName: 'ycw-hgwf-vvd - 2026/09/07 10:44 MSK' });
  assert.equal(r.clean, 'Pre-planning — 2026-09-07');
  assert.equal(r.isGeneric, false);
});

test('recordingName: без folderName (старая схема) — как cleanMeetName', () => {
  assert.deepEqual(recordingName({ name: 'bbb-tupg-phm (2026-05-26 20:02 GMT+2)' }), cleanMeetName('bbb-tupg-phm (2026-05-26 20:02 GMT+2)'));
});

test('collectRecordings: ownedOnly — «me in owners» в запросах корней и медиа, ярлыки не берутся', async () => {
  const queries = [];
  const inner = mockDrive({
    roots: [{ id: 'f1', name: 'Meet Recordings' }],
    media: [
      rec('own', 'f1', '2026-09-12T10:00:00Z', { owners: [{ emailAddress: 'thegrowglobal.pro@gmail.com' }] }),
      { id: 'sc', name: 'Shortcut', createdTime: '2026-09-12T09:00:00Z', mimeType: SHORTCUT, parents: ['f1'],
        shortcutDetails: { targetId: 'T', targetMimeType: 'video/mp4' } },
    ],
    targets: { T: { id: 'T', name: 'Target', mimeType: 'video/mp4', createdTime: '2026-09-12T08:00:00Z' } },
  });
  const drive = { files: { ...inner.files, list: async (args) => { queries.push(args.q); return inner.files.list(args); } } };

  const { files } = await collectRecordings(drive, 500, { ownedOnly: true });
  assert.deepEqual(files.map(f => f.id), ['own'], 'ярлык отброшен, даже если цель доступна');
  const rootQ = queries.find(q => q.includes("name = 'Google Meet'"));
  const mediaQ = queries.find(q => q.includes("mimeType contains 'video/'"));
  assert.ok(rootQ.includes("'me' in owners"), 'корни — только свои');
  assert.ok(mediaQ.includes("'me' in owners"), 'медиа — только свои');
  assert.ok(!mediaQ.includes('shortcut'), 'ярлыки не запрашиваются');
});

test('collectRecordings: rootIds — явный корень по ID добавляется к найденным по имени (дубль по id — один раз)', async () => {
  const gets = [];
  const drive = mockDrive({
    roots: [{ id: 'gm', name: 'Google Meet' }],
    subs: { cfg: [{ id: 'm1', name: 'Planning - 2026/09/12 10:00 CEST' }] },
    media: [rec('a', 'gm', '2026-09-12T10:00:00Z'), rec('b', 'm1', '2026-09-12T09:00:00Z'), rec('c', 'elsewhere', '2026-09-12T08:00:00Z')],
    targets: { cfg: { id: 'cfg', name: 'Inbox (renamed)' } },
    gets,
  });

  const { files, roots } = await collectRecordings(drive, 500, { rootIds: ['cfg', 'gm', ''] });
  assert.deepEqual(roots.map(r => r.id), ['gm', 'cfg']);
  assert.deepEqual(gets, ['cfg'], 'files.get только для корня, которого нет среди найденных');
  assert.deepEqual(files.map(f => f.id), ['a', 'b']);
  assert.equal(files[1].folderName, 'Planning - 2026/09/12 10:00 CEST');
});

test('collectRecordings: rootIds — недоступный ID пробрасывает ошибку (неверная настройка)', async () => {
  const drive = mockDrive({ roots: [], media: [] });
  await assert.rejects(() => collectRecordings(drive, 500, { rootIds: ['missing'] }), /404/);
});

test('collectRecordings: rootIds: null — как «без явных корней»', async () => {
  const drive = mockDrive({ roots: [], media: [rec('a', 'x', '2026-09-12T10:00:00Z')] });
  const { files } = await collectRecordings(drive, 500, { rootIds: null });
  assert.deepEqual(files.map(f => f.id), ['a']);
});

test('collectRecordings: account — владелец файла; у ярлыка — владелец цели; без owners — пусто', async () => {
  const drive = mockDrive({
    roots: [{ id: 'f1', name: 'Meet Recordings' }],
    media: [
      rec('own', 'f1', '2026-09-12T10:00:00Z', { owners: [{ emailAddress: 'londeren@gmail.com' }] }),
      { id: 'sc', name: 'Shortcut', createdTime: '2026-09-12T09:00:00Z', mimeType: SHORTCUT, parents: ['f1'],
        owners: [{ emailAddress: 'participant@gmail.com' }], shortcutDetails: { targetId: 'T', targetMimeType: 'video/mp4' } },
      rec('shared-drive', 'f1', '2026-09-12T08:00:00Z'),
    ],
    targets: { T: { id: 'T', name: 'Target', size: '1', createdTime: '2026-09-12T07:00:00Z', mimeType: 'video/mp4', owners: [{ emailAddress: 'host@company.com' }] } },
  });

  const { files } = await collectRecordings(drive, 500);
  // Порядок — по createdTime desc, у ярлыка это дата ЦЕЛИ (07:00, самая старая).
  assert.deepEqual(files.map(f => [f.id, f.account]), [['own', 'londeren'], ['shared-drive', ''], ['T', 'host@company.com']]);
});

test('accountLabel: gmail — имя ящика, домен — весь адрес, пусто — пусто', () => {
  assert.equal(accountLabel('Londeren@gmail.com'), 'londeren');
  assert.equal(accountLabel('thegrowglobal.pro@googlemail.com'), 'thegrowglobal.pro');
  assert.equal(accountLabel('vadim@company.com'), 'vadim@company.com');
  assert.equal(accountLabel(undefined), '');
});

test('describeCounts: считает в порядке первого появления', () => {
  assert.equal(describeCounts(['londeren', 'grow', 'londeren']), 'londeren ×2, grow ×1');
  assert.equal(describeCounts([]), '');
});

test('describeRoots: группирует по имени', () => {
  assert.equal(
    describeRoots([{ name: 'Google Meet' }, { name: 'Meet Recordings' }, { name: 'Meet Recordings' }]),
    'Google Meet ×1, Meet Recordings ×2'
  );
  assert.equal(describeRoots([]), '');
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
