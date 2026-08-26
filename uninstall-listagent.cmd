@echo off
setlocal
set "LISTAGENT_DIR=%~dp0"
cd /d "%TEMP%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LISTAGENT_DIR%uninstall-listagent.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
