@echo off
rem start.bat - DedrisGenAI launcher for Windows (NVIDIA / CUDA).
rem
rem Thin entry point. Loads the shared launcher logic, provisions the portable
rem runtimes (PHP + Python/torch CUDA) on first run, starts the engine service and
rem the PHP UI server, then opens the browser at http://127.0.0.1:8888.
rem
rem   - Portable PHP -> runtimes\php\win\php.exe   (official NTS x64 zip)
rem   - Portable Py  -> runtimes\python\win\       (embeddable + pip + torch cu121)
rem   - Engine port  -> %DEDRIS_ENGINE_PORT%       (default 7866)
rem   - UI port      -> %DEDRIS_UI_PORT%           (default 8888)
rem
rem Everything stays inside this repo's runtimes\ folder. No system-wide installs.
setlocal

rem --- resolve repo root from this script's location (has trailing backslash) ---
set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
cd /d "%REPO_ROOT%" || (echo Cannot cd to repo root: %REPO_ROOT% & exit /b 1)

rem --- load shared config / paths ---------------------------------------------
call "%REPO_ROOT%\launchers\common.bat"
if errorlevel 1 (echo [DedrisGenAI] ERROR: failed to load launchers\common.bat & exit /b 1)

echo.
echo [DedrisGenAI] Starting (Windows / NVIDIA CUDA)
echo [DedrisGenAI] Repo:        %REPO_ROOT%
echo [DedrisGenAI] Engine port: %DEDRIS_ENGINE_PORT%    UI port: %DEDRIS_UI_PORT%
echo.

rem --- 1) provision portable runtimes (idempotent) ----------------------------
call "%REPO_ROOT%\launchers\provision_php.bat"
if errorlevel 1 (echo [DedrisGenAI] ERROR: PHP provisioning failed. & exit /b 1)

call "%REPO_ROOT%\launchers\provision_python.bat"
if errorlevel 1 (echo [DedrisGenAI] ERROR: Python provisioning failed. & exit /b 1)

rem --- sanity: required app files in place -------------------------------------
if not exist "%ENGINE_DIR%\server.py" (
  echo [DedrisGenAI] ERROR: engine\server.py not found (engine not built yet?). 1>&2
  exit /b 1
)
if not exist "%WEBUI_DIR%\public" (
  echo [DedrisGenAI] ERROR: webui\public not found (UI not built yet?). 1>&2
  exit /b 1
)

rem --- 2) start the engine service (CWD = engine\) -----------------------------
echo [DedrisGenAI] Starting engine: python server.py  (CWD=%ENGINE_DIR%, port %DEDRIS_ENGINE_PORT%)
echo [DedrisGenAI] First run loads models - this can take a minute ...
start "DedrisGenAI Engine" /D "%ENGINE_DIR%" "%PYTHON_BIN%" server.py

rem give the engine a head start before launching the UI / browser
call :wait_port %DEDRIS_HOST% %DEDRIS_ENGINE_PORT% 180 Engine

rem --- 3) start the PHP UI server ---------------------------------------------
set "PHP_DOCROOT=%WEBUI_DIR%\public"
set "PHP_ROUTER=%WEBUI_DIR%\public\router.php"
echo [DedrisGenAI] Starting PHP UI: php -S %DEDRIS_HOST%:%DEDRIS_UI_PORT% -t "%PHP_DOCROOT%"
if exist "%PHP_ROUTER%" (
  start "DedrisGenAI UI" /D "%REPO_ROOT%" "%PHP_BIN%" -S %DEDRIS_HOST%:%DEDRIS_UI_PORT% -t "%PHP_DOCROOT%" "%PHP_ROUTER%"
) else (
  echo [DedrisGenAI] WARN: router.php not found; serving without a front controller. 1>&2
  start "DedrisGenAI UI" /D "%REPO_ROOT%" "%PHP_BIN%" -S %DEDRIS_HOST%:%DEDRIS_UI_PORT% -t "%PHP_DOCROOT%"
)

call :wait_port %DEDRIS_HOST% %DEDRIS_UI_PORT% 30 "PHP UI"

rem --- 4) open the browser ----------------------------------------------------
set "UI_URL=http://%DEDRIS_HOST%:%DEDRIS_UI_PORT%"
echo.
echo [DedrisGenAI] DedrisGenAI is up. Opening: %UI_URL%
echo [DedrisGenAI] Close the "DedrisGenAI Engine" and "DedrisGenAI UI" windows to stop.
echo.
start "" "%UI_URL%"

endlocal
exit /b 0

rem ============================================================================
rem :wait_port HOST PORT TIMEOUT_SECONDS LABEL
rem Polls a TCP port (via PowerShell) until it accepts connections or times out.
rem ============================================================================
:wait_port
setlocal
set "WP_HOST=%~1"
set "WP_PORT=%~2"
set "WP_TIMEOUT=%~3"
set "WP_LABEL=%~4"
set /a WP_WAITED=0
:wait_port_loop
powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('%WP_HOST%',%WP_PORT%); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  endlocal & exit /b 0
)
if %WP_WAITED% GEQ %WP_TIMEOUT% (
  echo [DedrisGenAI] WARN: %WP_LABEL% did not open %WP_HOST%:%WP_PORT% within %WP_TIMEOUT%s (continuing). 1>&2
  endlocal & exit /b 1
)
timeout /t 1 /nobreak >nul
set /a WP_WAITED+=1
goto wait_port_loop
