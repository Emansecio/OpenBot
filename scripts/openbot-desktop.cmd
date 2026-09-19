@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
if not exist logs mkdir logs

set "OPENBOT_LOCAL_GATEWAY=1"
set "SAND_DEV_CAPABILITY="
set "SAND_DEV_CONTROL_PORT="
set "SAND_HOST_GATEWAY_URL="
set "SAND_HOST_GATEWAY_TOKEN="
set "VITE_DEV_SERVER_URL="
set "OPENBOT_ROOT=%CD%"
set "OPENBOT_RELEASE_ROOT="
set "OPENBOT_INSTALL_ROOT="
set "SAND_DEV_APP_ICON=%CD%\assets\openbot.ico"
rem Electron must not inherit the mode that turns its executable into plain Node.
set "ELECTRON_RUN_AS_NODE="
if not defined ELECTRON_PATH (
  if exist "%CD%\node_modules\electron\dist\electron.exe" set "ELECTRON_PATH=%CD%\node_modules\electron\dist\electron.exe"
)
if not defined ELECTRON_PATH (
  for /f "delims=" %%I in ('where electron 2^>nul') do (
    if not defined ELECTRON_PATH set "ELECTRON_PATH=%%I"
  )
)
if not exist "%ELECTRON_PATH%" (
  echo Electron nao encontrado. Defina ELECTRON_PATH ou instale o pacote electron.
  exit /b 1
)

if not exist "%CD%\dist\main.js" (
  echo Rode npm run build antes de abrir o desktop.
  exit /b 1
)

rem Fail before starting a gateway when the Electron client baseline is incomplete or stale.
node "%CD%\scripts\verify-backend-artifacts.mjs"
if errorlevel 1 (
  echo Artefatos backend invalidos ou stale. Rode npm run build e tente novamente.
  exit /b 1
)
node "%CD%\scripts\verify-client-artifacts.mjs"
if errorlevel 1 (
  echo Artefatos do cliente Electron invalidos. Veja o manifest e as mensagens acima.
  exit /b 1
)

rem Explorer resolves taskbar name/icon from Start-menu registration, not only HWND metadata.
node "%CD%\scripts\setup-desktop-shortcut.mjs" --taskbar-only
if errorlevel 1 (
  echo Nao foi possivel confirmar a identidade OpenBot na barra de tarefas.
  exit /b 1
)

set "GATEWAY_STARTED=0"
set "GATEWAY_ADOPTED=0"
set "GATEWAY_PID="
set "GATEWAY_ERROR_LOG=%CD%\logs\start-gateway-%RANDOM%-%RANDOM%.log"
rem start-gateway performs the health/adopt/spawn/capture/write/readiness CAS.
rem The gateway-health.mjs" pid helper remains available for diagnostics.
for /f "tokens=1,2 delims=|" %%P in ('node "%CD%\scripts\start-gateway.mjs" --root "%OPENBOT_ROOT%" --url "http://127.0.0.1:1340" 2^>"%GATEWAY_ERROR_LOG%"') do (
  set "GATEWAY_PID=%%P"
  if "%%Q"=="adopted" set "GATEWAY_ADOPTED=1"
  if "%%Q"=="started" set "GATEWAY_STARTED=1"
)
if not defined GATEWAY_PID (
  echo Nao foi possivel iniciar o gateway. Veja "%GATEWAY_ERROR_LOG%".
  exit /b 1
)
for %%L in ("%GATEWAY_ERROR_LOG%") do if %%~zL==0 del /q "%%~fL" >nul 2>&1

rem start-gateway returns only after /health and executable/script identity
rem are verified; failures clean up its own child before returning nonzero.

:gateway_ready
rem Wipe inherited remote URLs above, then pin the proven local gateway for Electron.
set "SAND_HOST_GATEWAY_URL=http://127.0.0.1:1340"
set "SAND_DEV_BOX_CONTROL_PLANE=0"
set "SAND_DEV_CONTROL_PORT="
if not defined OPENBOT_USER_DATA set "OPENBOT_USER_DATA=%LOCALAPPDATA%\OpenBot\electron"
if not exist "%OPENBOT_USER_DATA%" mkdir "%OPENBOT_USER_DATA%"
set "OPENBOT_AUDIT_CDP_ARGS="
if defined OPENBOT_AUDIT_CDP_PORT (
  node -e "const p=Number(process.env.OPENBOT_AUDIT_CDP_PORT);process.exit(Number.isInteger(p)&&p>=1&&p<=65535?0:1)"
  if errorlevel 1 (
    echo OPENBOT_AUDIT_CDP_PORT deve ser uma porta valida entre 1 e 65535.
    if "%GATEWAY_STARTED%"=="1" node "%CD%\scripts\shutdown-gateway.mjs" --root "%OPENBOT_ROOT%" --pid "%GATEWAY_PID%" --url "http://127.0.0.1:1340" --remove-state >nul 2>&1
    exit /b 1
  )
  set "OPENBOT_AUDIT_CDP_ARGS=--remote-debugging-address=127.0.0.1 --remote-debugging-port=%OPENBOT_AUDIT_CDP_PORT% --remote-allow-origins=http://127.0.0.1:%OPENBOT_AUDIT_CDP_PORT%"
)

rem Aceleracao de GPU pode produzir uma janela inteiramente preta em alguns drivers Windows.
rem A segunda invocacao nao disputa o arquivo mantido aberto pela instancia primaria.
set "ELECTRON_STDIO_LOG=%CD%\logs\electron.log"
if "%GATEWAY_ADOPTED%"=="1" set "ELECTRON_STDIO_LOG=%CD%\logs\electron-secondary-%RANDOM%-%RANDOM%.log"
> "%ELECTRON_STDIO_LOG%" echo OpenBot Electron launcher started
"%ELECTRON_PATH%" --user-data-dir="%OPENBOT_USER_DATA%" --disable-gpu --enable-logging --log-file="%CD%\logs\electron-chromium.log" %OPENBOT_AUDIT_CDP_ARGS% "%CD%\scripts\openbot-electron.cjs" >> "%ELECTRON_STDIO_LOG%" 2>&1
set "ELECTRON_EXIT=%ERRORLEVEL%"

rem Codigo 23 identifica segunda instancia: a primaria continua dona do gateway.
if "%ELECTRON_EXIT%"=="23" (
  del /q "%ELECTRON_STDIO_LOG%" >nul 2>&1
  if "%GATEWAY_STARTED%"=="1" (
    set "ELECTRON_EXIT=0"
    goto cleanup_gateway
  )
  exit /b 0
)

rem Encerra somente o gateway iniciado por esta invocacao.
if "%GATEWAY_STARTED%"=="1" goto cleanup_gateway
exit /b %ELECTRON_EXIT%

:cleanup_gateway
node "%CD%\scripts\shutdown-gateway.mjs" --root "%OPENBOT_ROOT%" --pid "%GATEWAY_PID%" --url "http://127.0.0.1:1340" --remove-state >nul 2>&1
set "SHUTDOWN_EXIT=%ERRORLEVEL%"
if not "%SHUTDOWN_EXIT%"=="0" if "%ELECTRON_EXIT%"=="0" exit /b %SHUTDOWN_EXIT%
exit /b %ELECTRON_EXIT%
