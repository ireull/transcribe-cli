import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

/**
 * XDG-совместимый путь к конфигу: $XDG_CONFIG_HOME/transcribe-cli или
 * ~/.config/transcribe-cli. Держим всё вне пакета, чтобы переживало
 * переустановку и `npm uninstall -g`.
 */
function computeConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'transcribe-cli');
  return join(homedir(), '.config', 'transcribe-cli');
}

export const CONFIG_DIR = computeConfigDir();
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  lang: 'ru',
  autoLang: true,          // detect_language вместо хардкода языка
  speakers: true,
  mergeUtterances: true,   // склеивать подряд идущие реплики одного спикера
  numerals: true,          // числа цифрами (Deepgram numerals)
  lastOutputDir: '',
  lastOpenDir: '',
  apiKey: '',
  speakerNames: [],
  // Авто-саммари через Google Gemini (free-tier). Выкл по умолчанию;
  // включается в Настройках и тогда работает автоматически.
  summaryEnabled: false,
  geminiKey: '',
  summaryModel: 'gemini-3.5-flash',
  // Провайдер транскрипции: deepgram (дефолт) или assembly (AssemblyAI — облако,
  // транскрипт+спикеры в одном вызове, можно задать число спикеров).
  provider: 'deepgram',
  assemblyKey: '',
  // Переименовывать исходную запись на Google Drive в имя транскрипта
  // (только для generic-имён — кодов встреч). Требует Editor-доступа SA
  // и спрашивает подтверждение перед каждым переименованием. По умолчанию выкл.
  renameDriveSource: false,
};

export function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = { ...DEFAULTS, ...JSON.parse(raw) };
    // Миграция: саммари переехало с OpenRouter на Gemini — старый слаг модели
    // (вида "qwen/...:free") на Gemini-эндпоинте даст 404, сбрасываем на дефолт.
    if (typeof cfg.summaryModel === 'string' && cfg.summaryModel.includes('/')) {
      cfg.summaryModel = DEFAULTS.summaryModel;
    }
    return cfg;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    if (e.code === 'EACCES') {
      const dir = e.path ? dirname(e.path) : CONFIG_DIR;
      const cmd = `sudo chown $(whoami) "${dir}"`;
      throw new Error(
        `Нет прав на запись в ${dir}\n\n` +
        `  Выполните в терминале:\n\n` +
        `  >>> ${cmd}\n`
      );
    }
    throw e;
  }
}
