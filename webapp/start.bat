@echo off
cd /d "%~dp0"

where py >nul 2>&1
if %ERRORLEVEL%==0 (
    py server.py
    goto :eof
)

where python >nul 2>&1
if %ERRORLEVEL%==0 (
    python server.py
    goto :eof
)

echo Python was not found. Install it from https://www.python.org/downloads/ then run this again.
pause
