@echo off
rem ============================================================================
rem Kubera Installer Wrapper for Windows Command Prompt
rem Executes install.ps1 with ExecutionPolicy Bypass
rem ============================================================================
setlocal
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1" %*
exit /b %ERRORLEVEL%
