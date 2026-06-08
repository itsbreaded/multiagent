@echo off
echo Pulling latest changes...
git pull
if %errorlevel% neq 0 (
    echo Git pull failed.
    pause
    exit /b %errorlevel%
)

echo.
echo Building...
npm run dist
if %errorlevel% neq 0 (
    echo Build failed.
    pause
    exit /b %errorlevel%
)

echo.
echo Done. Output is in dist\win-unpacked\
pause
