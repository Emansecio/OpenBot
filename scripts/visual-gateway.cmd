@echo off
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs
>logs\visual-gateway.log echo OpenBot visual gateway launcher
powershell.exe -NoProfile -Command "try { $h=Invoke-RestMethod 'http://127.0.0.1:1340/health' -TimeoutSec 2; if ($h.ok) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  >>logs\visual-gateway.log echo Gateway saudavel ja estava ativo
  exit /b 0
)
set OPENBOT_LOCAL_GATEWAY=1
:run
>>logs\visual-gateway.log echo starting gateway %DATE% %TIME%
npm start >>logs\visual-gateway.log 2>&1
>>logs\visual-gateway.log echo gateway exited %ERRORLEVEL% %DATE% %TIME%
timeout /t 2 /nobreak >nul
goto run
