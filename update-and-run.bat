@echo off
cd /d "%~dp0"
echo Pulling latest changes...
git pull
if %errorlevel% neq 0 (
    echo Git pull failed or no remote access - continuing with current code.
)

echo.
echo Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo npm install failed.
    pause
    exit /b %errorlevel%
)

echo.
echo Starting dev server...
call npm run dev
