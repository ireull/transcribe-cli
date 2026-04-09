import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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

// Миграция со старого ~/.transcribe/ на XDG-путь
const OLD_DIR = join(homedir(), '.transcribe');
if (existsSync(OLD_DIR)) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const oldCfg = join(OLD_DIR, 'config.json');
    if (existsSync(oldCfg) && !existsSync(CONFIG_PATH)) {
      copyFileSync(oldCfg, CONFIG_PATH);
    }
    const oldSa = join(OLD_DIR, 'service-account.json');
    const newSa = join(CONFIG_DIR, 'service-account.json');
    if (existsSync(oldSa) && !existsSync(newSa)) {
      copyFileSync(oldSa, newSa);
    }
  } catch {}
}

const DEFAULTS = {
  lang: 'ru',
  speakers: true,
  lastOutputDir: '',
  lastOpenDir: '',
  apiKey: '',
  shortcutOffered: false,
  speakerNames: [],
};

export function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch {}
}
