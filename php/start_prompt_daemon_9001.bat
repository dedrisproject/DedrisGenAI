@echo off
REM Start the PHP Prompt API daemon bound to port 9001.

setlocal
pushd "%~dp0"

set "PROMPT_API_HOST=127.0.0.1"
set "PROMPT_API_PORT=9001"

php prompt_api_daemon.php

popd
endlocal
