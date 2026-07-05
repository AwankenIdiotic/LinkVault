@echo off
cd /d "%~dp0"

where pyw >nul 2>&1
if %ERRORLEVEL%==0 (
    pyw server.py
    goto :eof
)

where pythonw >nul 2>&1
if %ERRORLEVEL%==0 (
    pythonw server.py
    goto :eof
)

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
