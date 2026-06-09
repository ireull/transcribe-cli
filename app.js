import { select, input, search, checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, statSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, basename, resolve } from 'path';
import { execSync } from 'child_process';

import { loadConfig, saveConfig, CONFIG_PATH } from './config.js';
import { pickFile, pickFiles, pickFolder, pickJsonFile, openFile, revealFile, copyToClipboard } from './dialogs.js';
import { createShortcut, removeShortcut, shortcutExists } from './shortcut.js';
import { runTranscription, isUrl, makeTmp, cleanTmp, formatTs } from './transcribe.js';
import { hasSaKey, getSaKeyPath, importSaKey, getMeetRecordings, downloadFile, formatSize, formatDate, cleanMeetName, renameDriveFile, driveRenameTarget } from './gdrive.js';
import { summarizeTranscript } from './summarize.js';
import { runUpgrade, checkForUpdate, getInstalledVersion, compareVersions } from './upgrade.js';

// Ctrl+C внутри inquirer-промпта бросает ExitPromptError. Ловим его, чтобы
// трактовать как «назад», а не «убить приложение».
const isExitPrompt = (e) => !!e && (e.name === 'ExitPromptError' || /force closed/i.test(e.message || ''));

// Callback саммари для runTranscription. undefined, если фича выключена или нет ключа —
// тогда транскрипция идёт как раньше, без обращения к Gemini.
function buildSummarizeCb(cfg) {
  if (!cfg.summaryEnabled || !cfg.geminiKey) return undefined;
  return (text) => summarizeTranscript(text, { apiKey: cfg.geminiKey, model: cfg.summaryModel });
}

// ─── Переименование спикеров ────────────────────────────────────────

async function askSpeakerName(speakerId, hint, savedNames) {
  const msg = `Speaker ${speakerId} → (${hint}...):`;
  if (savedNames.length === 0) {
    return input({ message: msg, default: `Speaker ${speakerId}` });
  }
  const choices = savedNames.map(n => ({ name: n, value: n }));
  choices.push({ name: chalk.dim('Ввести вручную...'), value: '__custom__' });
  choices.push({ name: chalk.dim(`Оставить Speaker ${speakerId}`), value: `Speaker ${speakerId}` });
  const picked = await select({ message: msg, choices });
  if (picked === '__custom__') {
    return input({ message: `Speaker ${speakerId} →:`, default: `Speaker ${speakerId}` });
  }
  return picked;
}

async function askSpeakerNames(previews) {
  const cfg = loadConfig();
  const savedNames = cfg.speakerNames || [];

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

  const wantRename = await yesNo('Переименовать спикеров?', true);
  if (!wantRename) return {};

  const names = {};
  for (const { id, lines } of previews) {
    const hint = lines[0]?.text.slice(0, 60) || '';
    const name = await askSpeakerName(id, hint, savedNames);
    if (name.trim() && name.trim() !== `Speaker ${id}`) {
      names[id] = name.trim();
    }
  }
  return names;
}

// ─── Подтверждение числа спикеров (локальная диаризация) ────────────

// Показывает, сколько спикеров поймала диаризация. Если не совпало — просит
// точное число (диаризация пересчитается с подсказкой). 0/Enter = принять.
async function askDiarCount(detected) {
  console.log();
  console.log(chalk.cyan(`  Найдено спикеров: ${chalk.bold(detected)}`));
  if (await yesNo('Столько и есть?', true)) return 0;
  const v = await input({ message: 'Сколько спикеров на самом деле?', default: String(detected) });
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n > 0 && n !== detected) {
    console.log(chalk.dim(`  Пересчитываю на ${n} (это снова займёт время)...`));
    return n;
  }
  return 0;
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
  const ver = getInstalledVersion();
  const v = ver ? ` v${ver}` : '';
  const left = `  transcribe${v}`;
  const pad = ' '.repeat(Math.max(0, 32 - left.length));

  console.log();
  console.log(chalk.cyan('  ╭────────────────────────────────╮'));
  console.log(chalk.cyan('  │') + chalk.bold.cyan('  transcribe') + chalk.dim(v) + pad + chalk.cyan('│'));
  console.log(chalk.cyan('  │') + chalk.dim('  Deepgram + yt-dlp + ffmpeg') + chalk.cyan('    │'));
  console.log(chalk.cyan('  ╰────────────────────────────────╯'));
  console.log();
}

function shorten(p, max = 50) {
  if (!p || p.length <= max) return p || '';
  const parts = p.split(/[/\\]/);
  return parts.length <= 3 ? p : parts[0] + '/.../' + parts.slice(-2).join('/');
}

// Y/N через select со стрелками. @inquirer/confirm требует набора y/n,
// что неудобно на трекпаде и при беглом прохождении меню.
async function yesNo(message, defaultYes = true) {
  return select({
    message,
    choices: [
      { name: 'Да', value: true },
      { name: 'Нет', value: false },
    ],
    default: defaultYes,
  });
}

async function maybeOfferUpdate(cfg) {
  const now = Date.now();
  const current = getInstalledVersion();
  if (!current) return;

  let latest = cfg.updateLatestSeen || '';
  const stale = !cfg.updateLastCheck || (now - cfg.updateLastCheck) > 24 * 60 * 60 * 1000;
  if (stale) {
    const info = await checkForUpdate();
    if (info?.latest) {
      latest = info.latest;
      cfg.updateLastCheck = now;
      cfg.updateLatestSeen = latest;
      saveConfig(cfg);
    }
  }

  if (!latest || compareVersions(latest, current) <= 0) return;
  console.log(chalk.cyan(`  ✨ Доступно обновление ${latest} (у вас ${current}).`));

  let yes;
  try {
    yes = await yesNo('Обновить сейчас?', false);
  } catch (e) {
    if (isExitPrompt(e)) return;
    throw e;
  }
  if (!yes) return;

  const ok = await runUpgrade();
  if (ok) process.exit(0);
}

// ─── Что делать с готовым результатом ───────────────────────────────

// Меню после успешной транскрипции: открыть/показать/скопировать.
// Зациклено, чтобы можно было сделать несколько действий подряд
// (например, скопировать текст И открыть файл) и потом выйти «Дальше».
async function offerPostActions(outPath) {
  while (true) {
    const action = await select({
      message: 'Результат:',
      choices: [
        { name: '📖  Открыть файл', value: 'open' },
        { name: '📂  Показать в папке', value: 'reveal' },
        { name: '📋  Скопировать текст', value: 'copy-text' },
        { name: '🔗  Скопировать путь', value: 'copy-path' },
        { name: '↩️   Дальше', value: 'done' },
      ],
      default: 'done',
    });
    if (action === 'done') return;
    try {
      if (action === 'open') { openFile(outPath); console.log(chalk.dim('  Открываю...')); }
      else if (action === 'reveal') { revealFile(outPath); console.log(chalk.dim('  Открываю папку...')); }
      else if (action === 'copy-text') { copyToClipboard(readFileSync(outPath, 'utf-8')); console.log(chalk.green('  Текст скопирован в буфер.')); }
      else if (action === 'copy-path') { copyToClipboard(outPath); console.log(chalk.green('  Путь скопирован.')); }
    } catch (e) {
      console.log(chalk.yellow(`  Не удалось: ${e.message}`));
    }
  }
}

// Для batch: предложить открыть папку целиком, а не каждый файл.
async function offerOpenFolder(dir) {
  if (await yesNo('Открыть папку с результатами?', false)) {
    try { openFile(dir); } catch (e) { console.log(chalk.yellow(`  Не удалось: ${e.message}`)); }
  }
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

// Опции транскрипции живут в конфиге и редактируются в Настройках
// (editTranscriptionOptions). Перед запуском НЕ спрашиваются — все пользуются
// дефолтами, и промпт на каждый запуск был лишним действием.
// Чистый маппинг cfg → opts для runTranscription (отсутствие ключа = вкл).
export function optionsFromConfig(cfg) {
  return {
    speakers: cfg.speakers !== false,
    merge: cfg.mergeUtterances !== false,
    numerals: cfg.numerals !== false,
    autoLang: cfg.autoLang !== false,
    lang: cfg.lang || 'ru',
  };
}

// Однострочная сводка активных опций — печатается перед запуском, чтобы было
// видно, с чем пойдёт транскрипция, без лишнего промпта.
function optionsSummary(opts) {
  return [
    opts.speakers ? 'спикеры' : 'без спикеров',
    opts.merge ? 'склейка' : 'без склейки',
    opts.numerals ? 'числа цифрами' : 'числа словами',
    opts.autoLang ? 'язык: авто' : `язык: ${opts.lang}`,
  ].join(' · ');
}

// Единый чеклист опций — пункт Настроек. Предзаполнен из конфига.
// Порядок фиксированный: пункты не прыгают при вкл/выкл.
async function editTranscriptionOptions(cfg) {
  const picked = await checkbox({
    message: 'Опции транскрипции (␣ вкл/выкл · ↵ сохранить · ^C назад):',
    choices: [
      { name: 'Разделять спикеров',              value: 'speakers', checked: cfg.speakers !== false },
      { name: 'Склеивать реплики одного спикера', value: 'merge',    checked: cfg.mergeUtterances !== false },
      { name: 'Числа цифрами',                    value: 'numerals', checked: cfg.numerals !== false },
      { name: 'Авто-определение языка',           value: 'autoLang', checked: cfg.autoLang !== false },
    ],
    loop: false,
  });

  const speakers = picked.includes('speakers');
  const merge    = picked.includes('merge');
  const numerals = picked.includes('numerals');
  const autoLang = picked.includes('autoLang');

  // Язык спрашиваем только если автоопределение выключено.
  let lang = cfg.lang || 'ru';
  if (!autoLang) {
    lang = await select({
      message: 'Язык аудио',
      choices: [
        { name: '🇷🇺  Русский', value: 'ru' },
        { name: '🇬🇧  English', value: 'en' },
        { name: '🌐  Другой', value: 'other' },
      ],
      default: cfg.lang && ['ru', 'en'].includes(cfg.lang) ? cfg.lang : 'ru',
    });
    if (lang === 'other') lang = await input({ message: 'Код языка (BCP-47):', default: 'ru' });
  }

  // Применяем и сохраняем только после ВСЕХ промптов: Ctrl+C на любом шаге —
  // чистая отмена (ExitPromptError всплывает в interactiveMenu), cfg не трогаем.
  cfg.speakers = speakers; cfg.mergeUtterances = merge; cfg.numerals = numerals;
  cfg.autoLang = autoLang; cfg.lang = lang;
  saveConfig(cfg);
  console.log(chalk.green(`  Сохранено: ${optionsSummary(optionsFromConfig(cfg))}`));
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

async function runFileMode(apiKey, opts, cfg) {
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
  const out = await runTranscription(filePath, { ...opts, apiKey, outputDir, onSpeakers: opts.speakers ? askSpeakerNames : undefined });
  if (out) await offerPostActions(out);
  return out;
}

async function runBatchMode(apiKey, opts, cfg) {
  console.log(chalk.dim('  Выберите файлы (Ctrl/Cmd+клик)...'));
  const files = pickFiles(cfg.lastOpenDir || homedir());
  if (!files.length) { console.log(chalk.yellow('  Отменено.')); return; }

  cfg.lastOpenDir = dirname(files[0]); saveConfig(cfg);
  console.log(`  ${chalk.bold(`Файлов: ${files.length}`)}`);
  for (const f of files) console.log(`    ${basename(f)}`);

  const outputDir = await askOutputDir(cfg, dirname(files[0]));
  console.log();
  let anyOk = false;
  for (let i = 0; i < files.length; i++) {
    console.log(chalk.cyan(`── [${i+1}/${files.length}] ${basename(files[i])} ──`));
    try { if (await runTranscription(files[i], { ...opts, apiKey, outputDir, onSpeakers: opts.speakers ? askSpeakerNames : undefined })) anyOk = true; }
    catch (e) { console.log(chalk.red(`  Ошибка: ${e.message}`)); }
  }
  if (anyOk) await offerOpenFolder(outputDir);
  return anyOk;
}

async function runUrlMode(apiKey, opts, cfg) {
  const url = await input({ message: 'Вставьте ссылку:' });
  if (!isUrl(url)) { console.log(chalk.red('  Нужна ссылка http(s)://')); return; }
  const outputDir = await askOutputDir(cfg, cfg.lastOutputDir || homedir());
  console.log();
  const out = await runTranscription(url.trim(), { ...opts, apiKey, outputDir, onSpeakers: opts.speakers ? askSpeakerNames : undefined });
  if (out) await offerPostActions(out);
  return out;
}

// Переименование исходной записи на Google Drive в имя транскрипта.
// Срабатывает только для generic-записей (коды встреч) и только с подтверждения.
// Имя берём из готового .md (basename без расширения и без коллизийного _N).
async function maybeRenameDriveSource(drive, file, outPath) {
  const target = driveRenameTarget(outPath, file.name);
  if (!target) return; // имя бессмысленное (саммари выкл) или уже совпадает

  console.log();
  console.log(chalk.cyan(`  Запись на Диске: ${file.name}`));
  if (!(await yesNo(`Переименовать её в «${target}»?`, true))) return;

  const sp = ora({ text: chalk.cyan('Переименовываю на Google Drive...'), spinner: 'dots' }).start();
  try {
    await renameDriveFile(drive, file.id, target);
    sp.succeed(`Переименовано на Диске: ${target}`);
  } catch (e) {
    sp.fail(chalk.yellow(`Не удалось переименовать на Диске: ${e.message}`));
    console.log(chalk.dim('  Нужен доступ «Редактор» у service-account на эту запись (не «Просмотр»).'));
  }
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
    ({ drive, files } = await getMeetRecordings({ write: cfg.renameDriveSource }));
    spinner.succeed(`Найдено записей: ${files.length}`);
  } catch (e) {
    spinner.fail(chalk.red(`Ошибка: ${e.message}`));
    return;
  }

  if (files.length === 0) {
    console.log(chalk.yellow('  Записей не найдено. Проверьте, расшарена ли папка на SA.'));
    return;
  }

  // Поиск с фильтром «по мере ввода»: печатаешь часть названия или даты,
  // список сужается мгновенно (фильтрация локальная, без запросов к Drive).
  // Несколько слов через пробел — все должны встретиться (AND), так что
  // «иван 06» найдёт встречу с Иваном в июне. Пустой ввод — все записи.
  const MAX_SHOWN = 50;
  const BACK = '__back__';
  const labelOf = f => `${f.name}  ${chalk.dim(`(${formatSize(f.size)}, ${formatDate(f.createdTime)})`)}`;
  const hayOf = f => `${f.name} ${formatDate(f.createdTime)}`.toLowerCase();

  const selectedId = await search({
    message: `Найдите запись (${files.length} шт. · печатайте для фильтра · ^C назад):`,
    source: (term) => {
      const tokens = (term || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      const matched = tokens.length
        ? files.filter(f => { const h = hayOf(f); return tokens.every(t => h.includes(t)); })
        : files;

      if (matched.length === 0)
        return [{ name: chalk.dim('Ничего не найдено — ↩️  назад'), value: BACK }];

      const choices = matched.slice(0, MAX_SHOWN).map(f => ({ name: labelOf(f), value: f.id }));
      // Неактивная подпись-индикатор: показывает, что совпадений больше, чем влезло.
      // Не выбирается (disabled) — это не кнопка «показать ещё», а подсказка «сузь запрос».
      if (matched.length > MAX_SHOWN)
        choices.push({ name: `…ещё ${matched.length - MAX_SHOWN} — уточните запрос`, value: '__more__', disabled: true });
      if (!tokens.length)
        choices.push({ name: chalk.dim('↩️  Назад'), value: BACK });
      return choices;
    },
  });
  if (selectedId === BACK) return;

  const selectedFile = files.find(f => f.id === selectedId);
  if (!selectedFile) return;

  // Опции транскрипции — из конфига (менять: Настройки → Опции транскрипции).
  const opts = optionsFromConfig(cfg);
  console.log(chalk.dim(`  Опции: ${optionsSummary(opts)} · менять: Настройки`));
  opts.summarize = buildSummarizeCb(cfg);
  opts.provider = cfg.provider || 'deepgram';
  opts.assemblyKey = cfg.assemblyKey;
  opts.onDiarCount = cfg.provider === 'assembly' ? askDiarCount : undefined;
  // Чистим авто-имя Meet; если оно дефолтное (код встречи) — имя возьмётся из саммари.
  const { clean, isGeneric } = cleanMeetName(selectedFile.name);
  opts.name = clean; opts.nameIsGeneric = isGeneric;

  // Куда сохранить
  const outputDir = await askOutputDir(cfg, cfg.lastOutputDir || homedir(), 'Домашняя папка');

  // Скачиваем во временную папку
  const tmpDir = makeTmp();

  let out = null;
  try {
    const filePath = await downloadFile(drive, selectedFile.id, selectedFile.name, tmpDir);
    console.log();
    out = await runTranscription(filePath, { ...opts, apiKey, outputDir, onSpeakers: opts.speakers ? askSpeakerNames : undefined });
    if (out) {
      if (cfg.renameDriveSource && isGeneric) await maybeRenameDriveSource(drive, selectedFile, out);
      await offerPostActions(out);
    }
  } catch (e) {
    console.log(chalk.red(`  Ошибка: ${e.message}`));
  } finally {
    cleanTmp(tmpDir);
  }
  return out;
}

// ─── Управление списком спикеров ─────────────────────────────────────

async function editSpeakerNames(cfg) {
  if (!cfg.speakerNames) cfg.speakerNames = [];

  while (true) {
    console.log();
    if (cfg.speakerNames.length) {
      console.log(chalk.cyan('  Текущий список:'));
      cfg.speakerNames.forEach((n, i) => console.log(`    ${i + 1}. ${n}`));
    } else {
      console.log(chalk.dim('  Список пуст.'));
    }
    console.log();

    const choices = [
      { name: '➕  Добавить имя', value: 'add' },
    ];
    if (cfg.speakerNames.length) {
      choices.push({ name: '🗑️   Удалить имя', value: 'remove' });
    }
    choices.push({ name: '↩️   Назад', value: 'back' });

    const action = await select({ message: 'Список спикеров', choices });
    if (action === 'back') break;

    if (action === 'add') {
      const name = await input({ message: 'Имя спикера:' });
      if (name.trim()) {
        if (!cfg.speakerNames.includes(name.trim())) {
          cfg.speakerNames.push(name.trim());
          saveConfig(cfg);
          console.log(chalk.green(`  Добавлено: ${name.trim()}`));
        } else {
          console.log(chalk.yellow('  Уже есть в списке.'));
        }
      }
    } else if (action === 'remove') {
      const toRemove = await select({
        message: 'Кого удалить?',
        choices: cfg.speakerNames.map(n => ({ name: n, value: n })),
      });
      cfg.speakerNames = cfg.speakerNames.filter(n => n !== toRemove);
      saveConfig(cfg);
      console.log(chalk.green(`  Удалено: ${toRemove}`));
    }
  }
}

// ─── Настройки авто-саммари ──────────────────────────────────────────

async function editSummarySettings(cfg) {
  const DEFAULT_MODEL = 'gemini-3.5-flash';
  while (true) {
    console.log();
    console.log(chalk.cyan('  Авто-саммари (Google Gemini):'));
    console.log(`    Статус: ${cfg.summaryEnabled ? chalk.green('вкл') : chalk.dim('выкл')}`);
    console.log(`    Ключ:   ${cfg.geminiKey ? chalk.green('✓ задан') : chalk.red('✗ нет')}`);
    console.log(`    Модель: ${cfg.summaryModel || DEFAULT_MODEL}`);
    console.log(chalk.dim('    Ключ бесплатно (без карты): https://aistudio.google.com/app/apikey'));
    console.log();

    const action = await select({
      message: 'Авто-саммари',
      choices: [
        { name: cfg.summaryEnabled ? '🔕  Выключить' : '🔔  Включить', value: 'toggle' },
        { name: '🔑  Ключ Gemini', value: 'key' },
        { name: '🤖  Модель', value: 'model' },
        { name: '↩️   Назад', value: 'back' },
      ],
    });
    if (action === 'back') break;

    if (action === 'toggle') {
      if (!cfg.summaryEnabled && !cfg.geminiKey) {
        console.log(chalk.yellow('  Сначала задайте ключ Gemini.'));
      } else {
        cfg.summaryEnabled = !cfg.summaryEnabled; saveConfig(cfg);
        console.log(chalk.green(`  ${cfg.summaryEnabled ? 'Включено' : 'Выключено'}.`));
      }
    } else if (action === 'key') {
      const k = await input({ message: 'Ключ Gemini (AIza...):' });
      if (k.trim()) { cfg.geminiKey = k.trim(); saveConfig(cfg); console.log(chalk.green('  Сохранено.')); }
    } else if (action === 'model') {
      const m = await select({
        message: 'Модель саммари',
        choices: [
          { name: 'gemini-3.5-flash  (дефолт)', value: 'gemini-3.5-flash' },
          { name: 'gemini-2.5-flash', value: 'gemini-2.5-flash' },
          { name: chalk.dim('Ввести вручную...'), value: '__custom__' },
        ],
        default: cfg.summaryModel || DEFAULT_MODEL,
      });
      let model = m;
      if (m === '__custom__') model = (await input({ message: 'ID модели Gemini:', default: cfg.summaryModel || DEFAULT_MODEL })).trim();
      if (model) { cfg.summaryModel = model; saveConfig(cfg); console.log(chalk.green(`  Модель: ${model}`)); }
    }
  }
}

// ─── Настройки провайдера транскрипции ──────────────────────────────

async function editProviderSettings(cfg) {
  while (true) {
    console.log();
    console.log(chalk.cyan('  Провайдер транскрипции:'));
    console.log(`    Текущий: ${cfg.provider === 'assembly' ? chalk.bold('AssemblyAI') : chalk.bold('Deepgram')}`);
    console.log(`    Ключ AssemblyAI: ${cfg.assemblyKey ? chalk.green('✓ задан') : chalk.dim('нет')}`);
    console.log(chalk.dim('    AssemblyAI: транскрипт + спикеры в облаке, можно задать число спикеров.'));
    console.log(chalk.dim('    Ключ бесплатно (без карты): https://www.assemblyai.com'));
    console.log();

    const action = await select({
      message: 'Провайдер транскрипции',
      choices: [
        { name: `${cfg.provider !== 'assembly' ? '●' : '○'}  Deepgram (по умолчанию)`, value: 'deepgram' },
        { name: `${cfg.provider === 'assembly' ? '●' : '○'}  AssemblyAI (число спикеров, облако)`, value: 'assembly' },
        { name: '🔑  Ключ AssemblyAI', value: 'key' },
        { name: '↩️   Назад', value: 'back' },
      ],
    });
    if (action === 'back') break;

    if (action === 'deepgram') {
      cfg.provider = 'deepgram'; saveConfig(cfg); console.log(chalk.green('  Провайдер: Deepgram'));
    } else if (action === 'assembly') {
      if (!cfg.assemblyKey) { console.log(chalk.yellow('  Сначала задайте ключ AssemblyAI.')); continue; }
      cfg.provider = 'assembly'; saveConfig(cfg);
      console.log(chalk.green('  Провайдер: AssemblyAI'));
      console.log(chalk.dim('  Число спикеров спросит в потоке: «Найдено N — столько и есть?»'));
    } else if (action === 'key') {
      const k = await input({ message: 'Ключ AssemblyAI:' });
      if (k.trim()) { cfg.assemblyKey = k.trim(); saveConfig(cfg); console.log(chalk.green('  Сохранено.')); }
    }
  }
}

// ─── Переименование записей Meet на Диске ───────────────────────────
async function editRenameDriveSetting(cfg) {
  console.log();
  console.log(chalk.dim('  После транскрипции переименовывает ИСХОДНУЮ запись на Google'));
  console.log(chalk.dim('  Drive в имя транскрипта — только записи с дефолтным именем'));
  console.log(chalk.dim('  (код встречи вида abc-defg-hij). Перед каждым — подтверждение.'));
  console.log(chalk.dim('  Требует доступ «Редактор» у service-account на папку Meet'));
  console.log(chalk.dim('  Recordings (расшаренная на «Просмотр» — переименовать не даст).'));
  console.log(chalk.dim('  Лучшие имена выходят при включённом авто-саммари.'));
  console.log();
  const on = await yesNo('Включить переименование записей на Диске?', cfg.renameDriveSource);
  cfg.renameDriveSource = on;
  saveConfig(cfg);
  console.log(chalk.green(`  ${on ? 'Включено' : 'Выключено'}.`));
}

// ─── Настройки ──────────────────────────────────────────────────────

async function editSettings(cfg) {
  console.log();
  const hasShortcut = shortcutExists();
  const action = await select({
    message: 'Настройки',
    choices: [
      { name: '🔑  Изменить API-ключ Deepgram', value: 'key' },
      { name: `☁️   Провайдер транскрипции (${cfg.provider === 'assembly' ? 'AssemblyAI' : 'Deepgram'})`, value: 'provider' },
      { name: '🎚  Опции транскрипции', value: 'options' },
      { name: hasSaKey() ? '🔄  Заменить SA-ключ Google Drive' : '📂  Добавить SA-ключ Google Drive', value: 'sa' },
      { name: `👤  Список спикеров (${(cfg.speakerNames||[]).length})`, value: 'speakers-list' },
      { name: `🧠  Авто-саммари (${cfg.summaryEnabled ? 'вкл' : 'выкл'})`, value: 'summary' },
      { name: `📛  Переименовывать запись Meet на Диске (${cfg.renameDriveSource ? 'вкл' : 'выкл'})`, value: 'rename-drive' },
      { name: '📂  Сменить папку', value: 'dir' },
      { name: hasShortcut ? '🗑️   Удалить ярлык' : '🖥️   Добавить ярлык', value: 'shortcut' },
      { name: '🔄  Обновить transcribe до последней версии', value: 'upgrade' },
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
  } else if (action === 'speakers-list') {
    await editSpeakerNames(cfg);
  } else if (action === 'summary') {
    await editSummarySettings(cfg);
  } else if (action === 'provider') {
    await editProviderSettings(cfg);
  } else if (action === 'options') {
    await editTranscriptionOptions(cfg);
  } else if (action === 'rename-drive') {
    await editRenameDriveSetting(cfg);
  } else if (action === 'dir') {
    console.log(chalk.dim('  Открываю диалог...'));
    const p = pickFolder(cfg.lastOutputDir || '');
    if (p) { cfg.lastOutputDir = p; saveConfig(cfg); console.log(chalk.green(`  Папка: ${p}`)); }
  } else if (action === 'shortcut') {
    if (hasShortcut) removeShortcut() ? console.log(chalk.green('  Удален.')) : console.log(chalk.yellow('  Не найден.'));
    else createShortcut();
  } else if (action === 'upgrade') {
    await runUpgrade();
  } else if (action === 'show') {
    const key = cfg.apiKey || process.env.DEEPGRAM_API_KEY || '';
    const masked = key.length > 10 ? key.slice(0,6) + '...' + key.slice(-4) : key ? '***' : '';
    const has = n => { try { execSync(`${process.platform==='win32'?'where':'which'} ${n}`,{stdio:'pipe'}); return true; } catch { return false; } };
    console.log();
    console.log(chalk.cyan('  ┌─ Окружение ─────────────────────'));
    console.log(chalk.cyan('  │') + ` API-ключ Deepgram:  ${key ? chalk.green('✓')+' '+masked : chalk.red('✗ не задан')}`);
    console.log(chalk.cyan('  │') + ` Провайдер:  ${cfg.provider === 'assembly' ? 'AssemblyAI'+(cfg.assemblyKey?'':chalk.red(' (нет ключа!)')) : 'Deepgram'}`);
    console.log(chalk.cyan('  │') + ` Язык:      ${cfg.autoLang!==false?'авто':(cfg.lang||'ru')}`);
    console.log(chalk.cyan('  │') + ` Спикеры:   ${cfg.speakers!==false?'да':'нет'}`);
    console.log(chalk.cyan('  │') + ` Склейка реплик: ${cfg.mergeUtterances!==false?'да':'нет'}`);
    console.log(chalk.cyan('  │') + ` Числа цифрами:  ${cfg.numerals!==false?'да':'нет'}`);
    console.log(chalk.cyan('  │') + ` Папка:     ${cfg.lastOutputDir||chalk.dim('рядом с файлом')}`);
    console.log(chalk.cyan('  │') + ` Ярлык:     ${shortcutExists()?chalk.green('✓ есть'):chalk.dim('нет')}`);
    console.log(chalk.cyan('  │') + ` SA-ключ Google Drive:   ${hasSaKey()?chalk.green('✓')+' '+getSaKeyPath():chalk.dim('нет')}`);
    console.log(chalk.cyan('  │') + ` Авто-саммари: ${cfg.summaryEnabled?chalk.green('✓ вкл')+chalk.dim(' '+(cfg.summaryModel||'')):chalk.dim('выкл')}${cfg.summaryEnabled&&!cfg.geminiKey?chalk.red(' (нет ключа!)'):''}`);
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
  await maybeOfferUpdate(cfg);
  let apiKey = await ensureApiKey(cfg);

  while (true) {
    console.clear();
    showHeader();

    const choices = [
      { name: '📁  Файл → транскрипт', value: 'file' },
      { name: '📁  Несколько файлов (batch)', value: 'batch' },
      { name: '🔗  Ссылка → транскрипт (Youtube, Vimeo…)', value: 'url' },
      { name: '📹  Google Meet → транскрипт', value: 'meet' },
      { name: '⚙️   Настройки', value: 'settings' },
      { name: '👋  Выход', value: 'exit' },
    ];

    // Ctrl+C в ГЛАВНОМ меню — выход. В под-флоу (ниже) — «назад».
    let mode;
    try {
      mode = await select({ message: 'Что делаем?', choices });
    } catch (e) {
      if (isExitPrompt(e)) break;
      throw e;
    }

    if (mode === 'exit') { break; }

    let produced;
    try {
      if (mode === 'settings') {
        await editSettings(cfg);
        continue;
      }
      if (mode === 'meet') {
        produced = await runMeetMode(apiKey, cfg);
      } else {
        const opts = optionsFromConfig(cfg);
        console.log(chalk.dim(`  Опции: ${optionsSummary(opts)} · менять: Настройки`));
        opts.summarize = buildSummarizeCb(cfg);
        opts.provider = cfg.provider || 'deepgram';
        opts.assemblyKey = cfg.assemblyKey;
        opts.onDiarCount = cfg.provider === 'assembly' ? askDiarCount : undefined;
        if (mode === 'file') produced = await runFileMode(apiKey, opts, cfg);
        else if (mode === 'batch') produced = await runBatchMode(apiKey, opts, cfg);
        else if (mode === 'url') produced = await runUrlMode(apiKey, opts, cfg);
      }
    } catch (e) {
      if (e.isAuthError) {
        const newKey = await handleDeepgramAuthError(cfg);
        if (newKey) apiKey = newKey;
        continue;
      }
      // Ctrl+C на любом шаге под-флоу — не выход, а возврат в меню.
      if (isExitPrompt(e)) { console.log(chalk.dim('\n  ↩ Назад в меню')); continue; }
      throw e;
    }

    // Успех (результат был, пользователь уже взаимодействовал с меню «Результат») —
    // сразу обратно в главное меню, без вопроса «Ещё?». При отмене/ошибке —
    // короткая пауза, чтобы успеть прочитать сообщение до console.clear().
    if (!produced) {
      try { await input({ message: chalk.dim('↵ — в меню') }); }
      catch (e) { if (isExitPrompt(e)) break; throw e; }
    }
  }
}

// ─── CLI ────────────────────────────────────────────────────────────

export async function cli() {
  const args = process.argv.slice(2);

  if (args.includes('--install-shortcut')) { showHeader(); createShortcut(); return; }
  if (args.includes('--remove-shortcut')) { showHeader(); removeShortcut() ? console.log(chalk.green('Удален.')) : console.log(chalk.yellow('Не найден.')); return; }

  const source = args.find(a => !a.startsWith('-'));
  if (source === 'upgrade' || args.includes('--upgrade')) { showHeader(); await runUpgrade(); return; }
  if (!source) { await interactiveMenu(); return; }

  // Быстрый режим
  showHeader();
  const cfg = loadConfig();
  if (cfg.updateLatestSeen && compareVersions(cfg.updateLatestSeen, getInstalledVersion()) > 0) {
    console.log(chalk.dim(`  ✨ Доступно обновление ${cfg.updateLatestSeen} — transcribe upgrade`));
  }
  const apiKey = getFlag(args, '--api-key') || cfg.apiKey || process.env.DEEPGRAM_API_KEY || '';
  if (!apiKey) { console.log(chalk.red('Нужен DEEPGRAM_API_KEY.')); process.exit(1); }

  const lang = getFlag(args, '-l') || getFlag(args, '--lang') || cfg.lang || 'ru';
  const speakers = args.includes('--no-speakers') ? false
    : (args.includes('-s') || args.includes('--speakers') || (cfg.speakers ?? true));
  const outputDir = getFlag(args, '-o') || getFlag(args, '--output-dir') || (isUrl(source) ? process.cwd() : dirname(resolve(source)));

  await runTranscription(source, {
    speakers, lang,
    autoLang: false,                       // быстрый режим — язык явный (флаг/конфиг)
    numerals: cfg.numerals !== false,
    merge: cfg.mergeUtterances !== false,
    apiKey, outputDir,
  });
}

function getFlag(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
