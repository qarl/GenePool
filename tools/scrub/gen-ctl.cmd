@echo off
REM gen-ctl launcher for Windows. The engine is portable (epoch pmath-1), so any Node/V8 produces identical runs.
REM Prefers system node; falls back to the packaged Electron run AS node (Windows ships electron.exe, not node.exe).
REM If your Electron lives elsewhere, set ELECTRON to its path before running, or edit the default below.
setlocal
set "SCRIPT=%~dp0gen-ctl.mjs"
where node >nul 2>nul
if %errorlevel%==0 (
  node "%SCRIPT%" %*
  exit /b %errorlevel%
)
if "%ELECTRON%"=="" set "ELECTRON=%~dp0..\..\desktop\node_modules\electron\dist\electron.exe"
set ELECTRON_RUN_AS_NODE=1
"%ELECTRON%" "%SCRIPT%" %*
exit /b %errorlevel%
