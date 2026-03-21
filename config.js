import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.transcribe');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

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