@echo off
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs
set OPENBOT_VISUAL_TEST=1
set OPENBOT_LOCAL_GATEWAY=1
set ELECTRON_EXE=C:\Users\User\AppData\Local\hermes\hermes-agent\apps\desktop\node_modules\electron\dist\electron.exe
set USER_DATA_DIR=C:\Temp\openbot-visual-clean
if not exist "%USER_DATA_DIR%" mkdir "%USER_DATA_DIR%"
if not exist "%ELECTRON_EXE%" (
  echo Electron runtime nao encontrado: %ELECTRON_EXE% > logs\visual-electron.log
  pause
  exit /b 1
)
echo OpenBot Electron launcher started > logs\visual-electron.log
"%ELECTRON_EXE%" --user-data-dir="%USER_DATA_DIR%" --no-sandbox --disable-gpu --enable-logging --log-file="%CD%\logs\visual-electron-chromium.log" "%CD%\scripts\openbot-electron.cjs" >> logs\visual-electron.log 2>&1
if errorlevel 1 pause
