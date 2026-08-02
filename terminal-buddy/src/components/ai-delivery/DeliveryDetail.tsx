import {
  Check, CircleHelp, CircleStop, FileText, GitMerge, Layers3, Pause, Pencil, Play,
  Plus, RefreshCw, RotateCcw, ShieldCheck, Sparkles, SquareTerminal, Trash2
} from "lucide-react";
import { useState } from "react";
import type React from "react";
import { approveAiDelivery, pauseAiDelivery, resumeAiDelivery } from "../../services/tauri";
import { displayLocalPath, boardColumns, taskStateName, deliveryStateName,
  attemptStateName, mergeStateName, eventTypeName, isFailedEventType, isFailedAttemptState,
  formatEventTime, DeliveryTabId } from "./workspace-utils";
import { AttemptLiveTerminalDialog } from "./AttemptLiveTerminalDialog";
import { TaskDagView } from "./TaskDagView";
import { TaskNodeEditor } from "./TaskNodeEditor";
import type {
  AiAgent, AiAttempt, AiDecisionRequest,
  AiDelivery, AiDeliveryEvent, AiMergeRecord, AiProject, AiReviewGate, AiRole,
  AiTaskNode,
} from "../../types/aiDelivery";

// 交付看板详情组件所需的全部属性
export interface DeliveryDetailProps {
  // 数据
  project: AiProject;
  delivery: AiDelivery | null;
  deliveries: AiDelivery[];
  tasks: AiTaskNode[];
  agents: AiAgent[];
  roles: AiRole[];
  attempts: AiAttempt[];
  deliveryEvents: AiDeliveryEvent[];
  filteredDeliveries: AiDelivery[];
  filteredAttempts: AiAttempt[];
  filteredRecentDeliveryEvents: AiDeliveryEvent[];
  visibleTasks: AiTaskNode[];
  taskCountsByColumn: Map<string, number>;
  legacyTaskGraph: boolean;
  allTasksApproved: boolean;
  pendingDecisions: AiDecisionRequest[];
  lastMergeRecord: AiMergeRecord | undefined;
  // 状态
  deliveryId: string;
  activeTaskTab: DeliveryTabId;
  busy: string | null;
  showSuccessAttempts: boolean;
  showFailedAttempts: boolean;
  showSuccessEvents: boolean;
  showFailedEvents: boolean;
  loadingOutputId: string | null;
  decisionAnswers: Record<string, string>;
  // 派生数据
  reviewGateByTask: Map<string, AiReviewGate>;
  // 回调
  selectDelivery: (id: string) => Promise<void>;
  setActiveTaskTab: React.Dispatch<React.SetStateAction<DeliveryTabId>>;
  setSelectedTaskId: (id: string) => void;
  setShowDeliveryDialog: React.Dispatch<React.SetStateAction<boolean>>;
  setDecisionAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setShowSuccessAttempts: React.Dispatch<React.SetStateAction<boolean>>;
  setShowFailedAttempts: React.Dispatch<React.SetStateAction<boolean>>;
  setShowSuccessEvents: React.Dispatch<React.SetStateAction<boolean>>;
  setShowFailedEvents: React.Dispatch<React.SetStateAction<boolean>>;
  openManualTaskDialog: () => void;
  openDeliveryEditor: () => void;
  execute: (key: string, action: () => Promise<void>) => Promise<void>;
  dispatchAndStartReadyTasks: (deliveryId: string) => Promise<void> | Promise<number>;
  answerDecision: (request: AiDecisionRequest) => Promise<void>;
  retryTask: (task: AiTaskNode) => Promise<void>;
  runReview: (task: AiTaskNode) => Promise<void>;
  resolveReview: (gate: AiReviewGate, approved: boolean) => Promise<void>;
  toggleAttemptOutput: (attemptId: string) => Promise<void>;
  openAttemptTerminal: (terminalId: string) => void;
  cancelAttempt: (attempt: AiAttempt) => Promise<void>;
  completeAttempt: (attempt: AiAttempt) => Promise<void>;
  removeDelivery: () => Promise<void>;
  replanLegacyDelivery: () => void;
  cancelDelivery: () => Promise<void>;
  mergeDelivery: () => Promise<void>;
  cleanupDeliveryIntegration: () => Promise<void>;
  planAiDeliveryWithManager: (deliveryId: string) => Promise<unknown>;
  refresh: (projectId?: string, deliveryId?: string) => Promise<void>;
}

/** 交付看板详情：当项目已选择且存在交付时的看板视图。 */
export function DeliveryDetail(props: DeliveryDetailProps) {
  // 解构所有 props，使 JSX 中的变量名保持不变
  const {
    project, delivery, deliveries, tasks, agents, roles,
    attempts, deliveryEvents,
    filteredDeliveries, filteredAttempts, filteredRecentDeliveryEvents,
    visibleTasks, taskCountsByColumn, legacyTaskGraph, allTasksApproved,
    pendingDecisions, lastMergeRecord,
    deliveryId, activeTaskTab, busy,
    showSuccessAttempts, showFailedAttempts, showSuccessEvents, showFailedEvents,
    loadingOutputId, decisionAnswers,
    reviewGateByTask,
    selectDelivery, setActiveTaskTab, setSelectedTaskId,
    setShowDeliveryDialog,
    setDecisionAnswers,
    setShowSuccessAttempts, setShowFailedAttempts,
    setShowSuccessEvents, setShowFailedEvents,
    openManualTaskDialog, openDeliveryEditor,
    execute, dispatchAndStartReadyTasks,
    answerDecision, retryTask, runReview, resolveReview,
    toggleAttemptOutput, openAttemptTerminal,
    cancelAttempt, completeAttempt,
    removeDelivery, replanLegacyDelivery, cancelDelivery, mergeDelivery, cleanupDeliveryIntegration,
    planAiDeliveryWithManager, refresh,
  } = props;

  const [liveAttemptId, setLiveAttemptId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "dag">("list");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);

  return (
        <>
          <section className="ai-project-context">
            <div>
              <span>工作区</span>
              <strong>{project.name}</strong>
              <code>{displayLocalPath(project.workspaceRoot)}</code>
            </div>
            <div>
              <span>服务仓库</span>
              <strong>{project.repositories.length}</strong>
              <small>单仓库写入隔离</small>
            </div>
            <div>
              <span>并发配额</span>
              <strong>{project.maxConcurrency}</strong>
              <small>项目级运行任务</small>
            </div>
            <div>
              <span>质量门禁</span>
              <strong>{project.qualityGate.commands.length || "未配置"}</strong>
              <small>
                {project.qualityGate.commands.length
                  ? "命令已配置"
                  : "禁止自动合并"}
              </small>
            </div>
          </section>
          <section className="ai-delivery-layout">
            <aside className="ai-delivery-list">
              <div className="ai-section-heading">
                <h2>交付</h2>
               <div className="ai-section-actions">
                  <span>{filteredDeliveries.length}</span>
                  <button
                    type="button"
                    className="ai-icon-button"
                    title="新建交付"
                    aria-label="新建交付"
                    onClick={() => setShowDeliveryDialog(true)}
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </div>
              {filteredDeliveries.length === 0 ? (
                <p>{deliveries.length === 0 ? "尚无交付。点击右上角加号创建草案。" : "没有符合筛选条件的交付。"}</p>
              ) : (
                filteredDeliveries.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={item.id === deliveryId ? "active" : ""}
                    onClick={() => void selectDelivery(item.id)}
                  >
                    <strong>{item.title}</strong>
                    <small>{deliveryStateName(item.state)}</small>
                  </button>
                ))
              )}
            </aside>
            <section className="ai-delivery-board">
              {delivery ? (
                <>
                  <div className="ai-board-header">
                    <div>
                      <span className="ai-status-chip">
                        {deliveryStateName(delivery.state)}
                      </span>
                      <h2>{delivery.title}</h2>
                      <p>{delivery.requirement}</p>
                      {delivery.workflowName && (
                        <small className="ai-delivery-workflow-name">
                          编排：{delivery.workflowName} · {delivery.workflowSteps.length} 个步骤
                        </small>
                      )}
                    </div>
                    <div className="ai-board-actions">
                      {delivery.state === "drafting" &&
                        tasks.length === 0 && (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={busy === "update-delivery"}
                            onClick={openDeliveryEditor}
                          >
                            <Pencil size={15} />
                            {delivery.managerAgentId ? "编辑草案" : "设置管理者"}
                          </button>
                        )}
                      {delivery.state === "planning" && (
                        <button type="button" className="btn-secondary" disabled>
                          <RefreshCw className="ai-spin" size={15} />
                          正在生成任务图
                        </button>
                      )}
                      {["drafting", "cancelled", "failed", "succeeded", "completed"].includes(delivery.state) && (
                        <button
                          type="button"
                          className="btn-danger"
                          disabled={busy === "delete-delivery"}
                          onClick={() => void removeDelivery()}
                        >
                          <Trash2 size={15} />
                          {delivery.state === "drafting" ? "删除草稿" : "删除交付"}
                        </button>
                      )}
                      {delivery.state === "drafting" &&
                        delivery.managerAgentId &&
                        tasks.length === 0 && (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={busy === "plan"}
                            onClick={() =>
                              void execute("plan", async () => {
                                try {
                                  await planAiDeliveryWithManager(delivery.id);
                                } finally {
                                  await refresh(project.id, delivery.id);
                                }
                              })
                            }
                          >
                            <Sparkles size={15} />
                            生成任务图
                          </button>
                        )}
                      {["drafting", "awaitingApproval"].includes(delivery.state) && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={openManualTaskDialog}
                        >
                          <Plus size={15} />
                          新增任务
                        </button>
                      )}
                      {["drafting", "awaitingApproval"].includes(
                        delivery.state,
                      ) &&
                        tasks.length > 0 && (
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busy === "approve"}
                            onClick={() =>
                              void execute("approve", async () => {
                                await approveAiDelivery(delivery.id);
                                await dispatchAndStartReadyTasks(delivery.id);
                                await refresh(project.id, delivery.id);
                              })
                            }
                          >
                            <Check size={15} />
                            批准并开始执行
                          </button>
                        )}
                      {legacyTaskGraph && ["running", "paused"].includes(delivery.state) && (
                        <button
                          type="button"
                          className="btn-secondary"
                          title="保留旧任务图的历史记录，并按当前规则重新生成任务图"
                          disabled={busy === "replan"}
                          onClick={replanLegacyDelivery}
                        >
                          <RotateCcw size={15} />
                          重新规划
                        </button>
                      )}
                      {delivery.state === "running" && (
                        <>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busy === "dispatch"}
                            onClick={() =>
                              void execute("dispatch", async () => {
                                if (!await dispatchAndStartReadyTasks(delivery.id)) {
                                  throw new Error("当前没有可派发的任务。失败任务请先点击“重新派发”，其余任务会在前置依赖完成后自动进入待执行。");
                                }
                                await refresh(project.id, delivery.id);
                              })
                            }
                          >
                            <Play size={15} />
                            开始派发
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={busy === "pause"}
                            onClick={() =>
                              void execute("pause", async () => {
                                await pauseAiDelivery(delivery.id);
                                await refresh(project.id, delivery.id);
                              })
                            }
                          >
                            <Pause size={15} />
                            暂停派发
                          </button>
                        </>
                      )}
                      {delivery.state === "paused" && (
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={busy === "resume"}
                          onClick={() =>
                            void execute("resume", async () => {
                                await resumeAiDelivery(delivery.id);
                                await dispatchAndStartReadyTasks(delivery.id);
                              await refresh(project.id, delivery.id);
                            })
                          }
                        >
                          <Play size={15} />
                          恢复派发
                        </button>
                      )}
                      {["planning", "awaitingApproval", "running", "paused", "needsInput"].includes(delivery.state) && (
                        <button
                          type="button"
                          className="btn-danger"
                          disabled={busy === "cancel-delivery"}
                          onClick={() => void cancelDelivery()}
                        >
                          <CircleStop size={15} />
                          终止交付
                        </button>
                      )}
                      {delivery.state === "running" && allTasksApproved && (
                        <>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busy === "merge" || !project.qualityGate.commands.length}
                            title={project.qualityGate.commands.length ? "在本机目标分支执行集成验证并合并，不会推送远端" : "请先为项目配置质量门禁"}
                            onClick={() => void mergeDelivery()}
                          >
                            <GitMerge size={15} />
                            本地合并
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={busy === "cleanup-integration"}
                            title="清理该交付自动创建的临时集成 worktree 和集成分支，以便重新本地合并"
                            onClick={() => void cleanupDeliveryIntegration()}
                          >
                            <Trash2 size={15} />
                            清理集成工作区
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {lastMergeRecord && (
                    <p className="ai-merge-status">
                      最近本地合并：{mergeStateName(lastMergeRecord.state)}
                    </p>
                  )}
                  {pendingDecisions.length > 0 && (
                    <section className="ai-decision-panel" aria-label="待处理决策">
                      <div className="ai-decision-heading">
                        <CircleHelp size={17} />
                        <div>
                          <h3>需要你的决策</h3>
                          <p>回答后，相关任务会恢复到可调度状态。</p>
                        </div>
                      </div>
                      <div className="ai-decision-list">
                        {pendingDecisions.map((request) => {
                          const task = request.taskNodeId
                            ? tasks.find((item) => item.id === request.taskNodeId)
                            : null;
                          const answer = decisionAnswers[request.id] ?? "";
                          return (
                            <article key={request.id}>
                              <div>
                                <strong>{request.question}</strong>
                                {task && <small>关联任务：{task.title}</small>}
                              </div>
                              <p>{request.impact}</p>
                              {request.options.length > 0 && (
                                <div className="ai-decision-options">
                                  {request.options.map((option) => (
                                    <button
                                      type="button"
                                      key={option.label}
                                      className={answer === option.label ? "active" : ""}
                                      aria-pressed={answer === option.label}
                                      onClick={() =>
                                        setDecisionAnswers((current) => ({
                                          ...current,
                                          [request.id]: option.label,
                                        }))
                                      }
                                    >
                                      <strong>{option.label}</strong>
                                      {option.description && <small>{option.description}</small>}
                                    </button>
                                  ))}
                                </div>
                              )}
                              <div className="ai-decision-answer">
                                <textarea
                                  value={answer}
                                  placeholder="选择方案或输入你的决定"
                                  onChange={(event) =>
                                    setDecisionAnswers((current) => ({
                                      ...current,
                                      [request.id]: event.target.value,
                                    }))
                                  }
                                />
                                <button
                                  type="button"
                                  className="btn-primary"
                                  disabled={busy === `decision-${request.id}` || !answer.trim()}
                                  onClick={() => void answerDecision(request)}
                                >
                                  <Check size={14} />
                                  提交决定
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  )}
                  <section className="ai-task-panel" aria-label="交付任务">
                    <div className="ai-task-tabs" role="tablist" aria-label="任务状态">
                      {boardColumns.map((column) => {
                        const count = taskCountsByColumn.get(column.id) ?? 0;
                        const isActive = activeTaskTab === column.id;
                        return (
                          <button
                            type="button"
                            key={column.id}
                            role="tab"
                            className={isActive ? "active" : ""}
                            aria-selected={isActive}
                            onClick={() => setActiveTaskTab(column.id)}
                          >
                            <span>{column.title}</span>
                            <small>{count}</small>
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        role="tab"
                        className={activeTaskTab === "attempts" ? "active" : ""}
                        aria-selected={activeTaskTab === "attempts"}
                        onClick={() => setActiveTaskTab("attempts")}
                      >
                        <span>运行记录</span>
                        <small>{attempts.length}</small>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        className={activeTaskTab === "events" ? "active" : ""}
                        aria-selected={activeTaskTab === "events"}
                        onClick={() => setActiveTaskTab("events")}
                      >
                        <span>事件</span>
                        <small>{deliveryEvents.length}</small>
                      </button>
                    </div>
                    <div className="ai-detail-tabs">
                      <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")}>列表视图</button>
                      <button className={viewMode === "dag" ? "active" : ""} onClick={() => setViewMode("dag")}>DAG 视图</button>
                      {tasks.length > 5 && viewMode === "list" && (
                        <span className="ai-dag-hint">任务较多，建议切换 DAG 视图</span>
                      )}
                    </div>
                    {viewMode === "dag" ? (
                      <TaskDagView tasks={tasks} onNodeClick={(id) => setEditingTaskId(id)} />
                    ) : (
                      <>
                    {boardColumns.some((column) => column.id === activeTaskTab) && (
                    <div className="ai-task-list" role="tabpanel">
                      {visibleTasks.length === 0 && (
                        <p className="ai-task-list-empty">当前状态暂无任务</p>
                      )}
                      {visibleTasks.map((task) => {
                            const gate = reviewGateByTask.get(task.id);
                            const workflowStep = delivery.workflowSteps.find(
                              (step) => step.id === task.workflowStepId,
                            );
                            const plannedAgent = agents.find(
                              (agent) => agent.id === task.preferredAgentId,
                            );
                            return (
                              <article key={task.id}>
                                <div className="ai-task-summary">
                                  <div className="ai-task-title-row">
                                    <strong>{task.title}</strong>
                                    <span className="ai-status-chip">{taskStateName(task.state)}</span>
                                  </div>
                                  {workflowStep && (
                                    <small className="ai-task-workflow-step">
                                      步骤 {delivery.workflowSteps.indexOf(workflowStep) + 1} · {workflowStep.name}
                                      {plannedAgent ? ` · ${plannedAgent.name}` : ""}
                                    </small>
                                  )}
                                  <p>
                                    {project.repositories.find(
                                      (repo) => repo.id === task.targetRepositoryId,
                                    )?.name ?? "未识别服务"}
                                  </p>
                                  <small>{task.allowedWritePaths.join(", ")}</small>
                                  <small className="ai-task-artifacts">
                                    交付物：{task.expectedArtifacts.length ? task.expectedArtifacts.join("、") : "未声明"}
                                  </small>
                                  {gate?.comments && (
                                    <small className="ai-review-comment">
                                      审核：{gate.comments}
                                    </small>
                                  )}
                                </div>
                                <div className="ai-task-controls">
                                {task.state === "awaitingReview" && !gate && (
                                  <div className="ai-task-actions">
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      disabled={busy === `review-${task.id}`}
                                      onClick={() => void runReview(task)}
                                    >
                                      <ShieldCheck size={13} />
                                      运行质量门禁
                                    </button>
                                  </div>
                                )}
                                {task.state === "awaitingReview" &&
                                  gate?.state === "awaitingReviewer" && (
                                    <div className="ai-task-actions">
                                      <button
                                        type="button"
                                        className="btn-primary"
                                        disabled={busy === `resolve-review-${gate.id}`}
                                        onClick={() => void resolveReview(gate, true)}
                                      >
                                        <Check size={13} />
                                        通过审核
                                      </button>
                                      <button
                                        type="button"
                                        className="btn-secondary"
                                        disabled={busy === `resolve-review-${gate.id}`}
                                        onClick={() => void resolveReview(gate, false)}
                                      >
                                        <RotateCcw size={13} />
                                        退回返工
                                      </button>
                                    </div>
                                  )}
                                {["failed", "rework", "cancelled"].includes(task.state) && (
                                  <div className="ai-task-actions">
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      disabled={busy === `retry-${task.id}`}
                                      onClick={() => void retryTask(task)}
                                    >
                                      <RotateCcw size={13} />
                                      重新派发
                                    </button>
                                  </div>
                                )}
                                </div>
                                <button
                                  type="button"
                                  className="ai-task-inspect"
                                  title="查看任务契约"
                                  aria-label={`查看任务 ${task.title} 的契约`}
                                  onClick={() => setSelectedTaskId(task.id)}
                                >
                                  <FileText size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="ai-task-inspect"
                                  title="编辑任务"
                                  aria-label={`编辑任务 ${task.title}`}
                                  onClick={() => setEditingTaskId(task.id)}
                                >
                                  <Pencil size={14} />
                                </button>
                              </article>
                            );
                          })}
                    </div>
                    )}
                 {activeTaskTab === "attempts" && (
                   <div className="ai-delivery-tab-panel">
                  <section className="ai-delivery-events ai-attempt-list" aria-label="Agent 运行记录">
                    <div className="ai-delivery-events-heading">
                      <div>
                        <h3>Agent 运行记录</h3>
                        <p>原生终端会话与交付状态保持关联。</p>
                      </div>
                      <small>{filteredAttempts.length} / {attempts.length} 条</small>
                    </div>
                    <div className="ai-delivery-filter-bar" role="group" aria-label="运行记录筛选">
                      <span className="ai-delivery-filter-label">筛选</span>
                      <button
                        type="button"
                        className={`ai-delivery-filter-chip${showSuccessAttempts ? " active" : ""}`}
                        aria-pressed={showSuccessAttempts}
                        onClick={() => setShowSuccessAttempts((v) => !v)}
                      >
                        成功
                      </button>
                      <button
                        type="button"
                        className={`ai-delivery-filter-chip${showFailedAttempts ? " active" : ""}`}
                        aria-pressed={showFailedAttempts}
                        onClick={() => setShowFailedAttempts((v) => !v)}
                      >
                        失败
                      </button>
                    </div>
                    {filteredAttempts.length === 0 ? (
                      <p className="ai-delivery-events-empty">任务开始后将在此创建执行记录。</p>
                    ) : (
                      <ol>
                        {filteredAttempts.map((attempt) => {
                          const task = tasks.find((item) => item.id === attempt.taskNodeId);
                          const lastWorkflowStep = delivery.workflowSteps[delivery.workflowSteps.length - 1];
                          const canManuallyComplete = Boolean(
                            task?.workflowStepId &&
                            lastWorkflowStep &&
                            task.workflowStepId === lastWorkflowStep.id,
                          );
                          const attemptTitle = task?.title ??
                            (attempt.taskNodeId
                              ? "未命名任务"
                              : "管理者 · 生成任务图");
                          const attemptAgent = agents.find(
                            (agent) => agent.id === attempt.agentId,
                          );
                          const attemptEvents = deliveryEvents
                            .filter((event) => event.attemptId === attempt.id)
                            .slice(-160);
                          const isFailed = isFailedAttemptState(attempt.state);
                          return (
                            <li
                              key={attempt.id}
                              className={isFailed ? "ai-attempt-failed" : undefined}
                            >
                              <time dateTime={attempt.startedAt}>
                                {formatEventTime(attempt.startedAt)}
                              </time>
                              <div>
                                <strong>{attemptTitle}</strong>
                                <small className={isFailed ? "ai-state-failed" : undefined}>
                                  {attemptAgent?.name ?? "未知 Agent"} · {attemptStateName(attempt.state)}
                                  {attempt.exitCode !== null && attempt.exitCode !== undefined
                                    ? " · 退出码 " + attempt.exitCode
                                    : ""}
                                </small>
                               {attempt.summary && <p>{attempt.summary}</p>}
                               {/* 仅对非运行中的任务显示查看成果按钮 */}
                               {!["queued", "starting", "running"].includes(attempt.state) && (
                                <button
                                  type="button"
                                  className="btn-secondary ai-attempt-output-toggle"
                                  onClick={() => void toggleAttemptOutput(attempt.id)}
                                >
                                  {loadingOutputId === attempt.id ? "加载中..." : "查看成果"}
                                </button>
                               )}
                               {attemptEvents.length > 0 && (
                                  <pre className="ai-attempt-log">
                                    {attemptEvents.map((event) => "[" + event.occurredAt + "] " + event.message).join("\n")}
                                  </pre>
                                )}
                                {attempt.state === "running" && (
                                <div className="ai-attempt-actions">
                                  {attempt.terminalId && (
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      title="打开 Agent 终端"
                                      onClick={() => openAttemptTerminal(attempt.terminalId!)}
                                    >
                                      <SquareTerminal size={14} />
                                      打开终端
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="btn-secondary"
                                    title="实时查看终端输出"
                                    onClick={() => setLiveAttemptId(attempt.id)}
                                  >
                                    <SquareTerminal size={14} />
                                    实时终端
                                  </button>
                                  {attempt.taskNodeId && (
                                    <>
                                      {canManuallyComplete && <button
                                        type="button"
                                        className="btn-primary"
                                        title="确认 Agent 已完成，并执行任务校验"
                                        disabled={busy === "complete-attempt-" + attempt.id}
                                        onClick={() => void completeAttempt(attempt)}
                                      >
                                        <Check size={14} />
                                        确认完成
                                      </button>}
                                      <button
                                        type="button"
                                        className="btn-secondary"
                                        title="终止 Agent 执行"
                                        disabled={busy === "cancel-attempt-" + attempt.id}
                                        onClick={() => void cancelAttempt(attempt)}
                                      >
                                        <CircleStop size={14} />
                                        终止执行
                                      </button>
                                    </>
                                  )}
                                </div>
                                )}
                             </div>
                           </li>
                         );
                       })}
                     </ol>
                    )}
                  </section>
                    </div>
                  )}
                  {activeTaskTab === "events" && (
                    <div className="ai-delivery-tab-panel">
                  <section className="ai-delivery-events" aria-label="交付事件时间线">
                    <div className="ai-delivery-events-heading">
                      <div>
                        <h3>交付事件</h3>
                        <p>保留规划、派发、审查、门禁和本地合并的最近 20 条记录。</p>
                      </div>
                      <small>{filteredRecentDeliveryEvents.length} / {deliveryEvents.length} 条</small>
                    </div>
                    <div className="ai-delivery-filter-bar" role="group" aria-label="事件筛选">
                      <span className="ai-delivery-filter-label">筛选</span>
                      <button
                        type="button"
                        className={`ai-delivery-filter-chip${showSuccessEvents ? " active" : ""}`}
                        aria-pressed={showSuccessEvents}
                        onClick={() => setShowSuccessEvents((v) => !v)}
                      >
                        成功
                      </button>
                      <button
                        type="button"
                        className={`ai-delivery-filter-chip${showFailedEvents ? " active" : ""}`}
                        aria-pressed={showFailedEvents}
                        onClick={() => setShowFailedEvents((v) => !v)}
                      >
                        失败
                      </button>
                    </div>
                    {filteredRecentDeliveryEvents.length === 0 ? (
                      <p className="ai-delivery-events-empty">尚未产生交付事件。</p>
                    ) : (
                      <ol>
                        {filteredRecentDeliveryEvents.map((event) => {
                          const eventTask = event.taskNodeId
                            ? tasks.find((item) => item.id === event.taskNodeId)
                            : null;
                          return (
                            <li key={event.id} className={isFailedEventType(event.eventType) ? "ai-event-failed" : undefined}>
                              <time dateTime={event.occurredAt}>
                                {formatEventTime(event.occurredAt)}
                              </time>
                              <div>
                                <strong>{eventTypeName(event.eventType)}</strong>
                                {eventTask && <small>{eventTask.title}</small>}
                                {event.eventType === "approachingTimeout" && (
                                  <span className="ai-event-warning">即将超时</span>
                                )}
                                {event.eventType === "taskNodeEdited" && (
                                  <span className="ai-event-diff">{event.message}</span>
                                )}
                                {event.eventType === "taskNodeDeleted" && (
                                  <span className="ai-event-deleted">{event.message}</span>
                                )}
                                <p>{event.message}</p>
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </section>
                    </div>
                  )}
                      </>
                    )}
                  </section>
                </>
              ) : (
                <div className="ai-board-placeholder">
                  <Layers3 size={22} />
                  <p>选择一个交付，查看任务图和实时进度。</p>
                </div>
              )}
            </section>
          </section>
          {liveAttemptId && attempts.find((a) => a.id === liveAttemptId) && (
            <AttemptLiveTerminalDialog
              attempt={attempts.find((a) => a.id === liveAttemptId)!}
              onClose={() => setLiveAttemptId(null)}
            />
          )}
          {editingTaskId && tasks.find((t) => t.id === editingTaskId) && (
            <TaskNodeEditor
              task={tasks.find((t) => t.id === editingTaskId)!}
              agents={agents}
              roles={roles}
              project={project}
              deliveryTasks={tasks}
              onClose={() => setEditingTaskId(null)}
              onSaved={() => void refresh(project.id, deliveryId)}
            />
          )}
        </>
  );
}
