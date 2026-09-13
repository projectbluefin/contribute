@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."

if "%1"=="review" goto review
if "%1"=="contribute" goto contribute

echo Usage: bluefin {contribute^|review}
exit /b 2

:review
shift
if exist "%REPO_ROOT%\bluefin-review.cmd" (
  "%REPO_ROOT%\bluefin-review.cmd" %*
) else (
  omp --profile review --extension "%REPO_ROOT%\image\extension\bluefin-review" %*
)
exit /b %ERRORLEVEL%

:contribute
shift
echo Bluefin Contribute on Windows requires WSL or Linux container runtime.
echo See https://github.com/projectbluefin/review for details.
exit /b 1
