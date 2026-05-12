@echo off
setlocal

echo ======================================
echo DayZ MCP - Full Index Build
echo ======================================
echo.

set SCRIPTS_PATH=P:/scripts

if not "%~1"=="" set SCRIPTS_PATH=%~1

P:
cd P:\enforce-mcp-dayz

if not exist node_modules (
  echo [1/4] Installing dependencies...
  call npm install
  if errorlevel 1 goto :error
)

echo [2/4] Building project...
call npm run build
if errorlevel 1 goto :error

echo [3/4] Indexing full scripts folder: %SCRIPTS_PATH%
call npm run index -- index %SCRIPTS_PATH% --clear
if errorlevel 1 goto :error

echo [4/4] Verifying index quality...
call npm run verify:index
if errorlevel 1 goto :error

echo.
echo Done. Full index is ready.
goto :end

:error
echo.
echo FAILED. Check errors above.

:end
echo.
pause
endlocal
