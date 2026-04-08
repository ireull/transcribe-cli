#!/usr/bin/env node

/**
 * postinstall — при npm i -g копирует service-account.json
 * из исходной директории в папку установки пакета, если он там лежит.
 */

import { existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const INSTALL_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET = join(INSTALL_DIR, 'service-account.json');

// Уже на месте
if (existsSync(TARGET)) {
  console.log('[transcribe] service-account.json на месте.');
  process.exit(0);
}

// INIT_CWD — папка откуда запущен npm install. При `npm install -g git+https://...`
// это будет рабочая директория пользователя, а не исходники — так что SA оттуда
// не скопируется, и это нормально (SA добавляется вручную через меню).
const sourceDir = process.env.INIT_CWD || process.cwd();
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
