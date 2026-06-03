# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Запуск и разработка

```bash
node cli.js                      # запуск из исходников (интерактивное меню)
node cli.js <file-or-url>        # быстрый режим без меню
node cli.js <src> -l en -s -o ./out   # флаги: язык, спикеры, папка вывода

npm i -g .                       # поставить локальную сборку глобально (из клона)
```

Юнит-тесты — `npm test` (встроенный `node --test`, без зависимостей; файлы в [test/](test/)). Покрыта чистая логика: `formatMarkdown` (склейка/саммари), `buildDeepgramParams`, `cleanMeetName`, `parseSummary`, `summarizeTranscript` (через мок `fetch`), merge конфига. Линтера нет.

Что тестами НЕ покрыто (нужны живые сервисы/TTY) — проверять руками: реальные вызовы Deepgram/AssemblyAI/Gemini, ffmpeg/yt-dlp, интерактивные `@inquirer`-промпты. Для промптов есть быстрый способ прогнать вручную через tmux (`tmux send-keys` + `capture-pane`). Базовый ручной прогон: `node cli.js` на локальном файле, ссылке и Meet-записи.

Важные внешние зависимости (проверяются в рантайме через `which`/`where`):
- `ffmpeg` — конвертация всего, что не в whitelist прямых форматов
- `yt-dlp` — скачивание по ссылке (только в URL-режиме)

## Рабочий процесс

**Бампай версию на каждом изменении кода.** Semver: patch (`1.2.0` → `1.2.1`) для багфиксов и мелких правок, minor (`1.2.0` → `1.3.0`) для новых фичей или заметного поведения, major для ломающих изменений конфига или CLI-интерфейса. Без этого пользователь после `transcribe upgrade` не увидит, что версия сменилась, и не сможет отличить сборки в багрепортах.

Как бампать: поменяй `version` в [package.json](package.json), затем выполни `npm install` — это автоматически обновит `version` в [package-lock.json](package-lock.json). Не редактируй lock-файл вручную.

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

- [app.js](app.js) — UI, меню, режимы (`runFileMode`, `runBatchMode`, `runUrlMode`, `runMeetMode`), настройки. Весь `@inquirer/prompts` живёт здесь. Ctrl+C внутри под-флоу ловится (`isExitPrompt` → `ExitPromptError`) как «назад в меню» (`continue`), а не выход; завершает программу только Ctrl+C из главного меню или пункт «Выход». Во время самой транскрипции (не промпт) Ctrl+C — это уже SIGINT → глобальный cleanup в transcribe.js.
- [transcribe.js](transcribe.js) — **ядро пайплайна**. `runTranscription(source, opts)` — единственная публичная функция: скачать/сконвертировать/транскрибировать/записать MD. Провайдер транскрипции по `opts.provider`: `deepgram` (по умолчанию, `callDeepgram`) или `assembly` ([assembly.js](assembly.js)). Весь `ora`-спиннер здесь.
- [gdrive.js](gdrive.js) — Google Drive API и Service Account. Тоже автономен: умеет искать Meet Recordings, скачивать файл, импортировать SA-ключ, чистить авто-имена Meet (`cleanMeetName`: срезает «– Recording»/таймзоны, нормализует дату, ловит дефолтные коды встреч `xxx-xxxx-xxx`).
- [summarize.js](summarize.js) — авто-саммари через **Google Gemini** (`generateContent`, `responseMimeType: application/json`). Автономен, как gdrive.js. `summarizeTranscript(text, {apiKey, model})` → `{title, paragraph}`; ретраит 429 с бэкоффом, парсит JSON с фолбэком. Дефолт-модель `gemini-3.5-flash` (русский саммаризирует, в отличие от Deepgram, где audio-intelligence — только англ.). Подключается callback'ом `summarize` в `runTranscription` (как `onSpeakers`), чтобы ядро не зависело от провайдера саммари.
- [assembly.js](assembly.js) — облачный провайдер транскрипции **AssemblyAI** (`transcribeAssembly`): транскрипт + диаризация в одном вызове, с подсказкой числа спикеров `speakers_expected`. Загрузка → запуск → поллинг; возвращает `utterances` в формате Deepgram (`{speaker, start, end, transcript}`), так что `formatMarkdown`/переименование не меняются. Альтернатива Deepgram, когда нужно задать число спикеров (у Deepgram такой ручки нет).
- [config.js](config.js) — единственный writer `~/.config/transcribe-cli/config.json` (или `$XDG_CONFIG_HOME/transcribe-cli/` если задан). Любое изменение настроек идёт через `loadConfig`/`saveConfig`. Экспортирует `CONFIG_DIR` — все остальные модули, которым нужен путь к пользовательским данным, импортируют его отсюда, а не считают свой.
- [dialogs.js](dialogs.js) — нативная интеграция с ОС. File picker'ы через `osascript` (macOS) и `powershell` (Windows); Linux для пикеров не поддерживается — возвращает `null`. Плюс `openFile`/`revealFile`/`copyToClipboard` для post-action меню (open/reveal/буфер) — через `execFileSync` с **массивом** аргументов (не строкой), чтобы пути с пробелами/кириллицей не требовали экранирования. На Linux эти три — best-effort (`xdg-open`/`xclip`/`xsel`).
- [shortcut.js](shortcut.js) — создание ярлыка на рабочем столе (`.command`/`.lnk`+`.bat`/`.desktop`).
- [upgrade.js](upgrade.js) — `transcribe upgrade`: `npm install -g <name>@latest` из реестра, см. раздел "Самообновление".

### Пайплайн транскрипции ([transcribe.js:204](transcribe.js#L204))

Всё, что происходит после выбора источника, проходит через `runTranscription`:

1. `makeTmp()` — создаёт `os.tmpdir()/transcribe-<random>/` и регистрирует его в глобальном реестре `activeTmpDirs` (см. ниже). В `finally` — `cleanTmp`, который и удаляет директорию, и снимает её с реестра.
2. URL → `yt-dlp -x --audio-format opus` в tmp. Файл → читается как есть.
3. Если расширение не в `DIRECT_AUDIO` (whitelist: `.wav .mp3 .ogg .flac .m4a .opus .webm`) — `ffmpeg` конвертирует в opus (`convertToOpus`/`opusEncodeArgs`). Два режима по `hq` (= `speakers`):
   - **обычный** — 32 kbps mono voip: для распознавания слов хватает, файл ~в 8× компактнее WAV (115→14 MB/ч), снимает таймауты аплоада.
   - **hq (диаризация)** — 128 kbps + сохраняются каналы (не mono, ~56 MB/ч). Диаризация v2 строит голосовые эмбеддинги по тонким спектральным признакам; на 32k mono у тихих/редких спикеров они теряются и Deepgram их сливает (реальный баг на 5-спикерном созвоне: 32k→3/5, 96k→4/5, 128k — потолок из ресёрча). Подсказки числа спикеров у Deepgram нет — качество аудио единственный рычаг. Чтобы **задавать число спикеров**, нужен провайдер **AssemblyAI** (`speakers_expected`, см. [assembly.js](assembly.js)) — у него диаризация с подсказкой числа.
4. Транскрипция по `provider`. **AssemblyAI** (`assembly`) — `transcribeAssembly`: транскрипт + диаризация, число спикеров подтверждается циклом через callback `onDiarCount` (показали N → не то → пересчёт со `speakers_expected`). **Deepgram** (дефолт) — весь файл загружается в память (`readFileSync`) и одним POST уходит в Deepgram. Параметры собираются в [callDeepgram](transcribe.js#L156): всегда `smart_format/punctuate/paragraphs/utterances`; язык — либо `detect_language=true` (если `autoLang`), либо `language=<код>` (взаимоисключающие); спикеры — `diarize_model=latest` (**новый v2-диаризатор; legacy `diarize=true` слать НЕЛЬЗЯ — Deepgram отклонит запрос при обоих**); `numerals=true` опционально. Audio-intelligence фичи (`summarize`/`topics`/`sentiment`) — **только английский**, для русского не подключать (`summarize`+`language=ru` = 400, роняет весь запрос).
5. Результат форматируется в Markdown. Два режима вывода:
   - `speakers=true` → блоки `**Name** [ts]` по `results.utterances`. При `merge=true` (дефолт) подряд идущие реплики одного спикера склеиваются в один блок (таймстамп — от первой); при `merge=false` — по одной.
   - иначе → параграфы из `results.channels[0].alternatives[0].paragraphs`
6. Если задан callback `summarize` (вкл в Настройках + есть ключ Gemini), перед записью добавляется блок «## Краткое содержание». Имя файла берётся из саммари **только** если своего осмысленного нет — `nameIsGeneric` (дефолтный код Meet) или fallback `transcript`. Любая ошибка саммари не роняет транскрипт — сохраняем без него.
7. Если имя файла уже существует в `outputDir`, добавляется суффикс `_1`, `_2` ... (не перезаписываем).

### Переименование спикеров — двухфазный flow

После Deepgram возвращает ответ, [getSpeakerPreviews](transcribe.js#L188) достаёт по 4 реплики на каждого speaker'а. Затем `runTranscription` **до** записи файла вызывает callback `onSpeakers(previews)`, который в UI-слое реализован как `askSpeakerNames` ([app.js:32](app.js#L32)). Это сделано через callback, а не напрямую, чтобы `transcribe.js` не зависел от `@inquirer/prompts` — ядро можно дёргать программно.

Сохранённые имена спикеров в конфиге (`cfg.speakerNames`) используются как suggestions при переименовании — не автоматически, а через select.

### Конфигурация и secrets

Два отдельных файла в XDG-папке (`$XDG_CONFIG_HOME/transcribe-cli/` или `~/.config/transcribe-cli/` по умолчанию):
- `config.json` — API-ключ Deepgram, опции транскрипции (`autoLang`, `lang`, `speakers`, `mergeUtterances`, `numerals`), папки, имена спикеров. Опции редактируются единым чеклистом (`@inquirer/checkbox`) в [askOptions](app.js) и запоминаются между запусками — фикс. порядок, предзаполнено из конфига, обычно достаточно Enter. Ярлык на рабочий стол предлагается только в Настройках (вопроса на первом запуске больше нет).
- `service-account.json` — SA-ключ Google (не смешиваем с config)

`CONFIG_DIR` вычисляется в [config.js](config.js) и экспортируется — [gdrive.js](gdrive.js) импортирует его оттуда, а не дублирует логику вычисления. Это **единственное место** где определяется путь к пользовательским данным.

Директория намеренно не внутри `node_modules` — переживает `npm update -g` и переустановку.

**Миграции со старого `~/.transcribe/` нет** — при переходе на версию с XDG-путями пользователь руками переносит (или пересоздаёт) config. Решение осознанное: автомиграция добавляет код ради одноразового события.

`ensureApiKey` также читает `DEEPGRAM_API_KEY` из env как fallback, но сохранённый в config ключ имеет приоритет.

### Обработка ошибок Deepgram

[callDeepgram](transcribe.js#L108) маппит HTTP-коды на человеческие сообщения. Особый случай — 401/403: выбрасывается `Error` с флагом `e.isAuthError = true`, который ловится в главном цикле меню ([app.js:474](app.js#L474)) и запускает `handleDeepgramAuthError` для ввода нового ключа без выхода из программы. **Не убирать этот флаг** — это единственный способ отличить "ключ протух" от других ошибок без парсинга текста.

Ошибки `yt-dlp`/`ffmpeg` маппятся парсингом stderr в [downloadAudio](transcribe.js#L91)/[convertToOpus](transcribe.js#L123) — это хрупко, но альтернативы нет.

### Кросс-платформенные хаки

- **UTF-8 на Windows**: `chcp 65001` в [cli.js](cli.js), `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1` в env для `yt-dlp` subprocess'ов, `[Console]::OutputEncoding = UTF8` в PowerShell-обёртке в [dialogs.js](dialogs.js). Без этого кириллица в именах файлов ломается.
- **File pickers** — native-only (osascript/PowerShell). Нет fallback на inquirer-input, потому что ручной ввод путей с кириллицей и пробелами ломается на Windows ещё сильнее, чем пикер.
- **Shortcut на Windows** — сначала пытается `.lnk` через `WScript.Shell`, при ошибке fallback на `.bat`. На OneDrive-десктопе проверяет `$env:OneDrive\Desktop` перед `~/Desktop`.
- **sanitizeFilename** ([transcribe.js:25](transcribe.js#L25)) режет до 120 символов и экранирует Windows-reserved names (`CON`, `PRN`, `COM1`...). Применяется к именам Drive-файлов перед сохранением в tmp.

### Batch-режим — per-file try/catch

В [runBatchMode](app.js#L197) каждый файл обрабатывается в своём try/catch. Одна ошибка не должна валить всю очередь. Это единственное место, где `runTranscription` дёргается в цикле — не ломать этот инвариант.

### Google Meet flow

`runMeetMode` комбинирует setup и использование в одной функции: если SA-ключа нет — сначала предлагает его импортировать, а **после успешного импорта не `return`**, а продолжает в тот же экран со списком записей. Это намеренно — пользователь в одном flow настраивает и сразу пользуется.

Выбор записи — не плоский `select`, а `search`-prompt с фильтром «по мере ввода». Чтобы фильтрация была мгновенной (без запроса к Drive на каждую букву), `getMeetRecordings` фетчит широкое окно (`paginateFiles`, дефолт 500 с пагинацией по 1000), а `source` в [runMeetMode](app.js#L286) фильтрует локально: токены через пробел матчатся по «И» против `name + formatDate`. Поэтому **поиск находит и по названию, и по дате** (`formatDate` даёт `дд.мм.гггг, чч:мм`, так что `06` ловит месяц). Отображение обрезается до `MAX_SHOWN=50` с подсказкой «…ещё N»; спецзначение `BACK` (`__back__`) обслуживает и «Назад», и «ничего не найдено», и «уточните запрос». Лимит фетча намеренно конечный — при библиотеке >500 записей сужать надо запросом, а не скроллом.

Скачивание из Drive идёт в `tmpDir = makeTmp()` ДО вызова `runTranscription`. Потенциально это многогигабайтный файл, так что cleanup при прерывании критичен — см. следующий раздел.

### Cleanup временных файлов и сигналы

Все tmp-директории создаются через `makeTmp()` ([transcribe.js:45](transcribe.js#L45)) и автоматически попадают в глобальный реестр `activeTmpDirs`. При первом вызове `makeTmp()` навешиваются process-level обработчики:

- `SIGINT` → чистит **все** `activeTmpDirs`, печатает "Прервано. Временные файлы удалены.", exit(130)
- `SIGTERM` → то же самое, exit(143)
- `exit` → safety-net, на случай если нормальный `finally` не отработал (uncaughtException и т.п.)

Это означает: **не надо вешать локальные `process.on('SIGINT')` в функциях**. Раньше `runTranscription` делал это сам, но при комбинации с внешним tmpDir (из runMeetMode) возникала коллизия — первый handler вызывал `process.exit` раньше, чем второй успевал отработать. Централизация в `makeTmp`/`cleanTmp` устраняет проблему: любая новая функция, которая заводит свой `makeTmp()`, бесплатно получает cleanup на SIGINT, даже если внутри уже есть вложенные вызовы с собственными tmp.

Инвариант: `cleanTmp(d)` снимает `d` с реестра И удаляет. Любой `finally { cleanTmp(tmp) }` — достаточен и для обычных ошибок, и для сигналов (при сигнале finally не выполнится, но глобальный handler уберёт tmp из реестра напрямую).

### Самообновление (`transcribe upgrade`)

Ключевой принцип: **локальный git clone не требуется**. Типичный воркфлоу пользователя — `npm install -g @ireull/transcribe-cli` (или `git+https://github.com/ireull/transcribe-cli.git`). Upgrade должен работать без исходной папки.

Механизм:

1. Upgrade читает `name` и `version` из своего же `package.json` (лежит рядом с `upgrade.js` в папке глобальной установки, доступен через `import.meta.url`).
2. Делает `fetch https://registry.npmjs.org/<name>` — берёт `dist-tags.latest` и сравнивает с установленной версией. Если совпадает — ранний выход без запуска `npm` (экономит ~20 секунд). При сетевой ошибке/404 просто проваливается в install.
3. Если версии разные (или проверка не сработала) — `execSync('npm install -g <name>@latest')`. npm сам качает свежий тарбол из реестра, ставит зависимости и обновляет глобальную установку.
4. После install перечитывает `package.json` с того же пути — файл уже заменён, возвращает новую версию. Показывает пользователю `старая → новая`.

**Пакет публичный в npm-реестре**, поэтому:
- Установка/обновление не требуют токенов или авторизации — `npm install -g <name>@latest` работает у любого пользователя (токен нужен только для `npm publish`).
- Первичная установка — `npm install -g @ireull/transcribe-cli`. Из клона для разработки — `npm i -g .` в папке репозитория.

**[package.json](package.json) обязан содержать поле `name`** (`@ireull/transcribe-cli`) — по нему upgrade тянет пакет. Также **версию надо бампать И публиковать на каждом релизе** (`npm publish`; см. раздел "Рабочий процесс"), иначе проверка `dist-tags.latest` покажет "уже последняя" и реальное обновление не запустится.

На EACCES upgrade подсказывает `sudo npm install -g ...`, на Windows — закрыть transcribe и повторить. Полный stderr npm выводится при ошибке первыми 10 строк.
