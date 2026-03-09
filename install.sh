#!/bin/bash
echo ""
echo "  Installing transcribe-cli..."
echo ""

# Проверка Node.js
if ! command -v node &> /dev/null; then
    echo "  [ERROR] Node.js not found. Install: brew install node"
    exit 1
fi

# Установка зависимостей
npm install --production
if [ $? -ne 0 ]; then echo "  [ERROR] npm install failed"; exit 1; fi

# Сборка пакета
npm pack
if [ $? -ne 0 ]; then echo "  [ERROR] npm pack failed"; exit 1; fi

# Глобальная установка из архива (копирует, не линкует)
npm install -g transcribe-cli-*.tgz
rm -f transcribe-cli-*.tgz

echo ""
echo "  Done! Run: transcribe"
echo ""
