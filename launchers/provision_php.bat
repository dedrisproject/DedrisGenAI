@echo off
rem launchers\provision_php.bat - ensure portable PHP at runtimes\php\win\php.exe.
rem
rem Idempotent: skips if php.exe already runs (fast path).
rem Offline-safe: clear error with the exact URL if the download/extract fails.
rem No system install: PHP lives entirely inside runtimes\php\win\.
rem
rem Expects common.bat to have been CALLed first (defines PHP_DIR, PHP_BIN,
rem DEDRIS_PHP_URL, DEDRIS_PHP_ZIP, DEDRIS_PHP_SHA256, CACHE_DIR, DEDRIS_PHP_VERSION).
setlocal enabledelayedexpansion

if "%PHP_BIN%"=="" (
  echo [DedrisGenAI] ERROR: common.bat must be called before provision_php.bat. 1>&2
  endlocal & exit /b 1
)

rem --- 1) fast path: already provisioned ---------------------------------------
if exist "%PHP_BIN%" (
  "%PHP_BIN%" --version >nul 2>&1
  if not errorlevel 1 (
    echo [DedrisGenAI] Portable PHP already present at: %PHP_BIN%
    endlocal & exit /b 0
  )
  echo [DedrisGenAI] WARN: existing php.exe did not run; re-provisioning. 1>&2
)

if not exist "%PHP_DIR%" mkdir "%PHP_DIR%" >nul 2>&1
if not exist "%CACHE_DIR%" mkdir "%CACHE_DIR%" >nul 2>&1

set "ZIP_PATH=%CACHE_DIR%\%DEDRIS_PHP_ZIP%"

echo [DedrisGenAI] Provisioning portable PHP %DEDRIS_PHP_VERSION% ...
echo [DedrisGenAI]   Source: %DEDRIS_PHP_URL%

rem --- 2) download (PowerShell BITS/Invoke-WebRequest; works on Win10+) ---------
if not exist "%ZIP_PATH%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%DEDRIS_PHP_URL%' -OutFile '%ZIP_PATH%' -UseBasicParsing } catch { Write-Error $_; exit 1 }"
  if errorlevel 1 (
    echo [DedrisGenAI] ERROR: failed to download portable PHP. 1>&2
    echo [DedrisGenAI]   Try manually: download %DEDRIS_PHP_URL% 1>&2
    echo [DedrisGenAI]   then unzip into: %PHP_DIR% 1>&2
    del /q "%ZIP_PATH%" >nul 2>&1
    endlocal & exit /b 1
  )
)

rem --- 2b) best-effort SHA256 verification -------------------------------------
if not "%DEDRIS_PHP_SHA256%"=="" (
  for /f "usebackq delims=" %%H in (`powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 '%ZIP_PATH%').Hash.ToLower()" 2^>nul`) do set "GOT_SHA=%%H"
  if /i not "!GOT_SHA!"=="%DEDRIS_PHP_SHA256%" (
    echo [DedrisGenAI] WARN: PHP zip SHA256 mismatch (expected %DEDRIS_PHP_SHA256%, got !GOT_SHA!). 1>&2
    echo [DedrisGenAI] WARN: continuing, but the download may be a different build/version. 1>&2
  ) else (
    echo [DedrisGenAI]   SHA256 verified.
  )
)

rem --- 3) extract into PHP_DIR -------------------------------------------------
echo [DedrisGenAI] Extracting PHP into: %PHP_DIR%
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; try { Expand-Archive -LiteralPath '%ZIP_PATH%' -DestinationPath '%PHP_DIR%' -Force } catch { Write-Error $_; exit 1 }"
if errorlevel 1 (
  echo [DedrisGenAI] ERROR: failed to extract %ZIP_PATH% into %PHP_DIR%. 1>&2
  endlocal & exit /b 1
)

rem --- 3b) enable required extensions via a portable php.ini --------------------
rem The embeddable PHP zip ships php.ini-development/production but no active php.ini.
rem Write a minimal php.ini that enables the extensions the PHP UI needs.
if not exist "%PHP_DIR%\php.ini" (
  >  "%PHP_DIR%\php.ini" echo ; DedrisGenAI portable PHP config (auto-generated)
  >> "%PHP_DIR%\php.ini" echo extension_dir = "ext"
  >> "%PHP_DIR%\php.ini" echo extension=curl
  >> "%PHP_DIR%\php.ini" echo extension=mbstring
  >> "%PHP_DIR%\php.ini" echo extension=openssl
  >> "%PHP_DIR%\php.ini" echo extension=fileinfo
  >> "%PHP_DIR%\php.ini" echo cgi.fix_pathinfo = 1
)

rem --- 4) verify --------------------------------------------------------------
if not exist "%PHP_BIN%" (
  echo [DedrisGenAI] ERROR: php.exe not found after extraction at %PHP_BIN%. 1>&2
  endlocal & exit /b 1
)
"%PHP_BIN%" --version >nul 2>&1
if errorlevel 1 (
  echo [DedrisGenAI] ERROR: php.exe was extracted but does not run. 1>&2
  echo [DedrisGenAI]   You may need the Visual C++ Redistributable (x64) from Microsoft. 1>&2
  endlocal & exit /b 1
)

echo [DedrisGenAI] Portable PHP ready at: %PHP_BIN%
endlocal & exit /b 0
