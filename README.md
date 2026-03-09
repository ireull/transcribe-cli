# transcribe-cli

CLI для транскрипции аудио/видео через Deepgram.

## Установка

```bash
cd transcribe-cli
npm install
npm install -g .
```

При установке `service-account.json` автоматически скопируется в глобальную папку.

## Google Meet записи (SA)

Один раз:

1. Google Cloud Console → создать проект
2. APIs → включить **Google Drive API**
3. IAM → Service Accounts → создать SA
4. Keys → Add Key → JSON → скачать
5. Положить `service-account.json` в папку проекта (перед `npm i -g .`)
6. Google Drive → папка Meet Recordings → Share → email SA

Если ключ добавляете после установки — запустите `transcribe`, выберите Meet, CLI предложит выбрать файл через диалог.

## Структура

```
cli.js          # entry point
app.js          # меню, CLI
transcribe.js   # yt-dlp → ffmpeg → Deepgram → .md
gdrive.js       # Google Drive SA
dialogs.js      # нативные диалоги файлов
shortcut.js     # ярлык на рабочий стол
config.js       # ~/.transcribe.json
postinstall.js  # автокопирование SA-ключа при npm i -g
```
