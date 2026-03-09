# transcribe-cli

CLI для транскрипции аудио/видео через Deepgram.

## Установка

### Windows

```powershell
cd transcribe-cli
install.bat
```

### macOS

```bash
cd transcribe-cli
chmod +x install.sh
./install.sh
```

Готово. `transcribe` работает из любого терминала. Папку с исходниками можно удалить.

## Перед установкой — системные зависимости

```bash
# ffmpeg
brew install ffmpeg          # macOS
choco install ffmpeg         # Windows

# yt-dlp (для режима ссылок)
pip install yt-dlp
```

## Первый запуск

```
> transcribe

  Введите API-ключ Deepgram: dg-...
  Ключ сохранен.

  Добавить ярлык на рабочий стол? Yes
  ✓ Ярлык создан
```

## Google Meet

При первом выборе «Google Meet → транскрипт» CLI предложит выбрать `service-account.json` через диалог. Сам скопирует куда надо.

Подготовка SA (один раз):

1. Google Cloud Console → создать проект
2. APIs → включить Google Drive API
3. IAM → Service Accounts → создать SA
4. Keys → Add Key → JSON → скачать
5. Google Drive → папка Meet Recordings → Share → email SA

## Удаление

```bash
npm uninstall -g transcribe-cli
```
