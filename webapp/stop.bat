@echo off
echo Stopping Link Vault server...
powershell -NoProfile -Command "$myPid = $PID; Get-CimInstance Win32_Process -Filter \"CommandLine like '%%server.py%%'\" | Where-Object { $_.ProcessId -ne $myPid } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Done.
pause
