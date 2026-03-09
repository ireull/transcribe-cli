import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const CONFIG_PATH = join(homedir(), '.transcribe.json');

const DEFAULTS = {
  lang: 'ru',
  speakers: true,
  lastOutputDir: '',
  lastOpenDir: '',
  apiKey: '',
  shortcutOffered: false,
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
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch {}
}
