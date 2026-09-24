@echo off
setlocal
echo === Fast build (exe only) ===
cd /d "%~dp0"


echo Checking running TerminalBuddy instances...
powershell -NoProfile -NonInteractive -Command "$ErrorActionPreference='SilentlyContinue'; $n='terminal-buddy.exe'; $anc=@(); $id=$PID; while($true){ $q=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id); if(-not $q){break}; $anc+=[int]$q.ProcessId; $id=[int]$q.ParentProcessId; if($id -le 0){break} }; $all=@(Get-CimInstance Win32_Process -Filter ('Name=''' + $n + '''')); if($all.Count -eq 0){ exit 0 }; if(@($all | Where-Object { $anc -contains [int]$_.ProcessId }).Count -gt 0){ exit 2 }; @($all | Where-Object { -not ($anc -contains [int]$_.ProcessId) }) | ForEach-Object { Write-Host ('Closing PID=' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0"
if errorlevel 2 goto host_is_terminalbuddy
if errorlevel 1 goto kill_failed

:kill_done
echo Building web frontend...
cd web
call npm run build
if errorlevel 1 (
    echo.
    echo Web build failed!
    cd ..
    pause
    exit /b 1
)
cd ..
echo Building Tauri app...
call npx tauri build --no-bundle
if errorlevel 1 (
    echo.
    echo Tauri build failed!
    pause
    exit /b 1
)
echo.
echo Build succeeded!
pause
exit /b 0

:host_is_terminalbuddy
echo.
echo [ABORT] This script is running INSIDE TerminalBuddy (default-terminal handoff is on).
echo         Killing the host process would close the whole app together with this
echo         script, and terminal-buddy.exe stays locked so the build cannot succeed.
echo         Run it from a console outside TerminalBuddy instead:
echo           - Settings ^> Behavior ^> Default Terminal: turn it off, then rerun; or
echo           - Win+R ^> cmd.exe ^> cd /d "%~dp0" ^> build-fast.bat
echo.
pause
exit /b 1

:kill_failed
echo.
echo [ABORT] Could not enumerate running TerminalBuddy processes.
echo         Close TerminalBuddy manually and try again.
echo.
pause
exit /b 1
