@echo off
rem ===========================================================================
rem  no-glass-ele installer / setup checker
rem
rem  What it does:
rem    1. Checks Node.js  (required for everything)
rem    2. Checks Python   (optional - only the graphical UI needs it)
rem    3. Checks pywebview (optional - the UI dependency) and offers to install
rem    4. Prints the next steps
rem
rem  Usage:
rem    setup.cmd            check, and ask before installing anything
rem    setup.cmd /y         check, install missing optional deps without asking
rem    setup.cmd /check     check only, never install
rem
rem  It changes nothing outside this project except running "pip install
rem  pywebview" - and only when you agree to it.
rem
rem  NOTE: This file is intentionally pure ASCII. A .cmd containing UTF-8
rem        Chinese is mis-decoded under the default GBK console codepage,
rem        which shreds the rem lines into bogus commands. See README.md.
rem ===========================================================================
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
set "ASSUME_YES="
set "CHECK_ONLY="
if /i "%~1"=="/y"      set "ASSUME_YES=1"
if /i "%~1"=="/check"  set "CHECK_ONLY=1"

echo.
echo   no-glass-ele - setup check
echo   ==========================
echo.

if not exist "%ROOT%gen.js" (
  echo   [x] gen.js not found next to this script.
  echo       Run setup.cmd from the project root.
  pause
  exit /b 1
)

rem ---- 1) Node ---------------------------------------------------------------
set "NODE_OK="
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
if defined NODE_VER (
  set "NODE_OK=1"
  echo   [ok] Node.js      !NODE_VER!
) else (
  echo   [x]  Node.js      not found  ^(REQUIRED^)
)

rem ---- 2) PowerShell ---------------------------------------------------------
where powershell >nul 2>nul
if errorlevel 1 (
  echo   [x]  PowerShell   not found  ^(REQUIRED^)
  set "PS_OK="
) else (
  echo   [ok] PowerShell   available
  set "PS_OK=1"
)

rem ---- 3) Python -------------------------------------------------------------
set "PY="
where python  >nul 2>nul && set "PY=python"
if not defined PY ( where py >nul 2>nul && set "PY=py" )
if defined PY (
  for /f "delims=" %%v in ('%PY% --version 2^>^&1') do set "PY_VER=%%v"
  echo   [ok] Python 3     !PY_VER!  ^(optional - UI only^)
) else (
  echo   [--] Python 3     not found  ^(optional - UI only^)
)

rem ---- 4) pywebview ----------------------------------------------------------
set "WV_OK="
if defined PY (
  %PY% -c "import webview" >nul 2>nul
  if not errorlevel 1 (
    set "WV_OK=1"
    for /f "delims=" %%v in ('%PY% -c "import importlib.metadata as m; print(m.version('pywebview'))" 2^>nul') do set "WV_VER=%%v"
    echo   [ok] pywebview    !WV_VER!  ^(optional - UI only^)
  ) else (
    echo   [--] pywebview    not installed  ^(optional - UI only^)
  )
) else (
  echo   [--] pywebview    skipped  ^(no Python^)
)

echo.

rem ---- required missing -> stop ----------------------------------------------
if not defined NODE_OK goto :need_node
if not defined PS_OK   goto :need_ps

rem ---- optional missing -> offer install -------------------------------------
if defined WV_OK goto :ready
if defined CHECK_ONLY goto :ready

echo   The command line works without Python/pywebview.
echo   They are only needed for the graphical UI ^(ui\ui.cmd^).
echo.

if not defined PY goto :ready

set "DO_INSTALL="
if defined ASSUME_YES (
  set "DO_INSTALL=1"
) else (
  set /p "ANS=  Install pywebview now? [y/N] "
  if /i "!ANS!"=="y" set "DO_INSTALL=1"
)

if defined DO_INSTALL (
  echo.
  echo   Running: %PY% -m pip install pywebview
  %PY% -m pip install pywebview
  if errorlevel 1 (
    echo.
    echo   [x] Install failed. You can retry manually:
    echo       %PY% -m pip install pywebview
  ) else (
    echo.
    echo   [ok] pywebview installed.
  )
  echo.
)

:ready
echo   ---------------------------------------------
echo   Ready. Next steps:
echo.
echo     node gen.js env                     re-run this check
echo     node gen.js probe "C:\path\App.exe" --deep
echo     node gen.js new myapp --exe "C:\path\App.exe"
echo     node gen.js build myapp
echo     ui\ui.cmd                           open the graphical UI
echo.
echo   Full guide: README.md
echo.
pause
exit /b 0

:need_node
echo   Node.js is REQUIRED and was not found.
echo.
echo   Install Node 18 or newer: https://nodejs.org
echo   Then run setup.cmd again.
echo.
pause
exit /b 1

:need_ps
echo   PowerShell is REQUIRED and was not found.
echo.
echo   Windows PowerShell 5.1 ships with Windows 10/11 and is usually
echo   already present. Check: Settings - Apps - Optional features.
echo.
pause
exit /b 1
