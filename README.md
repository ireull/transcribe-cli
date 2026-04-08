¹# transcribe-cli

CLI для транскрипции аудио/видео файлов и YouTube-ссылок через Deepgram.
Поддерживает разделение по спикерам, таймстампы, Google Meet записи.

---

## Содержание

- [Требования](#требования)
- [Установка](#установка)
- [Получение ключа Deepgram](#получение-ключа-deepgram)
- [Первый запуск](#первый-запуск)
- [Режимы работы](#режимы-работы)
- [Google Meet](#google-meet)
- [Обновление](#обновление)
- [Удаление](#удаление)

---

## Требования

Перед установкой убедитесь, что установлено:

### Node.js ≥ 18

- Скачать: https://nodejs.org
- Проверить: `node -v`

### ffmpeg

```bash
# macOS
brew install ffmpeg

# Windows (через Chocolatey)
choco install ffmpeg

# Windows (вручную)
# Скачать с https://ffmpeg.org/download.html → добавить в PATH
```

Проверить: `ffmpeg -version`

### yt-dlp (только для режима «Ссылка»)

```bash
pip install yt-dlp

# или macOS
brew install yt-dlp
```

Проверить: `yt-dlp --version`

---

## Установка

### Одной командой (рекомендуется)

```bash
npm install -g git+https://github.com/ireull/transcribe-cli.git
```

Работает на macOS, Linux и Windows одинаково.

Если получите `EACCES` — запустите с `sudo` (macOS/Linux) или из консоли
с правами администратора (Windows).

### Из клона (альтернатива)

Если уже склонировали репозиторий локально и хотите собирать из исходников:

**macOS / Linux:**
```bash
cd transcribe-cli
chmod +x install.sh
./install.sh
```

**Windows:**
```bat
cd transcribe-cli
install.bat
```

После установки команда `transcribe` доступна из любого терминала.
Папку с исходниками можно удалить.

---

## Получение ключа Deepgram

Deepgram используется для распознавания речи. Есть бесплатный тариф ($200 кредитов при регистрации).

1. Перейдите на https://console.deepgram.com
2. Зарегистрируйтесь
3. Слева: **API Keys** → **Create a New API Key**
4. Название — любое, права — **Member**
5. Скопируйте ключ вида `dg-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

> Ключ показывается только один раз — сохраните его сразу.

---

## Первый запуск

```
transcribe
```

При первом запуске CLI попросит ввести API-ключ Deepgram и предложит добавить ярлык на рабочий стол:

```
  Введите API-ключ Deepgram: dg-...
  Ключ сохранен.

  Добавить ярлык на рабочий стол? Yes
  ✓ Ярлык создан
```

Настройки сохраняются в `~/.transcribe-cli.json` и запоминаются между сессиями.

---

## Режимы работы

### Файл → транскрипт

Открывает диалог выбора файла. Поддерживаемые форматы: `.wav`, `.mp3`, `.ogg`, `.flac`, `.m4a`, `.opus`, `.webm`, а также любые видео (конвертируются через ffmpeg).

### Несколько файлов (batch)

Выберите несколько файлов через Ctrl+клик — CLI обработает их по очереди в одну папку.

### Ссылка → транскрипт

Вставьте любую ссылку, которую поддерживает yt-dlp (YouTube, VK, и сотни других сайтов).
Требует установленного `yt-dlp`.

### Google Meet → транскрипт

Транскрибирует записи прямо с Google Drive. [Настройка ниже.](#google-meet)

---

## Опции транскрипции

При каждом запуске CLI спрашивает:

- **Язык** — русский, английский или свой код BCP-47
- **Разделять спикеров** — да/нет

Если спикеров несколько, после транскрипции CLI покажет первые реплики каждого и предложит назвать их по именам.

### Формат выходного файла (Markdown)

```markdown
# Название файла или видео

> Длительность: 12:34

**Иван** [00:00:05]
Привет, как дела?

**Мария** [00:00:08]
Нормально, спасибо.
```

---

## Google Meet

Позволяет выбирать и транскрибировать записи Meet прямо из папки Google Drive, без ручного скачивания.

### Подготовка Service Account (один раз)

1. Перейдите на https://console.cloud.google.com
2. Создайте новый проект (или выберите существующий)
3. Слева: **APIs & Services** → **Library** → найдите **Google Drive API** → **Enable**
4. Слева: **IAM & Admin** → **Service Accounts** → **Create Service Account**
   - Название — любое, например `transcribe-bot`
   - Нажмите **Create and Continue** → **Done**
5. Кликните на созданный SA → вкладка **Keys** → **Add Key** → **Create new key** → **JSON**
6. Скачается файл `имя-проекта-xxxxxxxx.json` — сохраните его
7. Скопируйте email SA вида `transcribe-bot@имя-проекта.iam.gserviceaccount.com`
8. Откройте **Google Drive** → папку **Meet Recordings** → ПКМ → **Share** → вставьте email SA → **Viewer** → **Send**

### Подключение в CLI

1. Запустите `transcribe`
2. Выберите **Google Meet → транскрипт**
3. CLI сам предложит выбрать `service-account.json` через диалог
4. После импорта ключ сохраняется и больше не нужно его указывать

---

## Обновление

```bash
transcribe upgrade
```

Команда сначала проверит версию на GitHub (через
`raw.githubusercontent.com`) и, если обновлений нет, выйдет мгновенно.
Иначе — вызовет `npm install -g git+https://github.com/ireull/transcribe-cli.git`.
npm сам склонирует свежую версию во временную папку, соберёт и
переустановит глобально. Локальный git clone держать не нужно.

Также доступно через меню: **Настройки → Обновить transcribe**, или флагом
`transcribe --upgrade`.

Возможные ошибки:
- **EACCES** — подскажет запустить `sudo npm install -g ...`.
- **Windows** — закрыть все окна transcribe и повторить (запущенный процесс может блокировать перезапись).

Установка перезапишет предыдущую версию. Настройки (ключи, папки) сохранятся — они хранятся отдельно в `~/.transcribe/`.

---

## Удаление

```bash
npm uninstall -g transcribe-cli
```

Настройки и SA-ключ удалить вручную:

```bash
# macOS / Linux
rm ~/.transcribe-cli.json
rm ~/.transcribe-sa-key.json

# Windows (PowerShell)
Remove-Item "$env:USERPROFILE\.transcribe-cli.json"
Remove-Item "$env:USERPROFILE\.transcribe-sa-key.json"
```
