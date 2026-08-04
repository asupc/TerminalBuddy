import {
  Check, CircleHelp, CircleStop, Download, FileText, GitMerge, Layers3, Pause, Pencil, Play,
  Plus, RefreshCw, RotateCcw, ShieldCheck, Sparkles, SquareTerminal, Trash2
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type React from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  approveAiDelivery, confirmPolicyViolationSite, continueMergeAfterConflict,
  generateAiDeliveryReport, markAiTaskSkipped, pauseAiDelivery, resumeAiDelivery,
  writeFileContent,
} from "../../services/tauri";
import { displayLocalPath, boardColumns, taskStateName, deliveryStateName,
  attemptStateName, mergeStateName, eventTypeName, isFailedEventType, isFailedAttemptState,
  formatEventTime, DeliveryTabId } from "./workspace-utils";
import { AttemptLiveTerminalDialog } from "./AttemptLiveTerminalDialog";
import { EventListView } from "./EventListView";
import { ArtifactView } from "./ArtifactView";
import { TaskDagView } from "./TaskDagView";
import { TaskNodeEditor } from "./TaskNodeEditor";
import { Dialog } from "../shared/Dialog";
import { getAiDeliveryEvents, getAiReviewDiff, addAiReviewLineComment } from "../../services/tauri";
import { ReviewDiffView } from "./ReviewDiffView";
import type { ReviewComment } from "./ReviewDiffView";
import type { AiReviewDiffResult } from "../../types/aiDelivery";
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
  answeredRequests: AiDecisionRequest[];
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
  replanAcceptingCurrentState: () => void;
  cancelDelivery: () => Promise<void>;
  mergeDelivery: () => Promise<void>;
  cleanupDeliveryIntegration: () => Promise<void>;
  planAiDeliveryWithManager: (deliveryId: string) => Promise<unknown>;
  refresh: (projectId?: string, deliveryId?: string) => Promise<void>;
  // 批量操作
  selectedTaskIds: Set<string>;
  toggleTask: (id: string, shift: boolean) => void;
  batchDispatch: () => Promise<void>;
  batchRetry: () => Promise<void>;
  batchCancel: () => Promise<void>;
  retryAllFailed: () => Promise<void>;
  dispatchPhase: () => Promise<void>;
  phaseFilter: string;
  setPhaseFilter: React.Dispatch<React.SetStateAction<string>>;
  batchResult: string;
  openTemplatesDialog: () => void;
}

/** 计算 attempt 运行时长：已结束取 finishedAt，运行中取至今 */
function attemptDuration(attempt: AiAttempt): string {
  if (!attempt.startedAt) return "—";
  const end = attempt.finishedAt ? new Date(attempt.finishedAt).getTime() : Date.now();
  const start = new Date(attempt.startedAt).getTime();
  const secs = Math.max(0, Math.round((end - start) / 1000));
  return secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;
}

/** 交付看板详情：当项目已选择且存在交付时的看板视图。 */
export function DeliveryDetail(props: DeliveryDetailProps) {
  // 解构所有 props，使 JSX 中的变量名保持不变
  const {
    project, delivery, deliveries, tasks, agents, roles,
    attempts, deliveryEvents,
    filteredDeliveries, filteredAttempts, filteredRecentDeliveryEvents,
    visibleTasks, taskCountsByColumn, legacyTaskGraph, allTasksApproved,
    pendingDecisions, answeredRequests, lastMergeRecord,
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
    removeDelivery, replanLegacyDelivery, replanAcceptingCurrentState,
    cancelDelivery, mergeDelivery, cleanupDeliveryIntegration,
    planAiDeliveryWithManager, refresh,
    selectedTaskIds, toggleTask,
    batchDispatch, batchRetry, batchCancel, retryAllFailed, dispatchPhase,
    phaseFilter, setPhaseFilter, batchResult, openTemplatesDialog,
  } = props;

  const [liveAttemptId, setLiveAttemptId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [showAllEventsDialog, setShowAllEventsDialog] = useState(false);
  const [allEvents, setAllEvents] = useState<AiDeliveryEvent[] | null>(null);
  const [loadingAllEvents, setLoadingAllEvents] = useState(false);
  const [allEventsError, setAllEventsError] = useState<string | null>(null);
  const [reviewDiffState, setReviewDiffState] = useState<{
    task: AiTaskNode;
    data: AiReviewDiffResult;
    comments: Record<string, ReviewComment[]>;
  } | null>(null);
  const [reviewDiffLoading, setReviewDiffLoading] = useState(false);
  const [reviewDiffError, setReviewDiffError] = useState<string | null>(null);
  const [reportContent, setReportContent] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [reportError, setReportError] = useState("");
  const loadReport = useCallback(() => {
    if (!deliveryId) return;
    setReportBusy(true);
    setReportError("");
    void generateAiDeliveryReport(deliveryId)
      .then(setReportContent)
      .catch((reason) => setReportError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setReportBusy(false));
  }, [deliveryId]);
  const exportReport = async () => {
    if (!reportContent) return;
    setExportBusy(true);
    setReportError("");
    try {
      const selected = await save({
        title: "导出交付报告",
        defaultPath: `delivery-report-${delivery?.title ?? deliveryId}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (selected) {
        const ok = await writeFileContent(selected, reportContent);
        if (!ok) setReportError("导出失败：文件写入未完成");
      }
    } catch (reason) {
      setReportError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExportBusy(false);
    }
  };
  const openReviewDiff = (task: AiTaskNode) => {
    setReviewDiffLoading(true);
    setReviewDiffError(null);
    void getAiReviewDiff(deliveryId, task.id)
      .then((data) => {
        const gate = reviewGateByTask.get(task.id);
        const comments: Record<string, ReviewComment[]> = {};
        for (const item of gate?.lineComments ?? []) {
          (comments[item.path] ??= []).push({ line: item.line, text: item.text });
        }
        setReviewDiffState({ task, data, comments });
      })
      .catch((reason) => setReviewDiffError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setReviewDiffLoading(false));
  };
  const addDiffComment = (path: string, line: number, text: string) => {
    if (!reviewDiffState) return;
    const gate = reviewGateByTask.get(reviewDiffState.task.id);
    if (!gate) return;
    void addAiReviewLineComment(gate.id, path, line, text)
      .then(() => {
        setReviewDiffState((prev) => prev
          ? {
              ...prev,
              comments: {
                ...prev.comments,
                [path]: [...(prev.comments[path] ?? []), { line, text }],
              },
            }
          : prev);
      })
      .catch((reason) => setReviewDiffError(reason instanceof Error ? reason.message : String(reason)));
  };
  const openAllEventsDialog = () => {
    setShowAllEventsDialog(true);
    if (allEvents === null && !loadingAllEvents) {
      setLoadingAllEvents(true);
      setAllEventsError(null);
      void getAiDeliveryEvents(deliveryId)
        .then(setAllEvents)
        .catch((reason) => setAllEventsError(reason instanceof Error ? reason.message : String(reason)))
        .finally(() => setLoadingAllEvents(false));
    }
  };
  // 带参重试：从任务卡片进入编辑抽屉，保存后自动重新派发
  const [paramRetryTaskId, setParamRetryTaskId] = useState<string | null>(null);
  // 失败聚合：按 attempt.summary 首行聚类，取最高频 5 类
  const failureBuckets = useMemo(() => {
    const failed = attempts.filter((a) => a.state === "failed" && a.summary);
    const buckets = new Map<string, number>();
    failed.forEach((a) => {
      const key = (a.summary ?? "").split("\n")[0].slice(0, 40) || "未知原因";
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    });
    return [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [attempts]);
  const markSkipped = (task: AiTaskNode) =>
    void execute(`skip-${task.id}`, async () => {
      await markAiTaskSkipped(task.id);
      await refresh(project.id, deliveryId);
    });
  const confirmPvSite = (task: AiTaskNode) =>
    void execute(`confirm-pv-${task.id}`, async () => {
      await confirmPolicyViolationSite(task.id);
      await refresh(project.id, deliveryId);
    });

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
                      {!["cancelled"].includes(delivery.state) && (
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={busy !== null}
                          onClick={() => openTemplatesDialog()}
                          title="将当前交付保存为模板，或管理已有模板"
                        >
                          <FileText size={15} />
                          保存为模板
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
                      {delivery.state === "drafting"
                        && deliveryEvents.some((event) => event.eventType === "managerPlanFailed") && (
                        <button
                          type="button"
                          className="btn-secondary"
                          title="仓库状态与规划基线不一致导致任务图生成失败时，采纳当前状态直接重新规划"
                          disabled={busy === "replan-current-state"}
                          onClick={replanAcceptingCurrentState}
                        >
                          <RotateCcw size={15} />
                          采纳当前状态重跑
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
                    <>
                      <p className="ai-merge-status">
                        最近本地合并：{mergeStateName(lastMergeRecord.state)}
                      </p>
                      {lastMergeRecord.state === "blocked" &&
                        lastMergeRecord.repositories.some((repo) => repo.state === "failed") && (
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busy === "continue-merge"}
                            title="在冲突仓库中解决冲突并完成 merge 提交后，点击继续合并剩余仓库"
                            onClick={() =>
                              void execute("continue-merge", async () => {
                                await continueMergeAfterConflict(delivery.id);
                                await refresh(project.id, delivery.id);
                              })
                            }
                          >
                            <GitMerge size={15} />
                            冲突已解决，继续合并
                          </button>
                        )}
                      {lastMergeRecord.repositories.length > 0 && (
                        <div className="ai-merge-repos">
                          {lastMergeRecord.repositories.map((repo) => (
                            <div
                              key={repo.repositoryId}
                              className={`ai-merge-repo ${
                                repo.state === "failed" ? "ai-merge-repo-failed" : ""
                              }`}
                            >
                              <span className="ai-merge-repo-state">{repo.state}</span>
                              <code>{repo.branchName}</code>
                              <span className="ai-merge-repo-hash">
                                前 {repo.preMergeHead.slice(0, 8)}
                              </span>
                              {repo.mergedHead && (
                                <span className="ai-merge-repo-hash">
                                  后 {repo.mergedHead.slice(0, 8)}
                                </span>
                              )}
                              {repo.error && (
                                <pre className="ai-merge-repo-error">{repo.error}</pre>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
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
                  {answeredRequests.length > 0 && (
                    <section className="ai-decision-history" aria-label="已答决策历史">
                      <div className="ai-decision-heading">
                        <Sparkles size={17} />
                        <div>
                          <h3>已答决策历史</h3>
                          <p>用户已回答的决策请求，含选项与答复时间。</p>
                        </div>
                      </div>
                      <div className="ai-decision-list">
                        {answeredRequests.map((request) => {
                          const task = request.taskNodeId
                            ? tasks.find((item) => item.id === request.taskNodeId)
                            : null;
                          return (
                            <article key={request.id}>
                              <div>
                                <strong>{request.question}</strong>
                                {task && <small>关联任务：{task.title}</small>}
                              </div>
                              <p className="ai-decision-history-options">
                                选项：{request.options.map((option) => option.label).join(" / ")}
                              </p>
                              <div className="ai-decision-answer">
                                <span className="ai-decision-history-answer">
                                  回答：{request.answer ?? "（无）"}
                                </span>
                                <time dateTime={request.updatedAt}>
                                  {formatEventTime(request.updatedAt)}
                                </time>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  )}
                  <section className="ai-task-panel" aria-label="交付任务">
                    <div className="ai-task-tabs" role="tablist" aria-label="任务状态">
                      <button
                        type="button"
                        role="tab"
                        className={activeTaskTab === "dag" ? "active" : ""}
                        aria-selected={activeTaskTab === "dag"}
                        onClick={() => setActiveTaskTab("dag")}
                      >
                        <span>DAG</span>
                        <small>{tasks.length}</small>
                      </button>
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
                      <button
                        type="button"
                        role="tab"
                        className={activeTaskTab === "artifacts" ? "active" : ""}
                        aria-selected={activeTaskTab === "artifacts"}
                        onClick={() => setActiveTaskTab("artifacts")}
                      >
                        <span>产物</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        className={activeTaskTab === "report" ? "active" : ""}
                        aria-selected={activeTaskTab === "report"}
                        onClick={() => setActiveTaskTab("report")}
                      >
                        <span>报告</span>
                      </button>
                    </div>
                    {activeTaskTab === "dag" ? (
                      <TaskDagView tasks={tasks} onNodeClick={(id) => setEditingTaskId(id)} />
                    ) : (
                      <>
                    {boardColumns.some((column) => column.id === activeTaskTab) && (
                    <div className="ai-task-list" role="tabpanel">
                      {failureBuckets.length > 0 && (
                        <div className="ai-failure-aggregate">
                          <strong>
                            失败聚合（{failureBuckets.reduce((sum, [, count]) => sum + count, 0)} 次失败）
                          </strong>
                          {failureBuckets.map(([reason, count]) => (
                            <span key={reason} title={reason}>
                              {count} × {reason}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="ai-batch-bar">
                        <span>已选 {selectedTaskIds.size} 项</span>
                        <button type="button" className="btn-secondary" onClick={() => void batchDispatch()}>
                          批量派发
                        </button>
                        <button type="button" className="btn-secondary" onClick={() => void batchRetry()}>
                          批量重试
                        </button>
                        <button type="button" className="btn-secondary" onClick={() => void batchCancel()}>
                          批量取消
                        </button>
                        <button type="button" className="btn-secondary" onClick={() => void retryAllFailed()}>
                          重试所有失败
                        </button>
                        <select
                          value={phaseFilter}
                          onChange={(event) => setPhaseFilter(event.target.value)}
                          title="按编排阶段筛选后派发"
                        >
                          <option value="">全部阶段</option>
                          {delivery?.workflowSteps.map((step) => (
                            <option key={step.id} value={step.id}>{step.name}</option>
                          ))}
                        </select>
                        <button type="button" className="btn-secondary" onClick={() => void dispatchPhase()}>
                          派发所选阶段
                        </button>
                        {batchResult && <span className="ai-batch-result">{batchResult}</span>}
                      </div>
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
                              <article key={task.id} className={task.state === "skipped" ? "ai-task-skipped" : undefined}>
                                <label className="ai-task-select" title="多选任务（Shift 点击连选）">
                                  <input
                                    type="checkbox"
                                    checked={selectedTaskIds.has(task.id)}
                                    onChange={(event) =>
                                      toggleTask(task.id, (event.nativeEvent as MouseEvent).shiftKey)
                                    }
                                  />
                                </label>
                                <div className="ai-task-summary">
                                  <div className="ai-task-title-row">
                                    <span
                                      className={`ai-status-chip${task.state === "failed" ? " ai-status-chip-failed" : ""}`}
                                    >
                                      {taskStateName(task.state)}
                                    </span>
                                    <strong>{task.title}</strong>
                                  </div>
                                  {workflowStep && (
                                    <small className="ai-task-workflow-step">
                                      步骤 {delivery.workflowSteps.indexOf(workflowStep) + 1} · {workflowStep.name}
                                      {plannedAgent ? ` · ${plannedAgent.name}` : ""}
                                    </small>
                                  )}
                                  <small
                                    className={`ai-task-retry-limit${
                                      task.retryCount > 0 && task.attemptIds.length >= task.retryCount
                                        ? " ai-task-retry-exhausted"
                                        : ""
                                    }`}
                                    title="最大重试次数可在任务编辑（铅笔图标）中调整，0 = 不限"
                                  >
                                    重试 {task.attemptIds.length} / {task.retryCount === 0 ? "不限" : task.retryCount}
                                    {task.retryCount > 0 && task.attemptIds.length >= task.retryCount
                                      ? "（已触顶）"
                                      : ""}
                                  </small>
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
                                  {gate && gate.commandResults.length > 0 && (
                                    <div className="ai-gate-commands">
                                      {gate.commandResults.map((result, index) => (
                                        <div
                                          key={index}
                                          className={`ai-gate-command ${
                                            result.exitCode === 0
                                              ? "ai-gate-command-pass"
                                              : "ai-gate-command-fail"
                                          }`}
                                        >
                                          <span className="ai-gate-command-status">
                                            {result.exitCode === 0 ? "✓ 通过" : "✗ 失败"}
                                          </span>
                                          <code className="ai-gate-command-cmd">
                                            {result.command}
                                          </code>
                                          <span className="ai-gate-command-code">
                                            退出码 {result.exitCode}
                                          </span>
                                          {result.output && (
                                            <pre className="ai-gate-command-output">
                                              {result.output}
                                            </pre>
                                          )}
                                          {result.exitCode !== 0 && (
                                            <button
                                              type="button"
                                              className="btn-secondary"
                                              onClick={() =>
                                                void navigator.clipboard
                                                  .writeText(result.command)
                                                  .catch(() => {})
                                              }
                                            >
                                              复制命令
                                            </button>
                                          )}
                                        </div>
                                      ))}
                                    </div>
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
                                        className="btn-secondary"
                                        disabled={reviewDiffLoading}
                                        onClick={() => openReviewDiff(task)}
                                      >
                                        <FileText size={13} />
                                        查看代码变更
                                      </button>
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
                                {["failed", "rework", "cancelled", "policyViolation"].includes(task.state) && (
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
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      disabled={busy !== null}
                                      title="调整任务提示/优先 Agent/重试上限后自动重新派发"
                                      onClick={() => {
                                        setParamRetryTaskId(task.id);
                                        setEditingTaskId(task.id);
                                      }}
                                    >
                                      <Pencil size={13} />
                                      带参重试
                                    </button>
                                  </div>
                                )}
                                {task.state === "policyViolation" && (
                                  <div className="ai-task-actions">
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      disabled={busy === `confirm-pv-${task.id}`}
                                      title="人工确认越权现场可接受后，跳过静态审计重跑验收"
                                      onClick={() => confirmPvSite(task)}
                                    >
                                      <ShieldCheck size={13} />
                                      确认现场，继续验收
                                    </button>
                                  </div>
                                )}
                                {["failed", "policyViolation", "rework", "needsInput", "planned", "ready"].includes(task.state) && (
                                  <div className="ai-task-actions">
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      disabled={busy === `skip-${task.id}`}
                                      title={
                                        task.state === "planned" || task.state === "ready"
                                          ? "标记忽略：不再执行该任务并从交付范围移除，依赖它的下游任务会级联跳过"
                                          : "标记忽略后不再阻塞合并与交付收尾；依赖它的下游任务会级联跳过"
                                      }
                                      onClick={() => markSkipped(task)}
                                    >
                                      <CircleStop size={13} />
                                      标记忽略
                                    </button>
                                  </div>
                                )}
                                </div>
                                <div className="ai-task-actions-row">
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
                                </div>
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
                            .filter((event) => event.attemptId === attempt.id);
                          const isFailed = isFailedAttemptState(attempt.state);
                          return (
                            <li
                              key={attempt.id}
                              className={isFailed ? "ai-attempt-failed" : undefined}
                            >
                              <time dateTime={attempt.startedAt}>
                                {formatEventTime(attempt.startedAt)}
                                <span className="ai-attempt-duration">
                                  {" "}运行 {attemptDuration(attempt)}
                                </span>
                                {attempt.finishedAt && (
                                  <span className="ai-attempt-finished">
                                    {" "}完成于 {new Date(attempt.finishedAt).toLocaleString("zh-CN")}
                                  </span>
                                )}
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
                                  <EventListView events={attemptEvents} />
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
                        <p>保留规划、派发、审查、门禁和本地合并的事件记录。</p>
                      </div>
                      <div className="ai-event-list-heading-actions">
                        <small>{filteredRecentDeliveryEvents.length} / {deliveryEvents.length} 条</small>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={openAllEventsDialog}
                        >
                          查看全部
                        </button>
                      </div>
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
                  {activeTaskTab === "artifacts" && (
                    <div className="ai-delivery-tab-panel">
                      <ArtifactView delivery={delivery} deliveries={deliveries} />
                    </div>
                  )}
                  {activeTaskTab === "report" && (
                    <div className="ai-delivery-tab-panel">
                      <section className="ai-delivery-report" aria-label="交付收尾报告">
                        <div className="ai-report-toolbar">
                          <div>
                            <h3>交付收尾报告</h3>
                            <p>成功率 / 重试链 / 耗时 / 合并信息汇总，可导出 Markdown。</p>
                          </div>
                          <div className="ai-report-actions">
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => void loadReport()}
                              disabled={reportBusy}
                            >
                              <RefreshCw size={13} />
                              {reportBusy ? "生成中..." : "生成 / 刷新"}
                            </button>
                            <button
                              type="button"
                              className="btn-primary"
                              onClick={() => void exportReport()}
                              disabled={!reportContent || exportBusy}
                            >
                              <Download size={13} />
                              {exportBusy ? "导出中..." : "导出 .md"}
                            </button>
                          </div>
                        </div>
                        {reportError && <p className="ai-artifact-error">{reportError}</p>}
                        {reportContent && (
                          <pre className="ai-report-pre">{reportContent}</pre>
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
              onClose={() => {
                setEditingTaskId(null);
                setParamRetryTaskId(null);
              }}
              onSaved={() => void refresh(project.id, deliveryId)}
              onAfterSaved={
                paramRetryTaskId
                  ? async () => {
                      const target = tasks.find((item) => item.id === paramRetryTaskId);
                      setParamRetryTaskId(null);
                      if (target) await retryTask(target);
                    }
                  : undefined
              }
            />
          )}
          {showAllEventsDialog && (
            <Dialog
              title={`全部交付事件（${allEvents?.length ?? "…"} 条）`}
              onClose={() => setShowAllEventsDialog(false)}
              className="ai-all-events-dialog"
              style={{ width: 'min(760px, 92vw)', height: 'min(560px, 82vh)' }}
            >
              {loadingAllEvents ? (
                <p className="ai-delivery-events-empty">正在加载全部事件...</p>
              ) : allEventsError ? (
                <p className="ai-delivery-events-empty">加载失败：{allEventsError}</p>
              ) : allEvents ? (
                <EventListView events={allEvents} />
              ) : null}
            </Dialog>
          )}
          {(reviewDiffState || reviewDiffLoading || reviewDiffError) && (
            <Dialog
              title={`代码变更 — ${reviewDiffState?.task.title ?? "审查"}`}
              onClose={() => {
                setReviewDiffState(null);
                setReviewDiffError(null);
              }}
              className="ai-review-diff-dialog"
              style={{ width: 'min(1080px, 94vw)', height: 'min(720px, 90vh)' }}
            >
              {reviewDiffLoading ? (
                <p className="ai-delivery-events-empty">正在读取代码变更...</p>
              ) : reviewDiffError && !reviewDiffState ? (
                <p className="ai-delivery-events-empty">读取失败：{reviewDiffError}</p>
              ) : reviewDiffState ? (
                <>
                  <div className="ai-review-diff-meta">
                    <small>基线 {reviewDiffState.data.baseCommit.slice(0, 10)} → HEAD {reviewDiffState.data.headCommit.slice(0, 10)}</small>
                    {reviewDiffError && <small className="ai-review-diff-error">{reviewDiffError}</small>}
                  </div>
                  <ReviewDiffView
                    files={reviewDiffState.data.files}
                    diffs={reviewDiffState.data.diffs}
                    comments={reviewDiffState.comments}
                    onComment={addDiffComment}
                  />
                </>
              ) : null}
            </Dialog>
          )}
        </>
  );
}
