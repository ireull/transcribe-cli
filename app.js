import { select, confirm, input } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, basename, resolve } from 'path';
import { execSync } from 'child_process';

import { loadConfig, saveConfig, CONFIG_PATH } from './config.js';
import { pickFile, pickFiles, pickFolder, pickJsonFile } from './dialogs.js';
import { createShortcut, removeShortcut, shortcutExists } from './shortcut.js';
import { runTranscription, isUrl, makeTmp, cleanTmp, formatTs } from './transcribe.js';
import { hasSaKey, getSaKeyPath, importSaKey, getMeetRecordings, downloadFile, formatSize, formatDate } from './gdrive.js';

// ─── Переименование спикеров ────────────────────────────────────────

async function askSpeakerNames(previews) {
  console.log();
  console.log(chalk.cyan('  Найдены спикеры:'));
  for (const { id, lines } of previews) {
    console.log();
    console.log(`  ${chalk.bold(`Speaker ${id}:`)}`);
    for (const { text, start } of lines) {
      console.log(`    ${chalk.dim(`[${formatTs(start)}]`)} ${text}`);
    }
  }
  console.log();

  const wantRename = await confirm({ message: 'Переименовать спикеров?', default: true });
  if (!wantRename) return {};

  const names = {};
  for (const { id, lines } of previews) {
    const hint = lines[0]?.text.slice(0, 60) || '';
    const name = await input({
      message: `Speaker ${id} → (${hint}...):`,
      default: `Speaker ${id}`,
    });
    if (name.trim() && name.trim() !== `Speaker ${id}`) {
      names[id] = name.trim();
    }
  }
  return names;
}

// ─── Обработка ошибки ключа Deepgram ────────────────────────────────

async function handleDeepgramAuthError(cfg) {
  console.log();
  console.log(chalk.yellow('  Ключ Deepgram невалидный или закончился.'));
  const action = await select({
    message: 'Что делаем?',
    choices: [
      { name: '🔑  Ввести новый ключ', value: 'new' },
      { name: '↩️   Назад', value: 'back' },
    ],
  });
  if (action === 'new') {
    const k = await input({ message: 'Новый API-ключ Deepgram:' });
    if (k.trim()) {
      cfg.apiKey = k.trim();
      saveConfig(cfg);
      console.log(chalk.green('  Сохранено. Попробуйте снова.'));
      return k.trim();
    }
  }
  return null;
}

// ─── UI ─────────────────────────────────────────────────────────────

function showHeader() {
  console.log();
  console.log(chalk.cyan('  ╭────────────────────────────────╮'));
  console.log(chalk.cyan('  │') + chalk.bold.cyan('  transcribe') + chalk.cyan('                    │'));
  console.log(chalk.cyan('  │') + chalk.dim('  Deepgram + yt-dlp + ffmpeg') + chalk.cyan('    │'));
  console.log(chalk.cyan('  ╰────────────────────────────────╯'));
  console.log();
}

function shorten(p, max = 50) {
  if (!p || p.length <= max) return p || '';
  const parts = p.split(/[/\\]/);
  return parts.length <= 3 ? p : parts[0] + '/.../' + parts.slice(-2).join('/');
}

// ─── Первый запуск ──────────────────────────────────────────────────

async function firstRunSetup(cfg) {
  if (cfg.shortcutOffered) return;
  cfg.shortcutOffered = true;
  saveConfig(cfg);
  console.log();
  const want = await confirm({ message: 'Добавить ярлык на рабочий стол?', default: true });
  if (want) createShortcut();
  else console.log(chalk.dim('  Ок. Позже: настройки → ярлык, или transcribe --install-shortcut'));
  console.log();
}

// ─── Проверки ───────────────────────────────────────────────────────

async function ensureApiKey(cfg) {
  let key = cfg.apiKey || process.env.DEEPGRAM_API_KEY || '';
  if (!key) {
    console.log(chalk.yellow('DEEPGRAM_API_KEY не найден.'));
    key = await input({ message: 'Введите API-ключ Deepgram:' });
    if (!key.trim()) { console.log(chalk.red('Ключ не может быть пустым.')); process.exit(1); }
    cfg.apiKey = key.trim();
    saveConfig(cfg);
    console.log(chalk.green('Ключ сохранен.'));
  }
  return key.trim();
}

// ─── Опции ──────────────────────────────────────────────────────────

async function askOptions(cfg) {
  let lang = await select({
    message: 'Язык аудио',
    choices: [
      { name: '🇷🇺  Русский', value: 'ru' },
      { name: '🇬🇧  English', value: 'en' },
      { name: '🇩🇪  Deutsch', value: 'de' },
      { name: '🇪🇸  Espanol', value: 'es' },
      { name: '🇫🇷  Francais', value: 'fr' },
      { name: '🌐  Другой', value: 'other' },
    ],
    default: cfg.lang || 'ru',
  });
  if (lang === 'other') lang = await input({ message: 'Код языка (BCP-47):', default: 'ru' });

  const speakers = await confirm({ message: 'Разделять спикеров?', default: cfg.speakers ?? true });
  cfg.lang = lang; cfg.speakers = speakers; saveConfig(cfg);
  return { lang, speakers };
}

async function askOutputDir(cfg, defaultDir, label = 'Рядом с файлом') {
  const last = cfg.lastOutputDir || '';
  const choices = [
    { name: `📂  ${label}: ${shorten(defaultDir)}`, value: 'source' },
  ];
  if (last && last !== defaultDir && existsSync(last))
    choices.push({ name: `📂  Прошлая папка: ${shorten(last)}`, value: 'last' });
  choices.push({ name: '📂  Выбрать другую...', value: 'pick' });

  const choice = await select({ message: 'Куда сохранить?', choices, default: 'source' });

  let dir;
  if (choice === 'source') dir = defaultDir;
  else if (choice === 'last') dir = last;
  else {
    console.log(chalk.dim('  Открываю диалог...'));
    dir = pickFolder(defaultDir);
    if (!dir) { console.log(chalk.yellow('  Отменено, рядом с файлом.')); dir = defaultDir; }
  }
  cfg.lastOutputDir = dir; saveConfig(cfg);
  return dir;
}

// ─── Режимы ─────────────────────────────────────────────────────────

async function runFileMode(apiKey, lang, speakers, cfg) {
  console.log(chalk.dim('  Открываю диалог выбора файла...'));
  const filePath = pickFile(cfg.lastOpenDir || homedir());
  if (!filePath) { console.log(chalk.yellow('  Отменено.')); return; }

  if (!existsSync(filePath)) {
    console.log(chalk.red(`  Файл не найден: ${filePath}`));
    console.log(chalk.dim('  Возможно проблема с кодировкой пути. Попробуйте переименовать файл без кириллицы.'));
    return;
  }

  cfg.lastOpenDir = dirname(filePath); saveConfig(cfg);
  const mb = (statSync(filePath).size / 1048576).toFixed(1);
  console.log(`  ${chalk.bold(basename(filePath))} ${chalk.dim(`(${mb} MB)`)}`);

  const outputDir = await askOutputDir(cfg, dirname(filePath));
  console.log();
  await runTranscription(filePath, { speakers, lang, apiKey, outputDir, onSpeakers: speakers ? askSpeakerNames : undefined });
}

async function runBatchMode(apiKey, lang, speakers, cfg) {
  console.log(chalk.dim('  Выберите файлы (Ctrl/Cmd+клик)...'));
  const files = pickFiles(cfg.lastOpenDir || homedir());
  if (!files.length) { console.log(chalk.yellow('  Отменено.')); return; }

  cfg.lastOpenDir = dirname(files[0]); saveConfig(cfg);
  console.log(`  ${chalk.bold(`Файлов: ${files.length}`)}`);
  for (const f of files) console.log(`    ${basename(f)}`);

  const outputDir = await askOutputDir(cfg, dirname(files[0]));
  console.log();
  for (let i = 0; i < files.length; i++) {
    console.log(chalk.cyan(`── [${i+1}/${files.length}] ${basename(files[i])} ──`));
    try { await runTranscription(files[i], { speakers, lang, apiKey, outputDir, onSpeakers: speakers ? askSpeakerNames : undefined }); }
    catch (e) { console.log(chalk.red(`  Ошибка: ${e.message}`)); }
  }
}

async function runUrlMode(apiKey, lang, speakers, cfg) {
  const url = await input({ message: 'Вставьте ссылку:' });
  if (!isUrl(url)) { console.log(chalk.red('  Нужна ссылка http(s)://')); return; }
  const outputDir = await askOutputDir(cfg, cfg.lastOutputDir || homedir());
  console.log();
  await runTranscription(url.trim(), { speakers, lang, apiKey, outputDir, onSpeakers: speakers ? askSpeakerNames : undefined });
}

async function runMeetMode(apiKey, cfg) {
  // Проверка SA-ключа — если нет, предлагаем импортировать
  if (!hasSaKey()) {
    console.log();
    console.log(chalk.yellow('  SA-ключ не найден.'));
    console.log();

    const action = await select({
      message: 'Что делаем?',
      choices: [
        { name: '📂  Выбрать service-account.json', value: 'pick' },
        { name: '📋  Показать инструкцию', value: 'help' },
        { name: '↩️   Назад', value: 'back' },
      ],
    });

    if (action === 'back') return;

    if (action === 'help') {
      console.log();
      console.log(chalk.dim('  1. Google Cloud Console → создать проект'));
      console.log(chalk.dim('  2. Включить Google Drive API'));
      console.log(chalk.dim('  3. IAM → Service Accounts → создать SA'));
      console.log(chalk.dim('  4. Скачать JSON-ключ'));
      console.log(chalk.dim('  5. Расшарить папку Meet Recordings на email SA'));
      console.log(chalk.dim('  6. Затем: transcribe → Meet → выбрать файл ключа'));
      console.log();
      return;
    }

    if (action === 'pick') {
      console.log(chalk.dim('  Открываю диалог...'));
      const keyFile = pickJsonFile(homedir());
      if (!keyFile) {
        console.log(chalk.yellow('  Отменено.'));
        return;
      }

      const result = importSaKey(keyFile);
      if (!result.ok) {
        console.log(chalk.red(`  Ошибка: ${result.error}`));
        return;
      }

      console.log(chalk.green(`  ✓ SA-ключ установлен (${result.email})`));
      console.log(chalk.dim(`    Скопирован в: ${getSaKeyPath()}`));
      console.log(chalk.dim(`    Расшарьте папку Meet Recordings на: ${result.email}`));
      console.log();
      // Не return — продолжаем к списку записей
    }
  }

  console.log();
  const spinner = ora({ text: chalk.cyan('Загружаю список записей...'), spinner: 'dots' }).start();

  let drive, files;
  try {
    ({ drive, files } = await getMeetRecordings(20));
    spinner.succeed(`Найдено записей: ${files.length}`);
  } catch (e) {
    spinner.fail(chalk.red(`Ошибка: ${e.message}`));
    return;
  }

  if (files.length === 0) {
    console.log(chalk.yellow('  Записей не найдено. Проверьте, расшарена ли папка на SA.'));
    return;
  }

  // Показываем список для выбора
  const choices = files.map(f => ({
    name: `${f.name}  ${chalk.dim(`(${formatSize(f.size)}, ${formatDate(f.createdTime)})`)}`,
    value: f.id,
  }));
  choices.push({ name: chalk.dim('↩️  Назад'), value: 'back' });

  const selectedId = await select({ message: 'Какую запись транскрибировать?', choices });
  if (selectedId === 'back') return;

  const selectedFile = files.find(f => f.id === selectedId);
  if (!selectedFile) return;

  // Опции транскрипции
  const { lang, speakers } = await askOptions(cfg);

  // Куда сохранить
  const outputDir = await askOutputDir(cfg, cfg.lastOutputDir || homedir(), 'Домашняя папка');

  // Скачиваем во временную папку
  const tmpDir = makeTmp();

  try {
    const filePath = await downloadFile(drive, selectedFile.id, selectedFile.name, tmpDir);
    console.log();
    await runTranscription(filePath, { speakers, lang, apiKey, outputDir, onSpeakers: speakers ? askSpeakerNames : undefined });
  } catch (e) {
    console.log(chalk.red(`  Ошибка: ${e.message}`));
  } finally {
    cleanTmp(tmpDir);
  }
}

// ─── Настройки ──────────────────────────────────────────────────────

async function editSettings(cfg) {
  console.log();
  const hasShortcut = shortcutExists();
  const action = await select({
    message: 'Настройки',
    choices: [
      { name: '🔑  Изменить API-ключ', value: 'key' },
      { name: hasSaKey() ? '🔄  Заменить SA-ключ (Google Drive)' : '📂  Добавить SA-ключ (Google Drive)', value: 'sa' },
      { name: '📂  Сменить папку', value: 'dir' },
      { name: hasShortcut ? '🗑️   Удалить ярлык' : '🖥️   Добавить ярлык', value: 'shortcut' },
      { name: '🔍  Показать текущие', value: 'show' },
      { name: '↩️   Назад', value: 'back' },
    ],
  });

  if (action === 'back') return;
  if (action === 'key') {
    const k = await input({ message: 'Новый API-ключ:' });
    if (k.trim()) { cfg.apiKey = k.trim(); saveConfig(cfg); console.log(chalk.green('  Сохранено.')); }
  } else if (action === 'sa') {
    console.log(chalk.dim('  Выберите service-account.json...'));
    const keyFile = pickJsonFile(homedir());
    if (!keyFile) { console.log(chalk.yellow('  Отменено.')); }
    else {
      const result = importSaKey(keyFile);
      if (result.ok) {
        console.log(chalk.green(`  ✓ SA-ключ установлен (${result.email})`));
        console.log(chalk.dim(`    Расшарьте папку Meet Recordings на: ${result.email}`));
      } else {
        console.log(chalk.red(`  Ошибка: ${result.error}`));
      }
    }
  } else if (action === 'dir') {
    console.log(chalk.dim('  Открываю диалог...'));
    const p = pickFolder(cfg.lastOutputDir || '');
    if (p) { cfg.lastOutputDir = p; saveConfig(cfg); console.log(chalk.green(`  Папка: ${p}`)); }
  } else if (action === 'shortcut') {
    if (hasShortcut) removeShortcut() ? console.log(chalk.green('  Удален.')) : console.log(chalk.yellow('  Не найден.'));
    else createShortcut();
  } else if (action === 'show') {
    const key = cfg.apiKey || process.env.DEEPGRAM_API_KEY || '';
    const masked = key.length > 10 ? key.slice(0,6) + '...' + key.slice(-4) : key ? '***' : '';
    const has = n => { try { execSync(`${process.platform==='win32'?'where':'which'} ${n}`,{stdio:'pipe'}); return true; } catch { return false; } };
    console.log();
    console.log(chalk.cyan('  ┌─ Окружение ─────────────────────'));
    console.log(chalk.cyan('  │') + ` API-ключ:  ${key ? chalk.green('✓')+' '+masked : chalk.red('✗ не задан')}`);
    console.log(chalk.cyan('  │') + ` Язык:      ${cfg.lang||'ru'}`);
    console.log(chalk.cyan('  │') + ` Спикеры:   ${cfg.speakers?'да':'нет'}`);
    console.log(chalk.cyan('  │') + ` Папка:     ${cfg.lastOutputDir||chalk.dim('рядом с файлом')}`);
    console.log(chalk.cyan('  │') + ` Ярлык:     ${shortcutExists()?chalk.green('✓ есть'):chalk.dim('нет')}`);
    console.log(chalk.cyan('  │') + ` SA-ключ:   ${hasSaKey()?chalk.green('✓')+' '+getSaKeyPath():chalk.dim('нет')}`);
    console.log(chalk.cyan('  │') + ` ffmpeg:    ${has('ffmpeg')?chalk.green('✓'):chalk.red('✗')}`);
    console.log(chalk.cyan('  │') + ` yt-dlp:    ${has('yt-dlp')?chalk.green('✓'):chalk.red('✗')}`);
    console.log(chalk.cyan('  │') + ` Конфиг:    ${CONFIG_PATH}`);
    console.log(chalk.cyan('  └──────────────────────────────────'));
  }
  console.log();
}

// ─── Главное меню ───────────────────────────────────────────────────

async function interactiveMenu() {
  showHeader();
  const cfg = loadConfig();
  let apiKey = await ensureApiKey(cfg);
  await firstRunSetup(cfg);

  while (true) {
    console.clear();
    showHeader();

    const choices = [
      { name: '📁  Файл → транскрипт', value: 'file' },
      { name: '📁  Несколько файлов (batch)', value: 'batch' },
      { name: '🔗  Ссылка → транскрипт', value: 'url' },
      { name: '📹  Google Meet → транскрипт', value: 'meet' },
      { name: '⚙️   Настройки', value: 'settings' },
      { name: '👋  Выход', value: 'exit' },
    ];

    const mode = await select({ message: 'Что делаем?', choices });

    if (mode === 'exit') { console.log(chalk.dim('  Пока!')); break; }
    if (mode === 'settings') { await editSettings(cfg); continue; }

    try {
      if (mode === 'meet') {
        await runMeetMode(apiKey, cfg);
      } else {
        const { lang, speakers } = await askOptions(cfg);
        if (mode === 'file') await runFileMode(apiKey, lang, speakers, cfg);
        else if (mode === 'batch') await runBatchMode(apiKey, lang, speakers, cfg);
        else if (mode === 'url') await runUrlMode(apiKey, lang, speakers, cfg);
      }
    } catch (e) {
      if (e.isAuthError) {
        const newKey = await handleDeepgramAuthError(cfg);
        if (newKey) apiKey = newKey;
        continue;
      }
      throw e;
    }

    console.log();
    if (!(await confirm({ message: 'Еще?', default: true }))) { console.log(chalk.dim('  Пока!')); break; }
    console.log();
  }
}

// ─── CLI ────────────────────────────────────────────────────────────

export async function cli() {
  const args = process.argv.slice(2);

  if (args.includes('--install-shortcut')) { showHeader(); createShortcut(); return; }
  if (args.includes('--remove-shortcut')) { showHeader(); removeShortcut() ? console.log(chalk.green('Удален.')) : console.log(chalk.yellow('Не найден.')); return; }

  const source = args.find(a => !a.startsWith('-'));
  if (!source) { await interactiveMenu(); return; }

  // Быстрый режим
  showHeader();
  const cfg = loadConfig();
  const apiKey = getFlag(args, '--api-key') || cfg.apiKey || process.env.DEEPGRAM_API_KEY || '';
  if (!apiKey) { console.log(chalk.red('Нужен DEEPGRAM_API_KEY.')); process.exit(1); }

  const lang = getFlag(args, '-l') || getFlag(args, '--lang') || cfg.lang || 'ru';
  const speakers = args.includes('-s') || args.includes('--speakers') || (cfg.speakers ?? true);
  const outputDir = getFlag(args, '-o') || getFlag(args, '--output-dir') || (isUrl(source) ? process.cwd() : dirname(resolve(source)));

  await runTranscription(source, { speakers, lang, apiKey, outputDir });
}

function getFlag(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}