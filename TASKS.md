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
