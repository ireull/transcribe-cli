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

## Рабочий процесс

**Бампай версию в [package.json](package.json) на каждом изменении кода.** Semver: patch (`1.2.0` → `1.2.1`) для багфиксов и мелких правок, minor (`1.2.0` → `1.3.0`) для новых фичей или заметного поведения, major для ломающих изменений конфига или CLI-интерфейса. Без этого пользователь после `transcribe upgrade` не увидит, что версия сменилась, и не сможет отличить сборки в багрепортах.

**После завершения фичи предложи пользователю сделать commit.** Не коммить сам без явного запроса — просто спроси "готово, сделать commit?". Если пользователь согласен, используй `/commit`. Это не относится к промежуточным правкам в рамках одной фичи — только к логически завершённым изменениям.

## Настройки и миграция конфига

Конфиг (`~/.transcribe/config.json`) лежит вне пакета и переживает любую переустановку. [config.js:18](config.js#L18) мержит сохранённое поверх `DEFAULTS` при чтении — так что **добавление нового поля в `DEFAULTS` не требует миграции**: старый файл получит дефолт автоматически, при следующем `saveConfig` ключ запишется.

Чего merge НЕ покрывает и требует ручной миграции в `loadConfig`:
- **Переименование ключа** — старое значение осиротеет, новый получит дефолт
- **Смена типа значения** — старое значение перезапишет новую структуру и сломает код, который ожидает новый тип
- **Удаление ключа** — останется мёртвым грузом в файле (не критично, но некрасиво)

Если делаешь что-то из этого списка — добавь в `loadConfig` блок, который детектит старую форму и конвертирует. Сейчас такой логики нет и в большинстве случаев она не нужна.

## Архитектура

Точка входа — [cli.js](cli.js), тонкий шим: на Windows переключает консоль в UTF-8 (`chcp 65001`) и делегирует в [app.js](app.js). Это единственное место, где можно полагаться на top-level await до импорта `app.js`.

Код разделён по ответственности, а не по слоям — каждый модуль замкнут и экспортирует свой кусок:

- [app.js](app.js) — UI, меню, режимы (`runFileMode`, `runBatchMode`, `runUrlMode`, `runMeetMode`), настройки. Весь `@inquirer/prompts` живёт здесь.
- [transcribe.js](transcribe.js) — **ядро пайплайна**. `runTranscription(source, opts)` — единственная публичная функция, которая знает как скачать/сконвертировать/отправить в Deepgram/записать MD. Остальные модули не должны знать про Deepgram.
- [gdrive.js](gdrive.js) — Google Drive API и Service Account. Тоже автономен: умеет искать Meet Recordings, скачивать файл, импортировать SA-ключ.
- [config.js](config.js) — единственный writer `~/.config/transcribe-cli/config.json` (или `$XDG_CONFIG_HOME/transcribe-cli/` если задан). Любое изменение настроек идёт через `loadConfig`/`saveConfig`. Экспортирует `CONFIG_DIR` — все остальные модули, которым нужен путь к пользовательским данным, импортируют его отсюда, а не считают свой.
- [dialogs.js](dialogs.js) — нативные file picker'ы через `osascript` (macOS) и `powershell` (Windows). Linux не поддерживается — возвращает `null`.
- [shortcut.js](shortcut.js) — создание ярлыка на рабочем столе (`.command`/`.lnk`+`.bat`/`.desktop`).
- [upgrade.js](upgrade.js) — `transcribe upgrade`: `npm install -g git+<url>`, см. раздел "Самообновление".
- [postinstall.js](postinstall.js) — запускается через `scripts.postinstall` в [package.json](package.json). При `npm i -g` копирует `service-account.json` из `INIT_CWD` в папку установки пакета, если он там лежит.

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

Два отдельных файла в XDG-папке (`$XDG_CONFIG_HOME/transcribe-cli/` или `~/.config/transcribe-cli/` по умолчанию):
- `config.json` — API-ключ Deepgram, язык, папки, имена спикеров, флаг `shortcutOffered`
- `service-account.json` — SA-ключ Google (не смешиваем с config)

`CONFIG_DIR` вычисляется в [config.js](config.js) и экспортируется — [gdrive.js](gdrive.js) импортирует его оттуда, а не дублирует логику вычисления. Это **единственное место** где определяется путь к пользовательским данным.

Директория намеренно не внутри `node_modules` — переживает `npm update -g` и переустановку. `postinstall.js` туда ничего не пишет.

**Миграции со старого `~/.transcribe/` нет** — при переходе на версию с XDG-путями пользователь руками переносит (или пересоздаёт) config. Решение осознанное: автомиграция добавляет код ради одноразового события.

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

### Самообновление (`transcribe upgrade`)

Ключевой принцип: **локальный git clone не требуется**. Типичный воркфлоу пользователя — `npm install -g git+https://github.com/ireull/transcribe-cli.git` (или через `install.sh` из клона, который он тут же удаляет). Upgrade должен работать без исходной папки.

Механизм:

1. Upgrade читает `repository.url` из своего же `package.json` (лежит рядом с `upgrade.js` в папке глобальной установки, доступен через `import.meta.url`).
2. Делает `fetch https://raw.githubusercontent.com/<user>/<repo>/master/package.json` (fallback `main`) — сравнивает `version` с установленной. Если совпадает — ранний выход без запуска `npm` (экономит ~20 секунд). Работает только для public-репо; если репо сделают приватным, fetch вернёт 404, и мы просто провалимся в install.
3. Если версии разные (или проверка не сработала) — `execSync('npm install -g git+https://github.com/.../transcribe-cli.git')`. npm сам клонирует в temp, ставит зависимости, вызывает postinstall и устанавливает глобально. Temp чистится npm-ом.
4. После install перечитывает `package.json` с того же пути — файл уже заменён, возвращает новую версию. Показывает пользователю `старая → новая`.

**Репо публичное**, поэтому:
- В [package.json](package.json) URL формата `git+https://github.com/...`. Никаких SSH-ключей на машине пользователя не нужно — работает из коробки на любой машине с Node и git.
- Первичная установка — `npm install -g git+https://github.com/ireull/transcribe-cli.git` одной строкой. `install.sh`/`install.bat` остаются как альтернатива для тех, кто уже склонировал репо.

**[package.json](package.json) обязан содержать поле `repository.url`** — иначе upgrade не знает, откуда качать. Также **версия должна бампаться на каждом релизе** (см. раздел "Рабочий процесс"), иначе проверка через raw.githubusercontent.com покажет "уже последняя" и реальное обновление не запустится.

На EACCES upgrade подсказывает `sudo npm install -g ...`, на Windows — закрыть transcribe и повторить. Полный stderr npm выводится при ошибке первыми 10 строк.
