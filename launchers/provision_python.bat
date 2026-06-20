@echo off
rem launchers\provision_python.bat - ensure portable Python at runtimes\python\win\
rem with pip + torch (CUDA cu121) + engine requirements.
rem
rem Idempotent: skips download/install steps already done (fast path on torch import).
rem No system install: uses the official Windows EMBEDDABLE Python zip, unpacked into
rem runtimes\python\win\, then bootstraps pip into it. Nothing touches the system Python.
rem Offline-safe: clear errors with exact URLs on download failure.
rem
rem Expects common.bat to have been CALLed first.
setlocal enabledelayedexpansion

if "%PYTHON_BIN%"=="" (
  echo [DedrisGenAI] ERROR: common.bat must be called before provision_python.bat. 1>&2
  endlocal & exit /b 1
)

rem --- 1) fast path: torch already importable ---------------------------------
if exist "%PYTHON_BIN%" (
  "%PYTHON_BIN%" -c "import torch" >nul 2>&1
  if not errorlevel 1 (
    echo [DedrisGenAI] Portable Python already provisioned (torch present).
    endlocal & exit /b 0
  )
)

if not exist "%PYTHON_DIR%" mkdir "%PYTHON_DIR%" >nul 2>&1
if not exist "%CACHE_DIR%" mkdir "%CACHE_DIR%" >nul 2>&1

rem --- 2) download + unpack embeddable Python (if interpreter missing) ----------
if not exist "%PYTHON_BIN%" (
  set "PY_ZIP_PATH=%CACHE_DIR%\%DEDRIS_PY_ZIP%"
  echo [DedrisGenAI] Provisioning portable Python %DEDRIS_PY_VERSION% ...
  echo [DedrisGenAI]   Source: %DEDRIS_PY_URL%
  if not exist "!PY_ZIP_PATH!" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%DEDRIS_PY_URL%' -OutFile '!PY_ZIP_PATH!' -UseBasicParsing } catch { Write-Error $_; exit 1 }"
    if errorlevel 1 (
      echo [DedrisGenAI] ERROR: failed to download portable Python. 1>&2
      echo [DedrisGenAI]   Try manually: download %DEDRIS_PY_URL% 1>&2
      echo [DedrisGenAI]   then unzip into: %PYTHON_DIR% 1>&2
      del /q "!PY_ZIP_PATH!" >nul 2>&1
      endlocal & exit /b 1
    )
  )
  echo [DedrisGenAI] Extracting Python into: %PYTHON_DIR%
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; try { Expand-Archive -LiteralPath '!PY_ZIP_PATH!' -DestinationPath '%PYTHON_DIR%' -Force } catch { Write-Error $_; exit 1 }"
  if errorlevel 1 (
    echo [DedrisGenAI] ERROR: failed to extract Python zip into %PYTHON_DIR%. 1>&2
    endlocal & exit /b 1
  )
)

rem --- 2b) enable site-packages in the embeddable interpreter ------------------
rem The embeddable build ships a pythonNN._pth that comments out 'import site',
rem which disables pip and site-packages. We rewrite every *._pth to enable it.
for %%P in ("%PYTHON_DIR%\python*._pth") do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$f='%%~fP'; $c=Get-Content $f; $c = $c -replace '^\s*#\s*import site','import site'; if (($c -join \"`n\") -notmatch 'import site') { $c += 'import site' }; if (($c -join \"`n\") -notmatch 'Lib\\\\site-packages') { $c += 'Lib\site-packages' }; Set-Content -Path $f -Value $c"
)

rem --- 3) bootstrap pip into the embeddable interpreter ------------------------
"%PYTHON_BIN%" -m pip --version >nul 2>&1
if errorlevel 1 (
  set "GETPIP=%CACHE_DIR%\get-pip.py"
  echo [DedrisGenAI] Bootstrapping pip into portable Python ...
  if not exist "!GETPIP!" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%DEDRIS_GETPIP_URL%' -OutFile '!GETPIP!' -UseBasicParsing } catch { Write-Error $_; exit 1 }"
    if errorlevel 1 (
      echo [DedrisGenAI] ERROR: failed to download get-pip.py from %DEDRIS_GETPIP_URL% 1>&2
      endlocal & exit /b 1
    )
  )
  "%PYTHON_BIN%" "!GETPIP!" --no-warn-script-location
  if errorlevel 1 (
    echo [DedrisGenAI] ERROR: pip bootstrap failed. 1>&2
    endlocal & exit /b 1
  )
)

"%PYTHON_BIN%" -m pip install --upgrade pip setuptools wheel --no-warn-script-location
if errorlevel 1 echo [DedrisGenAI] WARN: pip self-upgrade failed (continuing). 1>&2

rem --- 4) install torch + torchvision (CUDA cu121) ----------------------------
"%PYTHON_BIN%" -c "import torch" >nul 2>&1
if errorlevel 1 (
  echo [DedrisGenAI] Installing torch + torchvision (CUDA cu121 - this can take a while) ...
  "%PYTHON_BIN%" -m pip install torch torchvision --extra-index-url %DEDRIS_TORCH_INDEX% --no-warn-script-location
  if errorlevel 1 (
    echo [DedrisGenAI] ERROR: failed to install torch/torchvision (CUDA). 1>&2
    echo [DedrisGenAI]   Retry, or run manually: 1>&2
    echo [DedrisGenAI]     "%PYTHON_BIN%" -m pip install torch torchvision --extra-index-url %DEDRIS_TORCH_INDEX% 1>&2
    endlocal & exit /b 1
  )
)

rem --- 5) install engine requirements -----------------------------------------
set "REQ=%ENGINE_DIR%\requirements_versions.txt"
if exist "%REQ%" (
  echo [DedrisGenAI] Installing engine requirements from: %REQ%
  "%PYTHON_BIN%" -m pip install -r "%REQ%" --no-warn-script-location
  if errorlevel 1 (
    echo [DedrisGenAI] ERROR: failed to install engine requirements. 1>&2
    echo [DedrisGenAI]   Retry, or run manually: 1>&2
    echo [DedrisGenAI]     "%PYTHON_BIN%" -m pip install -r "%REQ%" 1>&2
    endlocal & exit /b 1
  )
) else (
  echo [DedrisGenAI] WARN: engine\requirements_versions.txt not found at %REQ% (skipping). 1>&2
)

rem --- 6) verify --------------------------------------------------------------
"%PYTHON_BIN%" -c "import torch" >nul 2>&1
if errorlevel 1 (
  echo [DedrisGenAI] ERROR: torch still not importable after install. 1>&2
  endlocal & exit /b 1
)

echo [DedrisGenAI] Portable Python ready at: %PYTHON_DIR%
endlocal & exit /b 0
