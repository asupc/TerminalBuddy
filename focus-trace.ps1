# focus-trace.ps1 - focus stealing tracer
$defs =
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' +
    '[DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);' +
    '[DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);' +
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);'

Add-Type -Namespace Focus -Name Tracker -MemberDefinition $defs

$log = Join-Path $env:USERPROFILE 'focus-trace.log'
$head = '=== started ' + (Get-Date).ToString() + ' ==='
$head | Out-File -Encoding utf8 $log
Write-Host ('monitoring... log: ' + $log + ' (Ctrl+C to stop)') -ForegroundColor Cyan

$prev = [IntPtr]::Zero
while ($true) {
    $h = [Focus.Tracker]::GetForegroundWindow()
    if ($h -ne $prev) {
        $len = [Focus.Tracker]::GetWindowTextLength($h)
        $sb = New-Object System.Text.StringBuilder ($len + 2)
        [void][Focus.Tracker]::GetWindowText($h, $sb, $len + 2)
        $procId = [uint32]0
        [void][Focus.Tracker]::GetWindowThreadProcessId($h, [ref]$procId)
        $pname = '?'
        $exe = '?'
        try {
            $pr = Get-Process -Id $procId -ErrorAction Stop
            $pname = $pr.ProcessName
            $exe = $pr.Path
        } catch {}
        $title = $sb.ToString()
        $ts = Get-Date -Format 'HH:mm:ss.fff'
        $line = $ts + '  ' + $pname + '  PID=' + $procId + '  [' + $title + ']  ' + $exe
        $line | Out-File -Append -Encoding utf8 $log
        Write-Host $line -ForegroundColor Yellow
        $prev = $h
    }
    Start-Sleep -Milliseconds 30
}
