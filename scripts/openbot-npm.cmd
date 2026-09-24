@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
if not exist "runtime\node\node.exe" (
  echo Runtime Node local ausente: runtime\node\node.exe
  exit /b 1
)
if not exist "runtime\node\npm.cmd" (
  echo npm local ausente: runtime\node\npm.cmd
  exit /b 1
)
set "PATH=%CD%\runtime\node;%PATH%"
set "ELECTRON_RUN_AS_NODE="
if exist "node_modules\electron\dist\electron.exe" (
  set "ELECTRON_PATH=%CD%\node_modules\electron\dist\electron.exe"
  set "ELECTRON_EXE=%CD%\node_modules\electron\dist\electron.exe"
)
for /f "delims=" %%T in ('node -p "require('fs').realpathSync.native(process.env.TEMP)"') do set "TEMP=%%T"
set "TMP=%TEMP%"
call "%CD%\runtime\node\npm.cmd" %*
exit /b %ERRORLEVEL%
