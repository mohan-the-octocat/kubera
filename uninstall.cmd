@echo off
rem ============================================================================
rem Kubera Uninstaller Wrapper for Windows Command Prompt
rem Executes uninstall.ps1 with ExecutionPolicy Bypass
rem ============================================================================
setlocal
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%uninstall.ps1" %*
exit /b %ERRORLEVEL%
