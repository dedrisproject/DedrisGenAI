@echo off
rem launchers\common.bat - shared environment/setup for the Windows launcher.
rem Called (CALLed) by start.bat and the provision_*.bat helpers to define paths,
rem ports, and pinned runtime versions. Everything stays inside runtimes\.
rem
rem Usage: from start.bat:   call "%~dp0launchers\common.bat"
rem Caller must set REPO_ROOT before calling, OR this script derives it from its own
rem location (launchers\ -> parent is the repo root).

rem --- repo layout --------------------------------------------------------------
if "%REPO_ROOT%"=="" (
  rem %~dp0 is launchers\ (this file's dir, with trailing backslash). Parent = repo root.
  for %%I in ("%~dp0..") do set "REPO_ROOT=%%~fI"
)

set "LAUNCHERS_DIR=%REPO_ROOT%\launchers"
set "RUNTIMES_DIR=%REPO_ROOT%\runtimes"
set "ENGINE_DIR=%REPO_ROOT%\engine"
set "WEBUI_DIR=%REPO_ROOT%\webui"
set "CACHE_DIR=%RUNTIMES_DIR%\cache"

rem --- portable runtime locations (Windows side) --------------------------------
set "PHP_DIR=%RUNTIMES_DIR%\php\win"
set "PHP_BIN=%PHP_DIR%\php.exe"
set "PYTHON_DIR=%RUNTIMES_DIR%\python\win"
set "PYTHON_BIN=%PYTHON_DIR%\python.exe"

rem --- ports --------------------------------------------------------------------
if "%DEDRIS_ENGINE_PORT%"=="" set "DEDRIS_ENGINE_PORT=7866"
if "%DEDRIS_UI_PORT%"=="" set "DEDRIS_UI_PORT=8888"
if "%DEDRIS_HOST%"=="" set "DEDRIS_HOST=127.0.0.1"

rem --- pinned portable runtime versions / sources -------------------------------
rem Portable PHP (Windows non-thread-safe x64 zip from the official windows.php.net mirror).
if "%DEDRIS_PHP_VERSION%"=="" set "DEDRIS_PHP_VERSION=8.3.31"
set "DEDRIS_PHP_ZIP=php-%DEDRIS_PHP_VERSION%-nts-Win32-vs16-x64.zip"
set "DEDRIS_PHP_URL=https://downloads.php.net/~windows/releases/%DEDRIS_PHP_ZIP%"
rem Best-effort integrity check (SHA256 of the zip above). Verified against the
rem official sha256sum.txt; if a different version is set, this is skipped.
set "DEDRIS_PHP_SHA256=389c1327d325f6b6b3b892a5b2e1484ca5b5df775b6c4ddf5d1b5dc3b34ac761"

rem Portable Python (Windows embeddable amd64 zip). 3.11.9 is the last 3.11 with a
rem published embeddable build; it matches the engine's supported Python range.
if "%DEDRIS_PY_VERSION%"=="" set "DEDRIS_PY_VERSION=3.11.9"
set "DEDRIS_PY_ZIP=python-%DEDRIS_PY_VERSION%-embed-amd64.zip"
set "DEDRIS_PY_URL=https://www.python.org/ftp/python/%DEDRIS_PY_VERSION%/%DEDRIS_PY_ZIP%"
rem get-pip bootstrap for the embeddable interpreter (it ships without pip).
set "DEDRIS_GETPIP_URL=https://bootstrap.pypa.io/get-pip.py"

rem PyTorch CUDA wheel index (cu121) used on Windows/NVIDIA.
set "DEDRIS_TORCH_INDEX=https://download.pytorch.org/whl/cu121"

exit /b 0
