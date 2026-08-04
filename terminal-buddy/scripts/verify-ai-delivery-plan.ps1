param(
    [string]$BaseUrl = "http://127.0.0.1:9600",
    [string]$TokenFile = "D:\TerminalBuddy\verify.token",
    [int]$PollSeconds = 6,
    [int]$MaxMinutes = 12
)

$ErrorActionPreference = "Stop"
$token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }

function Invoke-Api {
    param([string]$Method, [string]$Path, $Body = $null)
    $uri = "$BaseUrl$Path"
    if ($null -eq $Body) {
        return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -TimeoutSec 60
    }
    $json = $Body | ConvertTo-Json -Depth 12
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 60
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$delivery = Invoke-Api -Method Post -Path "/api/ai-delivery/deliveries" -Body @{
    projectId      = "11111111-2222-4333-8444-555555555555"
    title          = "规划链路验收-$stamp"
    requirement    = "分析 demo-repo 的 README 与 docs 目录，规划两步交付：先只读分析现状并产出结论文件，再编码实现新增一份团队约定文档并更新 README。"
    managerAgentId = "c9b3a292-8f2b-40c3-8b74-204d334b7cff"
    workflowId     = "7e9206d7-790d-40ac-9f9e-2b33335d352d"
}
$deliveryId = $delivery.id
Write-Output "DELIVERY_ID=$deliveryId STATE=$($delivery.state)"

$tasks = Invoke-Api -Method Post -Path "/api/ai-delivery/deliveries/$deliveryId/plan"
Write-Output "PLAN_RETURNED_TASKS=$($tasks.Count)"

$deadline = (Get-Date).AddMinutes($MaxMinutes)
$seenEvents = @{}
$final = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $PollSeconds
    $snapshot = Invoke-Api -Method Get -Path "/api/ai-delivery/deliveries/$deliveryId"
    $final = $snapshot
    foreach ($event in $snapshot.events) {
        if (-not $seenEvents.ContainsKey($event.id)) {
            $seenEvents[$event.id] = $true
            Write-Output ("EVENT [{0}] {1}: {2}" -f $event.occurredAt, $event.eventType, $event.message)
        }
    }
    if ($snapshot.delivery.state -ne "planning") {
        Write-Output "DELIVERY_STATE=$($snapshot.delivery.state) TASKS=$($snapshot.tasks.Count)"
        break
    }
}

if ($null -eq $final) { Write-Output "PLAN_POLL_TIMEOUT"; exit 2 }
$taskNodes = @($final.tasks)
Write-Output "FINAL_TASKS=$($taskNodes.Count)"
foreach ($t in $taskNodes) {
    Write-Output ("  TASK {0} | mode={1} | deps={2} | artifacts={3}" -f $t.title, $t.executionMode, ($t.dependencyIds -join ","), ($t.expectedArtifacts -join ","))
}
$ok = $taskNodes.Count -ge 2 -and
      $taskNodes[0].state -in @("planned", "ready", "queued", "running") -and
      @($taskNodes | Where-Object { -not $_.expectedArtifacts }).Count -eq 0
if ($ok) {
    Write-Output "PLAN_VERIFICATION_PASSED"
    exit 0
} else {
    Write-Output "PLAN_VERIFICATION_FAILED"
    exit 1
}
