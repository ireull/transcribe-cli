import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions, checkForUpdate } from '../upgrade.js';

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

const registryRes = (latest) => ({
  ok: true,
  json: async () => ({ 'dist-tags': { latest } }),
});

test('compareVersions сравнивает semver численно', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.16.1', '1.17.0') < 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.0-rc1', '1.2.0'), 0);
});

test('checkForUpdate возвращает hasUpdate=true для версии новее текущей', async () => {
  globalThis.fetch = async () => registryRes('999.0.0');
  const info = await checkForUpdate();
  assert.equal(info.hasUpdate, true);
  assert.equal(info.latest, '999.0.0');
});

test('checkForUpdate возвращает hasUpdate=false для той же или старшей текущей версии', async () => {
  globalThis.fetch = async () => registryRes('0.0.1');
  const info = await checkForUpdate();
  assert.equal(info.hasUpdate, false);
  assert.equal(info.latest, '0.0.1');
});

test('checkForUpdate не бросает, если fetch падает', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const info = await checkForUpdate();
  assert.ok(info);
  assert.equal(info.latest, null);
  assert.equal(info.hasUpdate, false);
});
