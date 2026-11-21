@echo off
setlocal
where gradle >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  gradle %*
  exit /b %ERRORLEVEL%
)
set "GRADLE_VERSION=9.3.1"
set "DIST=%USERPROFILE%\.gradle\wrapper\dists\gradle-%GRADLE_VERSION%\gradle-%GRADLE_VERSION%"
if exist "%DIST%\bin\gradle.bat" (
  call "%DIST%\bin\gradle.bat" %*
  exit /b %ERRORLEVEL%
)
echo Gradle %GRADLE_VERSION% is not installed. Please run the GitHub Actions build or install Gradle %GRADLE_VERSION%.
exit /b 1
