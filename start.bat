@echo off
REM YouTube Multi Viewer launcher
REM Starts a local HTTP server and opens the viewer in the default browser.

setlocal
cd /d "%~dp0"

set PORT=8080

REM Try Python 3 first (py launcher), then python, then python3
where py >nul 2>&1
if %ERRORLEVEL%==0 (
    set PY=py -3
    goto :run
)
where python >nul 2>&1
if %ERRORLEVEL%==0 (
    set PY=python
    goto :run
)
where python3 >nul 2>&1
if %ERRORLEVEL%==0 (
    set PY=python3
    goto :run
)

echo [ERROR] Python is not installed.
echo Please install Python 3 from https://www.python.org/ and try again.
echo Alternatively, you can open index.html directly (some videos may not work).
pause
exit /b 1

:run
echo Starting local server at http://localhost:%PORT%/
echo Press Ctrl+C in this window to stop the server.
echo.
start "" "http://localhost:%PORT%"
%PY% -m http.server %PORT% --bind 127.0.0.1
endlocal
