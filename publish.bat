@echo off
cd /d "%~dp0"

if "%GH_TOKEN%"=="" (
    echo ERROR: GH_TOKEN environment variable is not set.
    pause
    exit /b 1
)

echo Building and publishing release...
call npm run release
if %errorlevel% neq 0 (
    echo Build/publish failed.
    pause
    exit /b %errorlevel%
)

echo.
echo Done. Release published to GitHub.
timeout /t 3 /nobreak >nul
