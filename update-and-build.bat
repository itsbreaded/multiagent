@echo off
echo Pulling latest changes...
git pull
if %errorlevel% neq 0 (
    echo Git pull failed.
    timeout /t 3 /nobreak >nul
    exit /b %errorlevel%
)

echo.
echo Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo npm install failed.
    timeout /t 3 /nobreak >nul
    exit /b %errorlevel%
)

echo.
echo Building...
call npm run dist
if %errorlevel% neq 0 (
    echo Build failed.
    timeout /t 3 /nobreak >nul
    exit /b %errorlevel%
)

echo.
echo Done. Output is in dist\win-unpacked\
timeout /t 3 /nobreak >nul
