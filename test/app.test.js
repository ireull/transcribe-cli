import { test } from 'node:test';
import assert from 'node:assert/strict';

import { optionsFromConfig, quickModeMerge } from '../app.js';

// Опции перед запуском больше не спрашиваются — runTranscription получает их
// из конфига через optionsFromConfig. Семантика: отсутствие ключа = вкл
// (только явный false выключает), язык по умолчанию ru.

test('optionsFromConfig: пустой конфиг → все опции включены, язык ru', () => {
  assert.deepEqual(optionsFromConfig({}), {
    speakers: true,
    merge: true,
    numerals: true,
    autoLang: true,
    lang: 'ru',
  });
});

test('optionsFromConfig: явный false выключает каждую опцию', () => {
  const opts = optionsFromConfig({
    speakers: false,
    mergeUtterances: false,
    numerals: false,
    autoLang: false,
  });
  assert.equal(opts.speakers, false);
  assert.equal(opts.merge, false);
  assert.equal(opts.numerals, false);
  assert.equal(opts.autoLang, false);
});

test('optionsFromConfig: язык берётся из конфига при выключенном авто', () => {
  const opts = optionsFromConfig({ autoLang: false, lang: 'en' });
  assert.equal(opts.autoLang, false);
  assert.equal(opts.lang, 'en');
});

test('optionsFromConfig: не-boolean мусор не выключает опции (truthy ≠ false)', () => {
  const opts = optionsFromConfig({ speakers: 1, mergeUtterances: 'yes' });
  assert.equal(opts.speakers, true);
  assert.equal(opts.merge, true);
});

// Быстрый режим: склейка из конфига, но --no-merge ее выключает при любом конфиге.

test('quickModeMerge: без флага склейка берётся из конфига', () => {
  assert.equal(quickModeMerge(['voice.oga'], {}), true);
  assert.equal(quickModeMerge(['voice.oga'], { mergeUtterances: false }), false);
});

test('quickModeMerge: --no-merge выключает склейку, даже если она включена в конфиге', () => {
  assert.equal(quickModeMerge(['voice.oga', '-s', '--no-merge'], {}), false);
  assert.equal(quickModeMerge(['voice.oga', '--no-merge'], { mergeUtterances: true }), false);
});
