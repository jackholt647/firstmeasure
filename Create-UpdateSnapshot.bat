@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Create-UpdateSnapshot.ps1" %*
endlocal
