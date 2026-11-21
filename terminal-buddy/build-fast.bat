@echo off
setlocal
set CARGO_INCREMENTAL=1
echo === Fast build (exe only) ===
cd /d "%~dp0"

echo Checking whether the build output is in use...
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\check-build-lock.ps1" -TargetExe "%~dp0src-tauri\target\release\terminal-buddy.exe"
if errorlevel 2 goto host_is_terminalbuddy
if errorlevel 1 goto kill_failed

:kill_done
echo Building Tauri app...
for /f %%t in ('powershell -NoProfile -NonInteractive -Command "[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()"') do set "BUILD_START_MS=%%t"
if not defined BUILD_START_MS set "BUILD_START_MS=0"
call npx tauri build --no-bundle
if errorlevel 1 (
    echo.
    echo Tauri build failed!
    pause
    exit /b 1
)
echo.
powershell -NoProfile -NonInteractive -Command "$start = %BUILD_START_MS%; $elapsed = if ($start -gt 0) { [Math]::Round(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $start) / 1000.0, 1).ToString() + 's' } else { '?' }; $exe = Get-Item '%~dp0src-tauri\target\release\terminal-buddy.exe'; $mb = [Math]::Round($exe.Length / 1MB, 2); Write-Host ('Build succeeded in ' + $elapsed + '! Output: ' + $exe.FullName + ' (' + $mb + ' MB)')"
pause
exit /b 0

:host_is_terminalbuddy
echo.
echo [ABORT] The running TerminalBuddy instance is the very exe this script builds
echo         (src-tauri\target\release\terminal-buddy.exe), so this script is running
echo         inside it and cannot close it without killing itself.
echo         Run the build from a console outside that instance:
echo           - Win+R ^> cmd.exe ^> cd /d "%~dp0" ^> build-fast.bat; or
echo           - close the release build and run it again.
echo.
echo         Note: instances started from other paths (Desktop, installed copy) no
echo         longer block the build and are left running.
echo.
pause
exit /b 1

:kill_failed
echo.
echo [ABORT] The build output is in use and could not be released automatically.
echo         See the messages above, close the holder manually and try again.
echo.
pause
exit /b 1
