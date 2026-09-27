@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

rem Prefer the checkout's compatible runtime without changing the Windows PATH.
if exist "%CD%\runtime\node\node.exe" set "PATH=%CD%\runtime\node;%PATH%"
where node >nul 2>&1
if errorlevel 1 (
  echo Node nao encontrado. Instale o runtime local em runtime\node ou configure o Node no PATH.
  exit /b 5
)

rem Build checks, gateway ownership, Electron and teardown live in launch.mjs.
node "%CD%\scripts\launch.mjs" %*
exit /b %ERRORLEVEL%
