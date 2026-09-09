@echo off
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs
set "SCRIPT_DIR=%~dp0"
set "OPENBOT_VISUAL_TEST=1"
set "ELECTRON_EXE=C:\Users\User\AppData\Local\hermes\hermes-agent\apps\desktop\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
  echo Electron runtime nao encontrado: %ELECTRON_EXE%
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$root='%CD%'; $scripts='%SCRIPT_DIR%'; Add-Content -Path ($root+'\logs\visual-launcher.log') -Value 'launcher begin'; Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c',($scripts+'visual-gateway.cmd') -WorkingDirectory $root -WindowStyle Minimized; Start-Sleep -Seconds 3; Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c',($scripts+'visual-electron.cmd') -WorkingDirectory $root; Add-Content -Path ($root+'\logs\visual-launcher.log') -Value 'electron process requested'"
echo OpenBot visual client iniciado.
echo Logs: %CD%\logs\visual-gateway.log e visual-electron.log
echo Se o cliente falhar, mantenha esta janela aberta e envie os logs.
pause
