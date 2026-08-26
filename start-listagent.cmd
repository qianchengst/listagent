@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [listagent] Electron runtime is missing from node_modules\electron\dist.
  echo Please restore the complete portable package before starting.
  pause
  exit /b 1
)
rem %~dp0 ends with a backslash; append a dot so the closing quote is parsed correctly.
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
endlocal
