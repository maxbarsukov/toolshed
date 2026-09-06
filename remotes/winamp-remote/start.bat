@echo off
chcp 65001 >nul
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
    py server.py
) else (
    python server.py
)

if %errorlevel% neq 0 (
    echo.
    echo Python not found or the server stopped with an error.
    echo Install Python from python.org and try again.
)
pause
