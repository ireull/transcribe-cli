# Задачи transcribe-cli

- [x] TCL-001 Meet: поддержать новую схему Drive «Google Meet/<встреча>/» (июль 2026)		#meet #gdrive !high @status:done @owner:claude-fable
  С июля 2026 Google Meet кладёт записи в `My Drive/Google Meet/<встреча> - дата TZ/`, а старую «Meet Recordings»
  переносит внутрь как «Legacy Meet Recordings». `collectRecordings` искал только папки «Meet Recordings» и их прямых
  детей — новые записи в CLI не видны (подтверждено на аккаунте thegrowglobal.pro: запись 2026-09-11 отсутствует в списке).
  Сделать: корни по имени (Google Meet / Meet Recordings / Legacy), подпапки на один уровень, один глобальный запрос медиа
  с локальным фильтром по родителю, ярлыки → целевой файл, имя с папки встречи для generic-файлов, диагностика в UI,
  тесты, README/CLAUDE.md, bump 1.19.0, publish.
  **Implemented:**
  - `collectRecordings` ищет корни «Google Meet» / «Meet Recordings» / «Legacy Meet Recordings», обходит папки встреч на один уровень и берёт медиа одним глобальным запросом с локальным фильтром по родителю.
  - Ярлыки на записи разворачиваются в целевой файл с его метаданными; недоступные цели выпадают.
  - Имя транскрипта берётся с папки встречи, если файл назван кодом встречи (`recordingName`).
  - UI показывает сводку по найденным папкам и подсказку расшарить «Google Meet», если её нет.
  - Тесты на обе схемы, ярлыки, лимит и сбои; README/CLAUDE.md обновлены; bump 1.19.0.

- [x] TCL-002 Meet: метка аккаунта-владельца у записей в списке		#meet #ui @owner:claude-fable @status:done
  Записи с нескольких Google-аккаунтов (расшарены на один SA) в списке неотличимы. Показать цветную метку
  аккаунта перед именем, сводку «Аккаунты: …» над списком, включить аккаунт в строку поиска.
  **Implemented:**
  - `collectRecordings` проставляет `account` из `owners` (у ярлыка — владельца цели); `accountLabel` режет gmail до имени ящика.
  - Список Meet: цветная выровненная метка `[account]` и строка «Аккаунты: a ×N, b ×M» — только если аккаунтов больше одного.
  - Поиск в списке находит и по аккаунту (`londeren 09`).
  - Тесты на account/accountLabel/describeCounts; README/CLAUDE.md; bump 1.20.0.

- [x] TCL-003 gdrive: опции collectRecordings ownedOnly/rootIds для оркестратора		#meet #gdrive #api @owner:claude-fable @status:done
  Оркестратор (orkestrator-gg, OAuth под thegrowglobal.pro) опрашивал одну папку по ID и с 11.09 не видел записей из
  «Google Meet/<встреча>/»; к тому же импортировал удалённый в 1.19.0 `listRecordings`. Нужен общий поиск по всем
  Meet-папкам аккаунта, но только своим (OAuth видит и чужие расшаренные), плюс явный корень из конфига.
  **Implemented:**
  - `collectRecordings(drive, limit, { ownedOnly, rootIds })`: `'me' in owners` в запросах корней и медиа, ярлыки при
    ownedOnly не берутся; явные корни по ID добавляются к найденным по имени, недоступный ID — ошибка.
  - `getMeetRecordings` прокидывает опции; тесты; CLAUDE.md про публичный API gdrive.js; bump 1.21.0.

- [x] TCL-004 AssemblyAI: транскрипт без таймстампов, когда диаризация схлопнулась в одну utterance		#assembly #bug !high @status:done @owner:claude
  На записи 3ч (Live. Прожарка LinkedIn, ru) AssemblyAI вернул `speaker_labels: true`, но ровно ОДНУ utterance на весь
  файл и одного спикера. `assembleMarkdown` с `merge:true` склеил её в один блок — весь транскрипт вышел стеной текста
  с единственным таймстампом `[00:20]`. Разрезание исходника пополам не помогает: каждая половина даёт тот же дефект.
  Сделать: при схлопнувшейся диаризации падать на `GET /v2/transcript/{id}/paragraphs` (тот же job, без повторной
  оплаты) и рендерить блок на абзац; при одном спикере не склеивать и не печатать метку `**Speaker A**`.
  **Implemented:**
  - `isDiarizationCollapsed` (assembly.js): один спикер И реплики реже одной в минуту на записи от 2 минут; оба порога
    binding, закрыты граничными тестами.
  - Фоллбэк берёт абзацы того же уже оплаченного job'а (`calls.submit === 1` в тесте); подмена только если абзацев
    строго больше И они покрывают ≥90% текста — частичный ответ не срезает оплаченный транскрипт.
  - Склейка в `assembleMarkdown` ограничена окном `MERGE_MAX_SPAN_S = 60` вместо выключения при одном спикере: чинит и
    схлопнувшийся AssemblyAI, и пофразовый Deepgram, не раздувая вход саммаризатора.
  - Метка `**Speaker A**` не печатается, если спикер один и имени нет (breaking для внешних парсеров markdown — отмечено
    в CLAUDE.md); `diarizationFallback` проброшен до `transcribeFile`, CLI предупреждает.
  - Проверено на настоящем ответе того job'а: 1 utterance → 249 абзацев → 74 блока с таймстампами (было 1).

- [x] TCL-005 Спрашивать число спикеров ДО транскрипции, а не после		#assembly #ux @status:done @owner:claude
  Сейчас `askDiarCount` спрашивает «столько и есть?» после готового результата, и «нет» запускает вторую платную
  транскрипцию. Спрашивать надо заранее, с вариантом «не знаю / неважно» (тогда `speakers_expected` не шлём).
  Сделать: промпт перед запуском для провайдера assembly, флаг для быстрого режима, убрать пост-фактум пересчёт.
  **Implemented:**
  - `askSpeakersExpected` спрашивает во всех четырёх режимах (файл/batch/ссылка/Meet) после выбора источника и папки —
    рядом со стартом; «Не знаю / неважно» первым пунктом и по Enter, `speakers_expected` тогда не шлётся.
  - `askDiarCount`/`onDiarCount` удалены целиком вместе со стейл-строкой в Настройках — вторая платная транскрипция
    больше недостижима.
  - Быстрый режим: `-n / --speakers-expected`; значения флагов больше не попадают в `source` (`-n 2 rec.mp3` раньше
    транскрибировал файл «2»); под Deepgram флаг явно помечается как игнорируемый.

- [x] TCL-006 Автопубликация в npm из GitHub Actions (Trusted Publishing)		#release #ci @status:done @owner:claude-opus
  Публиковать может только владелец пакета (ireull) со своей машины, поэтому 1.22.0 месяц лежит невыпущенной
  (в npm последняя 1.21.0 от 18.09). Сделать: workflow на push в master — тесты, затем `npm publish`, если версии
  из package.json ещё нет в npm; вход через Trusted Publishing (OIDC), без токенов; CLAUDE.md про новый порядок.
  Первым выйдет 1.23.0 — вместе с ней и невыпущенная 1.22.0.
  **Implemented:**
  - `.github/workflows/publish.yml`: push в master → `npm ci` + `npm test` → `npm publish`, если версии ещё нет в npm;
    публикация — в отдельном job без `npm ci`, только у него `id-token: write`, и только из master.
  - Проверено локально: тесты из чистого клона, обе ветки проверки версии, `npm publish --dry-run` без node_modules
    даёт те же 14 файлов, что опубликованная 1.21.0.
  - CLAUDE.md: публикация автоматическая, неопубликованная версия в master = релиз, workflow привязан к настройке npm.
  - На npmjs.com заведён Trusted Publisher (`ireull/transcribe-cli`, `publish.yml`, разрешён `npm publish`), статус
    Valid. Первый релиз через CI — 1.23.0 (вместе с 1.22.0), с provenance; без настройки job падал с E404.
