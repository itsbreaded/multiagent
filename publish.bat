@echo off
cd /d "%~dp0"
rem Cross-platform release entrypoint. Delegates to scripts/publish.mjs, which creates +
rem pushes the v<version> tag; the CI release workflow then builds + publishes the
rem win/mac/linux artifacts to the GitHub release. No local build, no GH_TOKEN needed.
node "%~dp0scripts\publish.mjs"
if %errorlevel% neq 0 (
    echo Release entrypoint failed.
    pause
    exit /b %errorlevel%
)