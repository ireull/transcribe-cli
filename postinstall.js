#!/usr/bin/env node

/**
 * postinstall — при npm i -g:
 *   1) копирует service-account.json из исходной директории в папку установки;
 *   2) записывает маркер install-source.json, чтобы `transcribe upgrade`
 *      знал, откуда тянуть обновления.
 */

import { existsSync, copyFileSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const INSTALL_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET = join(INSTALL_DIR, 'service-account.json');

// INIT_CWD — папка откуда запущен npm install (т.е. корень исходников)
const sourceDir = process.env.INIT_CWD || process.cwd();

// ─── service-account.json ────────────────────────────────────────────

if (existsSync(TARGET)) {
  console.log('[transcribe] service-account.json на месте.');
} else {
  const SOURCE = join(sourceDir, 'service-account.json');
  if (existsSync(SOURCE)) {
    try {
      copyFileSync(SOURCE, TARGET);
      console.log(`[transcribe] service-account.json → ${INSTALL_DIR}`);
    } catch (e) {
      console.log(`[transcribe] Не удалось скопировать: ${e.message}`);
    }
  } else {
    console.log('[transcribe] service-account.json не найден — пропускаю.');
    console.log('[transcribe] Добавить позже: transcribe → настройки → SA-ключ');
  }
}

// ─── install-source marker (для `transcribe upgrade`) ────────────────

// Записываем маркер, только если INIT_CWD действительно выглядит как исходники
// transcribe-cli. Иначе при установке из чужого tgz мы бы записали мусор.
try {
  const pkgPath = join(sourceDir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (pkg.name === 'transcribe-cli') {
      const CONFIG_DIR = join(homedir(), '.transcribe');
      const MARKER = join(CONFIG_DIR, 'install-source.json');
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(MARKER, JSON.stringify({
        path: sourceDir,
        version: pkg.version,
        installedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
      console.log(`[transcribe] install source: ${sourceDir}`);
    }
  }
} catch {
  // non-fatal — upgrade просто не сработает, руками всегда можно переустановить
}
