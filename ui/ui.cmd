@echo off
rem ===========================================================================
rem  no-glass-ele management UI
rem  Starts the Python + pywebview desktop UI.
rem
rem  Usage:
rem    ui.cmd            launch the management UI
rem    ui.cmd --console  keep a console window (for debugging)
rem
rem  Requirements: Python 3 with pywebview installed, and Node 18+.
rem
rem  NOTE: This file is intentionally pure ASCII. A .cmd containing UTF-8
rem        Chinese is mis-decoded under the default GBK console codepage,
rem        which shreds the rem lines into bogus commands. See README.md.
rem ===========================================================================
setlocal

set "APPDIR=%~dp0"
set "APP=%APPDIR%app.py"

if not exist "%APP%" (
  echo [ui] Cannot find app.py next to this script.
  pause
  exit /b 1
)

rem Prefer pythonw (no console window); fall back to python.
set "PYW="
where pythonw >nul 2>nul && set "PYW=pythonw"
if "%PYW%"=="" (
  where python >nul 2>nul && set "PYW=python"
)
if "%PYW%"=="" (
  echo [ui] Python not found. Please install Python 3 first.
  echo [ui] Then install the GUI dependency:  pip install pywebview
  pause
  exit /b 1
)

if /i "%~1"=="--console" (
  set "PYW=python"
)

rem pythonw detaches: no console stays open, which is what a GUI wants.
if /i "%PYW%"=="pythonw" (
  start "" %PYW% "%APP%"
) else (
  %PYW% "%APP%"
  if errorlevel 1 pause
)
endlocal
