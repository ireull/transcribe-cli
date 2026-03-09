@echo off
echo.
echo  Installing transcribe-cli...
echo.

:: Проверка Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

:: Установка зависимостей
call npm install --production
if %ERRORLEVEL% NEQ 0 (
    echo  [ERROR] npm install failed
    pause
    exit /b 1
)

:: Сборка пакета
call npm pack
if %ERRORLEVEL% NEQ 0 (
    echo  [ERROR] npm pack failed
    pause
    exit /b 1
)

:: Глобальная установка из архива (копирует, не линкует)
for %%f in (transcribe-cli-*.tgz) do (
    call npm install -g "%%f"
    del "%%f"
)

echo.
echo  Done! Run: transcribe
echo.
pause
