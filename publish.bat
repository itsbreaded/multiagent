@echo off
cd /d "%~dp0"

if "%GH_TOKEN%"=="" (
    echo ERROR: GH_TOKEN environment variable is not set.
    pause
    exit /b 1
)

for /f "tokens=2 delims=:, " %%v in ('findstr /r "\"version\"" package.json ^| findstr /v "electron\|node\|@"') do (
    set VERSION=%%~v
    goto :found
)
:found
set VERSION=%VERSION:"=%

echo Version: %VERSION%
set TAG=v%VERSION%

git tag %TAG% 2>nul
if %errorlevel% neq 0 (
    echo Tag %TAG% already exists, continuing...
)

git push origin %TAG%
if %errorlevel% neq 0 (
    echo WARNING: Could not push tag. It may already exist on remote.
)

echo Building and publishing release...
call npm run release
if %errorlevel% neq 0 (
    echo Build/publish failed.
    pause
    exit /b %errorlevel%
)

echo.
echo Done. Release %TAG% published to GitHub.
