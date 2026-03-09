# transcribe-cli

CLI для транскрипции аудио/видео через Deepgram.

## Установка

```bash
cd transcribe-cli
npm install
npm install -g .
```

Готово. `transcribe` работает из любого места.

При первом запуске попросит API-ключ и предложит ярлык на рабочий стол.

## Удаление

```bash
npm uninstall -g transcribe-cli
```

## Структура (все файлы в корне)

```
transcribe-cli/
  cli.js          # entry point
  app.js          # меню, CLI-аргументы
  transcribe.js   # yt-dlp → ffmpeg → Deepgram → .md
  dialogs.js      # нативные диалоги файлов
  shortcut.js     # ярлык на рабочий стол
  config.js       # ~/.transcribe.json
  package.json
```
