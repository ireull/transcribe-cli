import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Важно: задаём XDG_CONFIG_HOME ДО импорта config.js — он вычисляет путь к
// конфигу на этапе загрузки модуля. Так тесты не трогают реальный ~/.config.
const TMP = mkdtempSync(join(tmpdir(), 'tc-cfg-'));
process.env.XDG_CONFIG_HOME = TMP;
const { loadConfig, saveConfig, CONFIG_PATH } = await import('../config.js');

test('loadConfig: дефолты при отсутствии файла', () => {
  rmSync(CONFIG_PATH, { force: true });
  const cfg = loadConfig();
  assert.equal(cfg.autoLang, true);
  assert.equal(cfg.speakers, true);
  assert.equal(cfg.mergeUtterances, true);
  assert.equal(cfg.numerals, true);
  assert.equal(cfg.summaryEnabled, false);
  assert.equal(cfg.summaryModel, 'gemini-3.5-flash');
});

test('saveConfig → loadConfig: round-trip', () => {
  const cfg = loadConfig();
  cfg.apiKey = 'dg-test';
  cfg.summaryEnabled = true;
  saveConfig(cfg);
  const back = loadConfig();
  assert.equal(back.apiKey, 'dg-test');
  assert.equal(back.summaryEnabled, true);
});

test('loadConfig: старый конфиг без новых полей получает дефолты (merge)', () => {
  // Эмулируем конфиг со старой схемой — только apiKey.
  writeFileSync(CONFIG_PATH, JSON.stringify({ apiKey: 'old' }), 'utf-8');
  const cfg = loadConfig();
  assert.equal(cfg.apiKey, 'old');          // сохранённое осталось
  assert.equal(cfg.autoLang, true);          // новое поле — из DEFAULTS
  assert.equal(cfg.summaryModel, 'gemini-3.5-flash');
});

test('loadConfig: миграция старой OpenRouter-модели → Gemini-дефолт', () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ summaryModel: 'qwen/qwen3-8b:free' }), 'utf-8');
  const cfg = loadConfig();
  assert.equal(cfg.summaryModel, 'gemini-3.5-flash');  // слаг с "/" сброшен на дефолт
});

test('loadConfig: битый JSON → дефолты, .bak и предупреждение', () => {
  writeFileSync(CONFIG_PATH, '{ это не json', 'utf-8');
  let warning = '';
  const orig = console.error;
  console.error = (msg) => { warning += msg; };
  try {
    const cfg = loadConfig();
    assert.equal(cfg.autoLang, true);
  } finally {
    console.error = orig;
  }
  assert.equal(existsSync(`${CONFIG_PATH}.bak`), true);
  assert.equal(readFileSync(`${CONFIG_PATH}.bak`, 'utf-8'), '{ это не json');
  assert.match(warning, /Конфиг повреждён/);
  assert.match(warning, /\.bak/);
});

test('saveConfig: атомарная запись создаёт файл с mode 0600', () => {
  rmSync(CONFIG_PATH, { force: true });
  saveConfig({ ...loadConfig(), apiKey: 'atomic' });
  const back = loadConfig();
  assert.equal(back.apiKey, 'atomic');
  assert.equal(statSync(CONFIG_PATH).mode & 0o777, 0o600);
  const leftovers = readdirSync(join(TMP, 'transcribe-cli')).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test.after(() => rmSync(TMP, { recursive: true, force: true }));
