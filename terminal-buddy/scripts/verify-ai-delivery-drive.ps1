param(
    [string]$BaseUrl = "http://127.0.0.1:9600",
    [string]$TokenFile = "D:\TerminalBuddy\verify.token",
    [int]$PollSeconds = 6,
    [int]$MaxMinutes = 25,
    [switch]$WithReview
)

$ErrorActionPreference = "Stop"
$token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }

function Invoke-Api {
    param([string]$Method, [string]$Path, $Body = $null)
    $uri = "$BaseUrl$Path"
    if ($null -eq $Body) {
        return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -TimeoutSec 30
    }
    $json = $Body | ConvertTo-Json -Depth 12
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 30
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$projectId = "11111111-2222-4333-8444-555555555555"
$repoId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
$workflowId = "7e9206d7-790d-40ac-9f9e-2b33335d352d"
$codexAgentId = "fe579391-843b-42be-990d-f87cc369fcca"

# 1. 创建交付（真实 Web API，不操作 UI）
$delivery = Invoke-Api -Method Post -Path "/api/ai-delivery/deliveries" -Body @{
    projectId     = $projectId
    title         = "命令行验收-$stamp"
    requirement   = "验证 AI 交付链路真实可用：通过命令行驱动创建、派发与推进。分析任务产出 analysis/cli-acceptance-1.md；编码任务产出 docs/cli-acceptance-2.md 并更新 README.md。"
    workflowId    = $workflowId
}
$deliveryId = $delivery.id
Write-Output "DELIVERY_ID=$deliveryId STATE=$($delivery.state)"

# 2. 添加任务 1：只读分析（依赖空）
$task1 = Invoke-Api -Method Post -Path "/api/ai-delivery/deliveries/$deliveryId/tasks" -Body @{
    deliveryId        = $deliveryId
    title             = "命令行验收-分析 demo-repo"
    description       = "只读分析 demo-repo 现状，输出结论文件。"
    taskPrompt        = "简要分析当前仓库（README 与目录结构），把分析结论写入 analysis/cli-acceptance-$stamp-1.md，然后退出 CLI。"
    executionMode     = "readonly"
    targetRepositoryId = $repoId
    allowedWritePaths = @("analysis")
    dependencyIds     = @()
    expectedArtifacts = @("analysis/cli-acceptance-$stamp-1.md")
    acceptanceCommands = @("Test-Path analysis/cli-acceptance-$stamp-1.md")
    retryCount        = 1
    preferredAgentId  = $codexAgentId
    roleId            = $null
    workflowStepId    = "d084fe47-c226-4ce1-ae80-ac831bda49f6"
}
Write-Output "TASK1_ID=$($task1.id) STATE=$($task1.state)"

# 3. 可选：添加审查任务（只读 + 有前置依赖 → 触发 review.json 协议链路）
$task2Deps = @($task1.id)
if ($WithReview) {
    $review = Invoke-Api -Method Post -Path "/api/ai-delivery/deliveries/$deliveryId/tasks" -Body @{
        deliveryId        = $deliveryId
        title             = "命令行验收-需求评审"
        description       = "评审前置分析结论，输出评审意见并完成平台审查协议（review.json）。"
        taskPrompt        = "阅读前置分析结论，检查其完整性与可执行性；把评审意见写入 analysis/cli-acceptance-$stamp-review.md，并按平台要求写入 review.json 后退出 CLI。"
        executionMode     = "readonly"
        targetRepositoryId = $repoId
        allowedWritePaths = @("analysis")
        dependencyIds     = @($task1.id)
        expectedArtifacts = @("analysis/cli-acceptance-$stamp-review.md")
        acceptanceCommands = @("Test-Path analysis/cli-acceptance-$stamp-review.md")
        retryCount        = 2
        preferredAgentId  = $codexAgentId
        roleId            = $null
        workflowStepId    = "e0f30d61-9f5d-4247-9b6c-afeb129c345a"
    }
    Write-Output "REVIEW_TASK_ID=$($review.id) STATE=$($review.state)"
    $task2Deps = @($task1.id, $review.id)
}

# 4. 添加任务：编码实现（依赖前置任务，验证任务推进）
$task2 = Invoke-Api -Method Post -Path "/api/ai-delivery/deliveries/$deliveryId/tasks" -Body @{
    deliveryId        = $deliveryId
    title             = "命令行验收-编码实现"
    description       = "新增团队约定文档并更新 README。"
    taskPrompt        = "在 docs/ 下新建 cli-acceptance-$stamp-2.md 记录本次验收结论，并在 README.md 追加一行验收记录，然后退出 CLI。"
    executionMode     = "write"
    targetRepositoryId = $repoId
    allowedWritePaths = @("docs", "README.md")
    dependencyIds     = $task2Deps
    expectedArtifacts = @("docs/cli-acceptance-$stamp-2.md", "README.md")
    acceptanceCommands = @(
        "test -f docs/cli-acceptance-$stamp-2.md",
        'test -z "$(git status --porcelain)"'
    )
    retryCount        = 1
    preferredAgentId  = $codexAgentId
    roleId            = $null
    workflowStepId    = "f55b3dfb-2857-4b6c-ad4a-f8a606305482"
}
Write-Output "TASK2_ID=$($task2.id) STATE=$($task2.state)"

# 5. 批准并派发就绪任务
$started = Invoke-Api -Method Post -Path "/api/ai-delivery/deliveries/$deliveryId/dispatch"
Write-Output "DISPATCH_STARTED=$($started.Count)"

# 6. 轮询到终态
$deadline = (Get-Date).AddMinutes($MaxMinutes)
$seenEvents = @{}
$terminalStates = @("completed", "succeeded", "failed", "cancelled")
$finalSnapshot = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $PollSeconds
    $snapshot = Invoke-Api -Method Get -Path "/api/ai-delivery/deliveries/$deliveryId"
    $finalSnapshot = $snapshot
    foreach ($event in $snapshot.events) {
        if (-not $seenEvents.ContainsKey($event.id)) {
            $seenEvents[$event.id] = $true
            Write-Output ("EVENT [{0}] {1}: {2}" -f $event.occurredAt, $event.eventType, $event.message)
        }
    }
    $taskStates = ($snapshot.tasks | ForEach-Object { "$($_.title):$($_.state)" }) -join " | "
    Write-Output ("SNAPSHOT delivery=$($snapshot.delivery.state) tasks=$taskStates")
    if ($terminalStates -contains $snapshot.delivery.state) {
        Write-Output "TERMINAL_STATE=$($snapshot.delivery.state)"
        break
    }
}

if ($null -eq $finalSnapshot) {
    Write-Output "POLL_TIMEOUT"
    exit 2
}
$ok = $finalSnapshot.delivery.state -in @("completed", "succeeded") -and
      @($finalSnapshot.tasks | Where-Object { $_.state -notin @("succeeded", "skipped") }).Count -eq 0
if ($ok) {
    Write-Output "VERIFICATION_PASSED"
    exit 0
} else {
    Write-Output "VERIFICATION_FAILED"
    exit 1
}
