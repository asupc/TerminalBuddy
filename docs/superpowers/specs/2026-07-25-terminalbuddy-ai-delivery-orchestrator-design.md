# TerminalBuddy AI 交付团队编排器设计

**状态**：设计已收敛，待实现。

**取代范围**：本设计取代“运维 Agent 编排”作为 AI 编排功能的实施依据；旧草案保留为历史记录，不在其上继续开发。

**目标**：让用户把需求交给管理者 Agent，由其规划、派发、跟踪、审核并完成本机 Git 项目的多 Agent 交付。

## 1. 产品边界

本功能是本机优先的 AI 交付团队，不是云端 Agent 托管平台。

- Agent 仅使用本机已登录的 CLI：Codex、Claude Code、OpenCode，以及后续兼容的 CLI。
- 不配置或保存 OpenAI、Anthropic 等 API Key；认证由 CLI 自己的登录态管理。
- 一个 `Project` 是本机多 Git 仓库工作区，例如 `D:\kyber\platform_src`。
- 一个 Coder 任务只能写入一个服务仓库。跨服务需求必须由管理者拆分为多个单服务任务。
- Agent 可以自动创建 worktree、并发执行、通过门禁后合并到本地目标分支。
- 系统永不自动 `git push`、创建 Pull Request、部署、强制推送或执行破坏性操作。
- Web 端首期只提供远程观察、状态查看和用户决策；执行与 CLI 均在本机进行。

## 2. 核心原则

1. **确定性内核优先**：调度、状态机、权限、worktree、质量门禁和合并不依赖 LLM 判断。
2. **管理者只编排**：管理者 Agent 生成并调整任务图，不能绕过调度器直接启动进程或合并代码。
3. **任务契约优先于自然语言**：每次派发均有不可变的结构化 `TaskContract`；Prompt 是契约的渲染结果。
4. **单服务写入**：Coder 只能获得一个服务仓库的 worktree。Agent 需要另一个服务的改动时，管理者创建新的任务节点。
5. **独立验收**：产出者不能审核自己的改动；合并由 Reviewer 和可执行质量门禁共同决定。
6. **本地合并，不自动发布**：合并是本地 Git 操作，远端同步与部署永远是用户显式操作。

## 3. 领域模型

### 3.1 配置实体

| 实体 | 责任 |
|---|---|
| `Profile` | 复用现有终端配置：本机、SSH、Docker、K8s、启动路径、环境变量。它不保存模型密钥。 |
| `AgentRuntime` | 某个 CLI 的适配器与可用性，例如 `codex`、`claude`、`opencode`。定义启动、事件解析、取消与决策能力。 |
| `Agent` | 可被调度的成员，绑定 Runtime 与 Profile，设置最大并发数、可用角色和权限级别。 |
| `Role` | 项目经理、架构师、设计师、Coder、测试、Reviewer 等职责模板，定义候选 Agent 池、输入、产物、验收标准。 |
| `Project` | 多仓库工作区、仓库清单、目标分支、质量门禁、并发上限、worktree 根目录与自动合并策略。 |
| `Repository` | `Project` 中的一个 Git 仓库，含相对路径、默认分支、允许写入范围、仓库级构建/测试命令。 |

`Role` 默认只定义候选 Agent 池，管理者按容量、能力、项目策略和历史结果动态选择实际 Agent。用户可将某个 Role 锁定到指定 Agent。

### 3.2 运行实体

| 实体 | 责任 |
|---|---|
| `Delivery` | 用户提交的一次完整需求及其任务图。 |
| `TaskNode` | 一个可调度节点，包含依赖、角色、目标仓库、写入范围、产物和验收规则。 |
| `Attempt` | `TaskNode` 的一次实际执行，绑定 Agent、终端、worktree、分支和运行事件。 |
| `ReviewGate` | 独立审核与质量门禁的结果；通过后才可流转或合并。 |
| `DecisionRequest` | Agent 请求澄清、权限或产品决定时创建的待决策项。 |
| `TaskContract` | 执行前冻结的作用域和验收约束，Agent 无权自行扩大。 |

## 4. 多仓库与单服务隔离

`Project` 可指向 `D:\kyber\platform_src` 这样的工作区，但它本身不是 Git 仓库。系统发现并登记其子仓库。

一次 Coder `Attempt` 只为 `TaskContract.targetRepositoryId` 创建一个 worktree，例如：

```text
原始工作区
D:\kyber\platform_src\gateway
D:\kyber\platform_src\user-service

TASK-1 的工作目录
D:\kyber\.terminalbuddy-worktrees\platform_src\DEL-42\TASK-1\gateway
```

该 Agent 的 CWD 是任务 worktree，不是原始工作区根目录。跨服务需求应拆分：`gateway` 和 `user-service` 各由一个单服务 Coder 任务处理，再由只读的集成测试节点验证服务契约。

`TaskContract` 至少包含：

```text
targetRepositoryId
workingDirectory
allowedWritePaths
forbiddenRepositoryIds
inputArtifacts
expectedArtifacts
acceptanceCommands
timeoutMs
retryPolicy
```

首期采用逻辑隔离：仅向 Agent 提供目标 worktree、设定 CWD、在 Prompt 中声明作用域，并在执行前后审计所有已登记仓库的 Git 状态。发现目标仓库以外的改动即标记 `policyViolation`，禁止审核和合并。

本机 CLI 继承当前 Windows 用户权限，逻辑隔离不能从操作系统层面绝对阻止恶意或失控进程写入其他目录。严格物理隔离是后续可选 Runtime：受限账户、容器或 Windows Sandbox。没有物理隔离时，系统不得声称已从根本上阻止越权写入。

项目脚本若硬编码原始绝对路径，则不能并行运行在 worktree 中。项目应改用相对路径或 `PROJECT_ROOT` 环境变量；无法迁移的任务只能在原始目录串行运行，并禁止自动合并。

## 5. 交付流程与状态机

```text
用户需求
  -> 管理者生成结构化任务图
  -> 任务图校验与用户批准
  -> Scheduler 派发 ready 节点
  -> Agent Attempt 运行并上报事件
  -> 独立审核与质量门禁
  -> 后继节点、返工或本地合并
  -> 管理者汇总交付
```

`Delivery` 状态：`drafting -> awaitingApproval -> running -> needsInput | blocked | failed | completed | cancelled`。

`TaskNode` 状态：`planned -> ready -> running -> awaitingReview -> rework | needsInput | succeeded | failed | cancelled | policyViolation`。

进度以运行时事件、CLI 结构化输出、Hook、心跳、产物检查和命令退出码为准，不接受“Agent 声称已完成”作为完成证据。

## 6. 决策、权限与并发

管理者可自动回答项目预设范围内的常规问题。会改变需求、架构、成本或验收标准的问题进入 `needsInput`；权限升级、破坏性命令、部署和远端操作必须由用户批准。

默认配额如下，且 `Project` 与 `Agent` 设置均可覆盖：

| 范围 | 默认运行任务数 |
|---|---:|
| 项目 | 4 |
| 单个 Agent | 2 |
| 同一仓库的写入任务 | 2 |

Scheduler 必须同时检查全局、项目、Agent、仓库与依赖配额；任务完成、失败、取消或暂停时释放容量。除容量外，管理者还要根据 `allowedWritePaths` 避免并行任务修改同一模块。

## 7. 审核、质量门禁与本地合并

每个 `Project` 必须显式配置 `QualityGate`，否则任何任务都只能产出待审分支，禁止自动合并。

QualityGate 至少包括：

- 必跑构建、类型检查和测试命令。
- 独立 Reviewer Agent 对需求覆盖、diff、风险和产物的审核。
- 目标分支无冲突、基准 commit 可确认、任务作用域未违反策略。

多服务 Delivery 的合并流程：

1. 各服务任务在自己的 worktree 完成并通过仓库级门禁。
2. 创建集成验证工作区，合入所有候选分支后运行跨服务门禁。
3. 获取项目级集成锁，记录每个目标分支的合并前 commit。
4. 逐仓库合并到本地目标分支，绝不执行 `git push`。
5. 中途失败时，在锁持有且未发现外部改动的条件下恢复已变更的本地分支；否则标记 `blocked` 并保留完整恢复信息。

Git 不支持跨仓库原子提交，因此用户界面必须清楚展示任何“部分本地合并”的恢复状态。

## 8. Runtime 适配协议

每种 CLI Runtime 实现同一能力接口：

```text
detect() -> RuntimeCapabilities
start(TaskContract) -> AttemptHandle
subscribe(AttemptHandle) -> AgentEvent
respond(DecisionRequest, answer)
cancel(AttemptHandle)
recover(AttemptHandle)
```

首个高质量适配器为 Claude Code：复用既有 Hook，将其映射为统一的 `AgentEvent` 与 `DecisionRequest`。Codex、OpenCode 首期可先通过进程生命周期、结构化输出和心跳接入；缺少精确事件时明确降级为较粗粒度的进度状态。

## 9. 实施顺序

1. **P0：确定性执行内核**：Project/Repository、Runtime/Agent/Role 配置；仓库发现；单服务 worktree；任务契约；任务队列与配额。
2. **P1：可观测任务交付**：Delivery/TaskNode/Attempt 状态机、事件时间线、看板、终端跳转、Git 越权审计、手工派发。
3. **P2：质量与本地合并**：Reviewer、QualityGate、集成工作区、项目级集成锁、本地合并与恢复。
4. **P3：管理者 Agent**：以 JSON Schema 生成任务图、动态选择候选 Agent、处理阻塞与汇总进度。
5. **P4：严格隔离与远程观察**：受限 Runtime、Web 看板、审批和通知。

管理者 Agent 只能在 P0-P2 已稳定后接入；否则 LLM 的不确定性会掩盖 worktree、合并、状态机和权限模型的基础缺陷。
