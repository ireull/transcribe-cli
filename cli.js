#!/usr/bin/env node

import { platform } from 'os';
import { execSync } from 'child_process';

// Windows: переключаем кодовую страницу консоли на UTF-8
if (platform() === 'win32') {
  try { execSync('chcp 65001', { stdio: 'ignore' }); } catch {}
}

const { cli } = await import('./app.js');
cli();