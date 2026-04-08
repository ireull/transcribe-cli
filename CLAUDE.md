# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Запуск и разработка

```bash
node cli.js                      # запуск из исходников (интерактивное меню)
node cli.js <file-or-url>        # быстрый режим без меню
node cli.js <src> -l en -s -o ./out   # флаги: язык, спикеры, папка вывода

./install.sh                     # macOS/Linux: npm install -g .
install.bat                      # Windows: то же самое
```

Тестов и линтера нет. Проверка — руками: прогнать `node cli.js` на локальном файле, ссылке и Meet-записи.

Важные внешние зависимости (проверяются в рантайме через `which`/`where`):
- `ffmpeg` — конвертация всего, что не в whitelist прямых форматов
- `yt-dlp` — скачивание по ссылке (только в URL-режиме)

## Архитектура

Точка входа — [cli.js](cli.js), тонкий шим: на Windows переключает консоль в UTF-8 (`chcp 65001`) и делегирует в [app.js](app.js). Это единственное место, где можно полагаться на top-level await до импорта `app.js`.

Код разделён по ответственности, а не по слоям — каждый модуль замкнут и экспортирует свой кусок:

- [app.js](app.js) — UI, меню, режимы (`runFileMode`, `runBatchMode`, `runUrlMode`, `runMeetMode`), настройки. Весь `@inquirer/prompts` живёт здесь.
- [transcribe.js](transcribe.js) — **ядро пайплайна**. `runTranscription(source, opts)` — единственная публичная функция, которая знает как скачать/сконвертировать/отправить в Deepgram/записать MD. Остальные модули не должны знать про Deepgram.
- [gdrive.js](gdrive.js) — Google Drive API и Service Account. Тоже автономен: умеет искать Meet Recordings, скачивать файл, импортировать SA-ключ.
- [config.js](config.js) — единственный writer `~/.transcribe/config.json`. Любое изменение настроек идёт через `loadConfig`/`saveConfig`.
- [dialogs.js](dialogs.js) — нативные file picker'ы через `osascript` (macOS) и `powershell` (Windows). Linux не поддерживается — возвращает `null`.
- [shortcut.js](shortcut.js) — создание ярлыка на рабочем столе (`.command`/`.lnk`+`.bat`/`.desktop`).
- [postinstall.js](postinstall.js) — при `npm i -g` копирует `service-account.json` из `INIT_CWD` в папку установки пакета, если он там лежит.

### Пайплайн транскрипции ([transcribe.js:204](transcribe.js#L204))

Всё, что происходит после выбора источника, проходит через `runTranscription`:

1. `makeTmp()` — создаёт `os.tmpdir()/transcribe-<random>/` и регистрирует его в глобальном реестре `activeTmpDirs` (см. ниже). В `finally` — `cleanTmp`, который и удаляет директорию, и снимает её с реестра.
2. URL → `yt-dlp -x --audio-format wav` в tmp. Файл → читается как есть.
3. Если расширение не в `DIRECT_AUDIO` (whitelist: `.wav .mp3 .ogg .flac .m4a .opus .webm`) — `ffmpeg` конвертирует в `pcm_s16le 16kHz mono`. Это формат, который Deepgram жуёт без вопросов и даёт минимальный размер.
4. Весь файл загружается в память (`readFileSync`) и одним POST уходит в Deepgram. Стрима нет — предел по размеру = RAM процесса.
5. Результат форматируется в Markdown. Два режима вывода:
   - `speakers=true` → блоки `**Name** [ts]` по `results.utterances`
   - иначе → параграфы из `results.channels[0].alternatives[0].paragraphs`
6. Если имя файла уже существует в `outputDir`, добавляется суффикс `_1`, `_2` ... (не перезаписываем).

### Переименование спикеров — двухфазный flow

После Deepgram возвращает ответ, [getSpeakerPreviews](transcribe.js#L188) достаёт по 4 реплики на каждого speaker'а. Затем `runTranscription` **до** записи файла вызывает callback `onSpeakers(previews)`, который в UI-слое реализован как `askSpeakerNames` ([app.js:32](app.js#L32)). Это сделано через callback, а не напрямую, чтобы `transcribe.js` не зависел от `@inquirer/prompts` — ядро можно дёргать программно.

Сохранённые имена спикеров в конфиге (`cfg.speakerNames`) используются как suggestions при переименовании — не автоматически, а через select.

### Конфигурация и secrets

Два отдельных файла в `~/.transcribe/`:
- `config.json` — API-ключ Deepgram, язык, папки, имена спикеров, флаг `shortcutOffered`
- `service-account.json` — SA-ключ Google (не смешиваем с config)

`CONFIG_DIR = ~/.transcribe` намеренно не внутри `node_modules` — переживает `npm update -g` и переустановку. `postinstall.js` ничего туда не пишет.

`ensureApiKey` также читает `DEEPGRAM_API_KEY` из env как fallback, но сохранённый в config ключ имеет приоритет.

### Обработка ошибок Deepgram

[callDeepgram](transcribe.js#L108) маппит HTTP-коды на человеческие сообщения. Особый случай — 401/403: выбрасывается `Error` с флагом `e.isAuthError = true`, который ловится в главном цикле меню ([app.js:474](app.js#L474)) и запускает `handleDeepgramAuthError` для ввода нового ключа без выхода из программы. **Не убирать этот флаг** — это единственный способ отличить "ключ протух" от других ошибок без парсинга текста.

Ошибки `yt-dlp`/`ffmpeg` маппятся парсингом stderr в [downloadAudio](transcribe.js#L56)/[convertToWav](transcribe.js#L86) — это хрупко, но альтернативы нет.

### Кросс-платформенные хаки

- **UTF-8 на Windows**: `chcp 65001` в [cli.js](cli.js), `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1` в env для `yt-dlp` subprocess'ов, `[Console]::OutputEncoding = UTF8` в PowerShell-обёртке в [dialogs.js](dialogs.js). Без этого кириллица в именах файлов ломается.
- **File pickers** — native-only (osascript/PowerShell). Нет fallback на inquirer-input, потому что ручной ввод путей с кириллицей и пробелами ломается на Windows ещё сильнее, чем пикер.
- **Shortcut на Windows** — сначала пытается `.lnk` через `WScript.Shell`, при ошибке fallback на `.bat`. На OneDrive-десктопе проверяет `$env:OneDrive\Desktop` перед `~/Desktop`.
- **sanitizeFilename** ([transcribe.js:25](transcribe.js#L25)) режет до 120 символов и экранирует Windows-reserved names (`CON`, `PRN`, `COM1`...). Применяется к именам Drive-файлов перед сохранением в tmp.

### Batch-режим — per-file try/catch

В [runBatchMode](app.js#L197) каждый файл обрабатывается в своём try/catch. Одна ошибка не должна валить всю очередь. Это единственное место, где `runTranscription` дёргается в цикле — не ломать этот инвариант.

### Google Meet flow

`runMeetMode` комбинирует setup и использование в одной функции: если SA-ключа нет — сначала предлагает его импортировать, а **после успешного импорта не `return`**, а продолжает в тот же экран со списком записей. Это намеренно — пользователь в одном flow настраивает и сразу пользуется.

Скачивание из Drive идёт в `tmpDir = makeTmp()` ДО вызова `runTranscription`. Потенциально это многогигабайтный файл, так что cleanup при прерывании критичен — см. следующий раздел.

### Cleanup временных файлов и сигналы

Все tmp-директории создаются через `makeTmp()` ([transcribe.js:45](transcribe.js#L45)) и автоматически попадают в глобальный реестр `activeTmpDirs`. При первом вызове `makeTmp()` навешиваются process-level обработчики:

- `SIGINT` → чистит **все** `activeTmpDirs`, печатает "Прервано. Временные файлы удалены.", exit(130)
- `SIGTERM` → то же самое, exit(143)
- `exit` → safety-net, на случай если нормальный `finally` не отработал (uncaughtException и т.п.)

Это означает: **не надо вешать локальные `process.on('SIGINT')` в функциях**. Раньше `runTranscription` делал это сам, но при комбинации с внешним tmpDir (из runMeetMode) возникала коллизия — первый handler вызывал `process.exit` раньше, чем второй успевал отработать. Централизация в `makeTmp`/`cleanTmp` устраняет проблему: любая новая функция, которая заводит свой `makeTmp()`, бесплатно получает cleanup на SIGINT, даже если внутри уже есть вложенные вызовы с собственными tmp.

Инвариант: `cleanTmp(d)` снимает `d` с реестра И удаляет. Любой `finally { cleanTmp(tmp) }` — достаточен и для обычных ошибок, и для сигналов (при сигнале finally не выполнится, но глобальный handler уберёт tmp из реестра напрямую).
