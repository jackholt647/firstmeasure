@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Launch-Customer-Mobile-Android.ps1"
echo.
echo Press any key to close this window.
pause >nul

