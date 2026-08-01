import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CircleStop,
  FileText,
  CircleAlert,
  FolderOpen,
  FolderGit2,
  GitMerge,
  Layers3,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  Users,
  WandSparkles,
  Workflow,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  AiAgent,
  AiAgentRuntime,
  AiAttempt,
  AiAttemptOutput,
  AiDecisionRequest,
  AiDelivery,
  AiDeliveryEvent,
  AiMergeRecord,
  AiProject,
  AiRepository,
  AiReviewGate,
  AiRole,
  AiRuntimeProbe,
  AiTaskNode,
  AiTaskContract,
  AiWorkflow,
} from "../types/aiDelivery";
import type { ExtraParamPreset } from "../types";
import {
  approveAiDelivery,
  answerAiDecisionRequest,
  cancelAiAttempt,
  cancelAiDelivery,
  completeAiAttempt,
  cleanupAiDeliveryIntegration,
  createAiDelivery,
  createAiProject,
  createAiTaskNode,
  deleteAiAgent,
  deleteAiDelivery,
  deleteAiProject,
  deleteAiRole,
  deleteAiRuntime,
  deleteAiWorkflow,
  dispatchAiReadyTasks,
  generateAiQualityGateCommands,
  getAiAgents,
  getAiAttempts,
  getAiDecisionRequests,
  getAiDeliveryEvents,
  getAiDeliveries,
  getAiMergeRecords,
  getAiProjects,
  getAiReviewGates,
  getAiRoles,
  getAiRuntimes,
  getAiTaskNodes,
  getAiTaskContracts,
  getAiWorkflows,
  mergeAiDeliveryLocally,
  onAiDeliveryEvent,
  planAiDeliveryWithManager,
  pauseAiDelivery,
  readClientData,
  replanLegacyAiDelivery,
  refreshAiProjectRepositories,
  resumeAiDelivery,
  readAiAttemptOutput,
  openInExplorer,
  resolveAiReviewGate,
  retryAiTaskNode,
  runAiQualityGate,
  saveAiAgent,
  saveAiRole,
  saveAiRuntime,
  saveAiWorkflow,
  startAiAttempt,
  updateAiDelivery,
  updateAiProject,
} from "../services/tauri";
import { Dialog } from "./Dialog";
 import { showConfirm } from "../services/dialog";
 import { AttemptOutputDialog } from "./AttemptOutputDialog";
import { getAppSettings, saveAppSettings } from "../utils/settings";
import "./AiDeliveryWorkspace.css";

const runtimeName = (kind: string) =>
  kind === "claude"
    ? "Claude Code"
    : kind === "opencode"
      ? "OpenCode"
      : kind === "hermes"
        ? "Hermes"
        : kind === "pi"
          ? "Pi"
          : kind === "mimo"
            ? "Mimo Code"
            : kind === "kimi"
              ? "Kimi Code"
              : "Codex";
const timestamp = () => new Date().toISOString();
const displayLocalPath = (path: string) => {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
};
const parseRuntimeArgs = (value: string) =>
  Array.from(
    value.matchAll(/(?:"([^"]*)")|(?:'([^']*)')|([^\s]+)/g),
    (match) => match[1] ?? match[2] ?? match[3],
  ).filter(Boolean);
const presetMatchesRuntime = (
  preset: ExtraParamPreset,
  runtime: AiAgentRuntime | undefined,
) => {
  const commandMatch = preset.commandMatch?.trim().toLowerCase();
  return !commandMatch || Boolean(runtime?.command.toLowerCase().includes(commandMatch));
};
const parseTaskLines = (value: string) =>
  value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);

const boardColumns = [
  { id: "planned", title: "待规划" },
  { id: "needsInput", title: "待决策" },
  { id: "ready", title: "待执行" },
  { id: "running", title: "执行中" },
  { id: "awaitingReview", title: "验收中" },
  { id: "done", title: "已完成" },
  { id: "failed", title: "异常" },
] as const;
type DeliveryTabId = (typeof boardColumns)[number]["id"] | "attempts" | "events";

function taskColumn(task: AiTaskNode) {
  if (task.state === "succeeded") return "done";
  if (task.state === "awaitingReview") return "awaitingReview";
  if (["running", "queued"].includes(task.state)) return "running";
  if (task.state === "needsInput") return "needsInput";
  if (task.state === "ready") return "ready";
  if (["failed", "cancelled", "rework", "policyViolation"].includes(task.state)) return "failed";
  return "planned";
}

const isLegacyTaskGraph = (delivery: AiDelivery, taskNodes: AiTaskNode[]) =>
  delivery.workflowSteps.length > 0 && taskNodes.some((task) =>
    !task.executionContext
      || task.expectedArtifacts.length === 0
      || task.expectedArtifacts.some((artifact) => /[\r\n]/.test(artifact) || artifact.includes("\uFF1A")),
  );

const taskStateNames: Record<string, string> = {
  planned: "待规划",
  ready: "待执行",
  queued: "已入队",
  running: "执行中",
  needsInput: "等待决策",
  awaitingReview: "验收中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  rework: "待返工",
  policyViolation: "策略违规",
};
const taskStateName = (state: string) => taskStateNames[state] ?? state;

const deliveryStateNames: Record<string, string> = {
  drafting: "草稿",
  planning: "正在生成任务图",
  awaitingApproval: "待批准",
  running: "执行中",
  needsInput: "等待决策",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  blocked: "已阻塞",
};
const deliveryStateName = (state: string) => deliveryStateNames[state] ?? state;

const ongoingDeliveryStates = new Set([
  "planning",
  "awaitingApproval",
  "running",
  "needsInput",
  "paused",
  "merging",
]);

const deliveryStateFilterGroups = [
  {
    id: "ongoing",
    title: "进行中",
    children: [
      { id: "planning", title: "正在生成任务图" },
      { id: "awaitingApproval", title: "待批准" },
      { id: "running", title: "执行中" },
      { id: "needsInput", title: "等待决策" },
      { id: "paused", title: "已暂停" },
      { id: "merging", title: "合并中" },
    ],
  },
  { id: "drafting", title: "草稿" },
  { id: "completed", title: "已完成" },
  { id: "succeeded", title: "已成功" },
  { id: "failed", title: "失败" },
  { id: "blocked", title: "已阻塞" },
  { id: "cancelled", title: "已取消" },
] as const;

const deliveryStateFilterIds = deliveryStateFilterGroups.flatMap((group) =>
  "children" in group ? group.children.map((child) => child.id) : [group.id],
);

const deliveryStateFilterById: Record<string, { id: string; title: string; matches: (state: string) => boolean }> = {};
((): void => {
  for (const group of deliveryStateFilterGroups) {
    if ('children' in group) {
      for (const child of group.children) {
        deliveryStateFilterById[child.id] = { id: child.id, title: child.title, matches: (state) => state === child.id };
      }
    } else {
      deliveryStateFilterById[group.id] = { id: group.id, title: group.title, matches: (state) => state === group.id };
    }
  }
})();const defaultDeliveryStateFilterIds = deliveryStateFilterIds;

const pickMostRecentDelivery = (items: AiDelivery[]) =>
  [...items].sort((left, right) => {
    const ongoingDifference = Number(ongoingDeliveryStates.has(right.state))
      - Number(ongoingDeliveryStates.has(left.state));
    return ongoingDifference || right.updatedAt.localeCompare(left.updatedAt);
  })[0];

const pickMostRecentProject = (items: AiProject[]) =>
  [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

const attemptStateNames: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  needsInput: "等待决策",
  policyViolation: "策略违规",
};
const attemptStateName = (state: string) => attemptStateNames[state] ?? state;

const mergeStateNames: Record<string, string> = {
  pending: "待合并",
  merging: "合并中",
  completed: "已完成",
  failed: "失败",
  rolledBack: "已回滚",
  rollbackFailed: "回滚失败",
  blocked: "已阻断",
};
const mergeStateName = (state: string) => mergeStateNames[state] ?? state;

const eventTypeNames: Record<string, string> = {
  deliveryCreated: "创建交付",
  deliveryEdited: "编辑交付",
  deliveryApproved: "批准执行",
  deliveryPaused: "暂停派发",
  deliveryResumed: "恢复派发",
  deliveryCancelled: "交付已终止",
  managerPlanStarted: "开始规划",
  managerPlanCreated: "任务图已生成",
  managerPlanFailed: "任务图生成失败",
  managerPlanRecovered: "恢复任务图",
  managerTerminalStarted: "管理者已启动",
  taskPlanned: "任务已规划",
  taskReady: "任务就绪",
  taskQueued: "任务已入队",
  taskRetryReady: "任务可重试",
  taskReworkRequested: "要求返工",
  dispatchDeferred: "派发暂缓",
  dispatchFailed: "派发失败",
  attemptStarted: "Agent 已启动",
  attemptCompleted: "任务执行完成",
  attemptFailed: "任务执行失败",
  attemptWatchdogCheck: "成果状态检查",
  workflowStepCompleted: "编排步骤完成",
  policyViolation: "策略违规",
  attemptStartFailed: "启动失败",
  attemptCancelled: "任务已取消",
  attemptTimedOut: "任务超时",
  attemptInterrupted: "应用重启中断",
  attemptAwaitingDecision: "等待决策",
  decisionRequested: "请求决策",
  decisionAnswered: "决策已答复",
  qualityGatePassed: "门禁通过",
  qualityGateFailed: "门禁失败",
  reviewerTerminalStarted: "审查已启动",
  reviewerCompleted: "审查完成",
  reviewerFailed: "审查失败",
  reviewApproved: "审查通过",
  reviewRework: "退回返工",
  integrationFailed: "集成验证失败",
  integrationWorkspaceCleaned: "集成工作区已清理",
  mergeFailed: "本地合并失败",
  mergedLocally: "已本地合并",
};

const eventTypeName = (eventType: string) => eventTypeNames[eventType] ?? eventType;

// 失败类事件类型集合（用于筛选）
const failedEventTypeSet = new Set(Object.keys(eventTypeNames).filter(
  (key) => key.endsWith("Failed") || key.endsWith("Cancelled") || key.endsWith("TimedOut") || key.endsWith("Interrupted") || key === "policyViolation",
));
const isFailedEventType = (eventType: string) => failedEventTypeSet.has(eventType);
// 执行记录失败状态集合（用于筛选和红色标记）
const failedAttemptStateSet = new Set(["failed", "cancelled", "policyViolation"]);
const isFailedAttemptState = (state: string) => failedAttemptStateSet.has(state);
const formatEventTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
};

export type AiDeliveryConfigView = "workflow" | "roles" | "runtimes" | "agents";

interface AiDeliveryWorkspaceProps {
  runtimes: AiRuntimeProbe[];
  isRuntimeDetecting: boolean;
  notificationTargetDeliveryId: string;
  onNotificationTargetHandled: () => void;
  configDialogView: AiDeliveryConfigView | null;
  onConfigDialogViewChange: (view: AiDeliveryConfigView | null) => void;
}

export function AiDeliveryWorkspace({
  runtimes,
  isRuntimeDetecting,
  notificationTargetDeliveryId,
  onNotificationTargetHandled,
  configDialogView,
  onConfigDialogViewChange,
}: AiDeliveryWorkspaceProps) {
  const [projects, setProjects] = useState<AiProject[]>([]);
  const [savedRuntimes, setSavedRuntimes] = useState<AiAgentRuntime[]>([]);
  const [configurationLoaded, setConfigurationLoaded] = useState(false);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [roles, setRoles] = useState<AiRole[]>([]);
  const [workflows, setWorkflows] = useState<AiWorkflow[]>([]);
  const [presets, setPresets] = useState<ExtraParamPreset[]>([]);
  const [deliveries, setDeliveries] = useState<AiDelivery[]>([]);
  const [tasks, setTasks] = useState<AiTaskNode[]>([]);
  const [taskContracts, setTaskContracts] = useState<AiTaskContract[]>([]);
  const [reviewGates, setReviewGates] = useState<AiReviewGate[]>([]);
  const [decisionRequests, setDecisionRequests] = useState<AiDecisionRequest[]>([]);
  const [decisionAnswers, setDecisionAnswers] = useState<Record<string, string>>({});
  const [mergeRecords, setMergeRecords] = useState<AiMergeRecord[]>([]);
  const [attempts, setAttempts] = useState<AiAttempt[]>([]);
  const [deliveryEvents, setDeliveryEvents] = useState<AiDeliveryEvent[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
 const [activeTaskTab, setActiveTaskTab] = useState<DeliveryTabId>("planned");
 const [projectId, setProjectId] = useState("");
  const [showSuccessAttempts, setShowSuccessAttempts] = useState(true);
const [showFailedAttempts, setShowFailedAttempts] = useState(true);
const [expandedOutputId, setExpandedOutputId] = useState<string | null>(null);
const [attemptOutputMap, setAttemptOutputMap] = useState<Record<string, AiAttemptOutput>>({});
 const [loadingOutputId, setLoadingOutputId] = useState<string | null>(null);
  const [showSuccessEvents, setShowSuccessEvents] = useState(true);
  const [showFailedEvents, setShowFailedEvents] = useState(true);
  const [selectedDeliveryStateFilters, setSelectedDeliveryStateFilters] = useState<string[]>(() => {
    const saved = getAppSettings().aiDeliveryStateFilters;
    return saved === null
      ? [...defaultDeliveryStateFilterIds]
      : saved.filter((id) => (id in deliveryStateFilterById));
  });
  const [deliveryId, setDeliveryId] = useState("");
  const [showProjectForm, setShowProjectForm] = useState(false);
 const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showProjectOverview, setShowProjectOverview] = useState(false);
 const [configDialogReturn, setConfigDialogReturn] = useState<
    "create" | "edit" | null
  >(null);
  const [showDeliveryDialog, setShowDeliveryDialog] = useState(false);
  const [showDeliveryEditDialog, setShowDeliveryEditDialog] = useState(false);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [qualityCommands, setQualityCommands] = useState("");
  const [editProjectName, setEditProjectName] = useState("");
  const [editProjectQualityCommands, setEditProjectQualityCommands] = useState("");
  const [editProjectMaxConcurrency, setEditProjectMaxConcurrency] = useState("4");
  const [editProjectRepositories, setEditProjectRepositories] = useState<AiRepository[]>([]);
  const [deliveryTitle, setDeliveryTitle] = useState("");
  const [requirement, setRequirement] = useState("");
  const [managerId, setManagerId] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [editDeliveryTitle, setEditDeliveryTitle] = useState("");
  const [editRequirement, setEditRequirement] = useState("");
  const [editManagerId, setEditManagerId] = useState("");
  const [editWorkflowId, setEditWorkflowId] = useState("");
  const [manualTaskTitle, setManualTaskTitle] = useState("");
  const [manualTaskDescription, setManualTaskDescription] = useState("");
  const [manualTaskPrompt, setManualTaskPrompt] = useState("");
  const [manualTaskRepositoryId, setManualTaskRepositoryId] = useState("");
  const [manualTaskExecutionMode, setManualTaskExecutionMode] = useState<"write" | "readonly">("write");
  const [manualTaskExecutionContext, setManualTaskExecutionContext] = useState<"workspaceRoot" | "taskWorktree">("taskWorktree");
  const [manualTaskAllowedPaths, setManualTaskAllowedPaths] = useState(".");
  const [manualTaskInputArtifacts, setManualTaskInputArtifacts] = useState("");
  const [manualTaskExpectedArtifacts, setManualTaskExpectedArtifacts] = useState("");
  const [manualTaskAcceptanceCommands, setManualTaskAcceptanceCommands] = useState("");
  const [manualTaskRoleId, setManualTaskRoleId] = useState("");
  const [manualTaskAgentId, setManualTaskAgentId] = useState("");
  const [manualTaskDependencyIds, setManualTaskDependencyIds] = useState<string[]>([]);
  const [manualTaskRetryCount, setManualTaskRetryCount] = useState("0");
  const [showRuntimeCreate, setShowRuntimeCreate] = useState(false);
  const [newRuntimeName, setNewRuntimeName] = useState("");
  const [newRuntimeKind, setNewRuntimeKind] = useState("");
  const [newRuntimeCommand, setNewRuntimeCommand] = useState("");
  const [expandedWorkflowId, setExpandedWorkflowId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);  const [error, setError] = useState("");
  const liveRefreshInProgress = useRef(false);
  const runtimeSyncInProgress = useRef(false);

  useEffect(() => {
    const syncSavedFilters = () => {
      const saved = getAppSettings().aiDeliveryStateFilters;
      const next = saved === null
        ? [...defaultDeliveryStateFilterIds]
        : saved.filter((id) => (id in deliveryStateFilterById));
      setSelectedDeliveryStateFilters((current) => {
        if (current.length === next.length && current.every((id, index) => id === next[index])) return current;
        return next;
      });
    };
    syncSavedFilters();
    window.addEventListener("app-settings-changed", syncSavedFilters);
    return () => window.removeEventListener("app-settings-changed", syncSavedFilters);
  }, []);

  const project = useMemo(
    () => projects.find((item) => item.id === projectId) ?? null,
    [projectId, projects],
  );
  const delivery = useMemo(
    () => deliveries.find((item) => item.id === deliveryId) ?? null,
    [deliveries, deliveryId],
  );
  const legacyTaskGraph = useMemo(
    () => Boolean(delivery && isLegacyTaskGraph(delivery, tasks)),
    [delivery, tasks],
  );
  const taskCountsByColumn = useMemo(
    () => new Map(
      boardColumns.map((column) => [
        column.id,
        tasks.filter((task) => taskColumn(task) === column.id).length,
      ]),
    ),
    [tasks],
  );
  const visibleTasks = useMemo(
    () => boardColumns.every((column) => column.id !== activeTaskTab)
      ? []
      : tasks.filter((task) => taskColumn(task) === activeTaskTab),
    [activeTaskTab, tasks],
  );

  const syncDetectedRuntimes = useCallback(
    async (probes: AiRuntimeProbe[], current: AiAgentRuntime[]) => {
      const configuredKinds = new Set(current.map((runtime) => runtime.kind));
      const detected = probes.filter(
        (probe) => probe.available && !configuredKinds.has(probe.kind),
      );
      if (!detected.length) return current;
      const stamp = timestamp();
      const created = await Promise.all(
        detected.map((probe) =>
          saveAiRuntime({
            id: crypto.randomUUID(),
            name: runtimeName(probe.kind),
            kind: probe.kind,
            command: probe.command,
            enabled: true,
            createdAt: stamp,
            updatedAt: stamp,
          }),
        ),
      );
      return [...current, ...created];
    },
    [],
  );

  const refresh = useCallback(
    async (nextProjectId = projectId, nextDeliveryId = deliveryId) => {
      const [
        nextProjects,
        nextSavedRuntimes,
        nextAgents,
        nextRoles,
        nextWorkflows,
        rawPresets,
        nextAllDeliveries,
      ] = await Promise.all([
        getAiProjects(),
        getAiRuntimes(),
        getAiAgents(),
        getAiRoles(),
        getAiWorkflows(),
        readClientData("extra_param_presets"),
        getAiDeliveries(),
      ]);
      const activeProjectId = nextProjectId
        || pickMostRecentDelivery(nextAllDeliveries)?.projectId
        || pickMostRecentProject(nextProjects)?.id
        || "";
      let nextPresets: ExtraParamPreset[] = [];
      try {
        nextPresets = rawPresets
          ? (JSON.parse(rawPresets) as ExtraParamPreset[])
          : [];
      } catch {
        nextPresets = [];
      }
      setProjects(nextProjects);
      setSavedRuntimes(nextSavedRuntimes);
      setConfigurationLoaded(true);
      setAgents(nextAgents);
      setRoles(nextRoles);
      setWorkflows(nextWorkflows);
      setPresets(Array.isArray(nextPresets) ? nextPresets : []);
      setProjectId(activeProjectId);
      const [nextDeliveries, nextContracts] = activeProjectId
        ? await Promise.all([
            getAiDeliveries(activeProjectId),
            getAiTaskContracts(activeProjectId),
          ])
        : [[], []];
      const activeDeliveryId = nextDeliveryId || pickMostRecentDelivery(nextDeliveries)?.id || "";
      setDeliveries(nextDeliveries);
      setTaskContracts(nextContracts);
      setDeliveryId(activeDeliveryId);
      const [nextTasks, nextReviewGates, nextDecisions, nextMergeRecords, nextAttempts, nextEvents] = activeDeliveryId
        ? await Promise.all([
            getAiTaskNodes(activeDeliveryId),
            getAiReviewGates(activeDeliveryId),
            getAiDecisionRequests(activeDeliveryId),
            getAiMergeRecords(activeDeliveryId),
            getAiAttempts(activeDeliveryId),
            getAiDeliveryEvents(activeDeliveryId),
          ])
        : [[], [], [], [], [], []];
      setTasks(nextTasks);
      setReviewGates(nextReviewGates);
      setDecisionRequests(nextDecisions);
      setMergeRecords(nextMergeRecords);
      setAttempts(nextAttempts);
      setDeliveryEvents(nextEvents);
    },
    [deliveryId, projectId, syncDetectedRuntimes],
  );

  useEffect(() => {
    if (!configurationLoaded || runtimeSyncInProgress.current) return;
    runtimeSyncInProgress.current = true;
    void syncDetectedRuntimes(runtimes, savedRuntimes)
      .then((syncedRuntimes) => {
        if (syncedRuntimes !== savedRuntimes) setSavedRuntimes(syncedRuntimes);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => {
        runtimeSyncInProgress.current = false;
      });
  }, [configurationLoaded, runtimes, savedRuntimes, syncDetectedRuntimes]);

  const refreshLiveDelivery = useCallback(async () => {
    if (!projectId || liveRefreshInProgress.current) return;
    liveRefreshInProgress.current = true;
    try {
      const [nextDeliveries, nextContracts] = await Promise.all([
        getAiDeliveries(projectId),
        getAiTaskContracts(projectId),
      ]);
      const activeDeliveryId = nextDeliveries.some(
        (item) => item.id === deliveryId,
      )
        ? deliveryId
        : pickMostRecentDelivery(nextDeliveries)?.id ?? "";
      const [nextTasks, nextReviewGates, nextDecisions, nextMergeRecords, nextAttempts, nextEvents] = activeDeliveryId
        ? await Promise.all([
            getAiTaskNodes(activeDeliveryId),
            getAiReviewGates(activeDeliveryId),
            getAiDecisionRequests(activeDeliveryId),
            getAiMergeRecords(activeDeliveryId),
            getAiAttempts(activeDeliveryId),
            getAiDeliveryEvents(activeDeliveryId),
          ])
        : [[], [], [], [], [], []];
      setDeliveries(nextDeliveries);
      setTaskContracts(nextContracts);
      setDeliveryId(activeDeliveryId);
      setTasks(nextTasks);
      setReviewGates(nextReviewGates);
      setDecisionRequests(nextDecisions);
      setMergeRecords(nextMergeRecords);
      setAttempts(nextAttempts);
      setDeliveryEvents(nextEvents);
    } finally {
      liveRefreshInProgress.current = false;
    }
  }, [deliveryId, projectId]);

  useEffect(() => {
    void refresh().catch((reason) => setError(String(reason)));
  // 初次加载才需要读取 Runtime 与完整团队配置。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!notificationTargetDeliveryId) return;
    void getAiDeliveries()
      .then((items) => {
        const target = items.find((item) => item.id === notificationTargetDeliveryId);
        if (target) return refresh(target.projectId, target.id);
        return undefined;
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(onNotificationTargetHandled);
  }, [notificationTargetDeliveryId, onNotificationTargetHandled, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshLiveDelivery().catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [refreshLiveDelivery]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onAiDeliveryEvent((event) => {
      if (event.deliveryId !== deliveryId) return;
      setDeliveryEvents((current) => [...current, event].slice(-500));
      if (event.eventType === "attemptAwaitingDecision") {
        void getAiDecisionRequests(deliveryId)
          .then(setDecisionRequests)
          .catch(() => undefined);
      }
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [deliveryId]);

  const execute = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const dispatchAndStartReadyTasks = async (targetDeliveryId: string) => {
    const attempts = await dispatchAiReadyTasks(targetDeliveryId);
    await Promise.all(attempts.map((item) => startAiAttempt(item.id)));
    return attempts.length;
  };

  const initializeTeam = () =>
    execute("team", async () => {
      const available = runtimes.filter((item) => item.available);
      if (!savedRuntimes.length && !available.length)
        throw new Error(
          "未检测到可用的本机 CLI。请先登录任一支持的 Runtime，例如 Codex、Claude Code、OpenCode 或 Pi。",
        );
      const stamp = timestamp();
      const runtimeEntries = savedRuntimes.length
        ? savedRuntimes
        : await Promise.all(
            available.map((item) =>
              saveAiRuntime({
                id: crypto.randomUUID(),
                name: runtimeName(item.kind),
                kind: item.kind,
                command: item.command,
                enabled: true,
                createdAt: stamp,
                updatedAt: stamp,
              }),
            ),
          );
      const primaryRuntime = runtimeEntries.find((runtime) => runtime.enabled);
      if (!primaryRuntime)
        throw new Error("没有启用的 Runtime。请在 Runtime 管理中启用一个本机 CLI。");

      const createdAgents: AiAgent[] = [];
      const createTemplateAgent = (name: string, runtimeId = primaryRuntime.id, maxConcurrency = 1) => {
        const agent: AiAgent = {
          id: crypto.randomUUID(),
          name,
          runtimeId,
          runtimeArgs: [],
          startupPresetName: null,
          maxConcurrency,
          enabled: true,
          createdAt: stamp,
          updatedAt: stamp,
        };
        createdAgents.push(agent);
        return agent;
      };
      const enabledAgents = agents.filter((agent) => agent.enabled);
      const manager = agents.find((agent) => agent.name === "交付管理者")
        ?? createTemplateAgent("交付管理者");
      const developer = agents.find((agent) => agent.name === "开发工程师")
        ?? enabledAgents.find((agent) => agent.id !== manager.id)
        ?? createTemplateAgent("开发工程师", primaryRuntime.id, 2);
      const reviewer = agents.find((agent) => agent.name === "质量审查员")
        ?? enabledAgents.find((agent) => agent.id !== manager.id && agent.id !== developer.id)
        ?? createTemplateAgent("质量审查员");
      if (createdAgents.length) await Promise.all(createdAgents.map(saveAiAgent));

      const developerRole = roles.find((role) => role.name === "开发") ?? {
        id: crypto.randomUUID(),
        name: "开发",
        description: "负责在隔离 worktree 中完成代码与配置改动。",
        candidateAgentIds: [developer.id],
        lockedAgentId: null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      const reviewerRole = roles.find((role) => role.name === "审查") ?? {
        id: crypto.randomUUID(),
        name: "审查",
        description: "独立检查改动范围、验收结果与剩余风险。",
        candidateAgentIds: [reviewer.id],
        lockedAgentId: reviewer.id,
        createdAt: stamp,
        updatedAt: stamp,
      };
      const rolesToCreate = [developerRole, reviewerRole].filter(
        (role) => !roles.some((item) => item.id === role.id),
      );
      if (rolesToCreate.length) await Promise.all(rolesToCreate.map(saveAiRole));

      if (!workflows.length) {
        await saveAiWorkflow({
          id: crypto.randomUUID(),
          name: "标准交付流程",
          description: "先由开发 Agent 实现，再由独立 Reviewer 只读审查。",
          steps: [
            {
              id: crypto.randomUUID(),
              name: "实现",
              roleId: developerRole.id,
              executionMode: "write",
              executionContext: "taskWorktree",
              prompt: "在允许写入范围内完成实现，执行验收命令并创建本地 Git 提交。",
            },
            {
              id: crypto.randomUUID(),
              name: "独立审查",
              roleId: reviewerRole.id,
              executionMode: "readonly",
              executionContext: "taskWorktree",
              prompt: "只读检查前序改动、需求覆盖和风险，不得修改文件或创建提交。",
            },
          ],
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
      await refresh();
    });

  const createProject = () =>
    execute("project", async () => {
      if (!projectName.trim() || !workspaceRoot.trim())
        throw new Error("请填写项目名称和本机工作区根目录。");
      const qualityGateCommands = parseTaskLines(qualityCommands);
      if (!qualityGateCommands.length)
        throw new Error("请至少配置一条质量门禁命令，确保任务能够审核和本地合并。");
      const nextProject = await createAiProject({
        name: projectName.trim(),
        workspaceRoot: workspaceRoot.trim(),
        qualityGate: { commands: qualityGateCommands },
        managerAgentId:
          agents.find(
            (agent) =>
              agent.name === "交付管理者" && agent.enabled,
          )?.id ?? null,
        maxConcurrency: 4,
      });
      setShowProjectForm(false);
      setProjectName("");
      setWorkspaceRoot("");
      setQualityCommands("");
      await refresh(nextProject.id, "");
    });

  const browseWorkspaceRoot = async () => {
    setError("");
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择工作区根目录",
      });
      if (typeof selected === "string") setWorkspaceRoot(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openProjectSettings = () => {
    if (!project) return;
    setEditProjectName(project.name);
    setEditProjectQualityCommands(project.qualityGate.commands.join("\n"));
    setEditProjectMaxConcurrency(String(project.maxConcurrency));
    setEditProjectRepositories(project.repositories);
    setShowProjectSettings(true);
  };

  const saveProjectSettings = () =>
    execute("update-project", async () => {
      if (!project || !editProjectName.trim()) throw new Error("请填写项目名称。");
      const maxConcurrency = Number(editProjectMaxConcurrency);
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32)
        throw new Error("项目并发必须是 1 到 32 的整数。");
      const qualityGateCommands = parseTaskLines(editProjectQualityCommands);
      if (!qualityGateCommands.length)
        throw new Error("请至少配置一条质量门禁命令，确保任务能够审核和本地合并。");
      await updateAiProject({
        ...project,
        name: editProjectName.trim(),
        qualityGate: { commands: qualityGateCommands },
        maxConcurrency,
        repositories: editProjectRepositories,
      });
      setShowProjectSettings(false);
      await refresh(project.id, deliveryId);
    });

  const generateCreateProjectQualityGate = () =>
    execute("generate-quality-gate-create", async () => {
      if (!workspaceRoot.trim())
        throw new Error("请先填写工作区根目录，再进行 AI 扫描生成。");
      const gate = await generateAiQualityGateCommands(workspaceRoot.trim());
      setQualityCommands(gate.commands.join("\n"));
    });

  const regenerateProjectQualityGate = () =>
    execute("generate-quality-gate-edit", async () => {
      if (!project) return;
      const gate = await generateAiQualityGateCommands(
        project.workspaceRoot,
        undefined,
        project.managerAgentId ?? undefined,
      );
      setEditProjectQualityCommands(gate.commands.join("\n"));
    });

  const refreshProjectRepositories = () =>
    execute("refresh-project-repositories", async () => {
      if (!project) return;
      const refreshedProject = await refreshAiProjectRepositories(project.id);
      setEditProjectRepositories(refreshedProject.repositories);
      await refresh(project.id, deliveryId);
    });

 const removeProject = () =>
   execute("delete-project", async () => {
     if (!project) return;
      if (!await showConfirm(`确定删除项目"${project.name}"吗？这会删除 AI 交付记录，不会删除本地源码、worktree 或 Git 分支。`, {
        title: "确认删除项目",
        confirmText: "删除",
        danger: true,
      })) return;
     await deleteAiProject(project.id);
     setShowProjectSettings(false);
     await refresh("", "");
   });

  const createDelivery = () =>
    execute("delivery", async () => {
      if (!project || !deliveryTitle.trim() || !requirement.trim() || !managerId || !workflowId)
        throw new Error("请填写交付标题、需求，并选择管理者 Agent 和任务编排。");
      const nextDelivery = await createAiDelivery({
        projectId: project.id,
        title: deliveryTitle.trim(),
        requirement: requirement.trim(),
        managerAgentId: managerId || null,
        workflowId,
      });
      setDeliveryTitle("");
      setRequirement("");
      setManagerId("");
      setWorkflowId("");
      setShowDeliveryDialog(false);
      await refresh(project.id, nextDelivery.id);
    });

  const openManualTaskDialog = () => {
    if (!project || !delivery) return;
    setManualTaskTitle("");
    setManualTaskDescription("");
    setManualTaskPrompt("");
    setManualTaskRepositoryId(
      project.repositories.find((repository) => repository.writeEnabled)?.id ?? "",
    );
    setManualTaskExecutionMode("write");
    setManualTaskAllowedPaths(".");
    setManualTaskInputArtifacts("");
    setManualTaskExpectedArtifacts("");
    setManualTaskAcceptanceCommands("");
    setManualTaskRoleId("");
    setManualTaskAgentId("");
    setManualTaskDependencyIds([]);
    setManualTaskRetryCount("0");
    setManualTaskExecutionContext("taskWorktree");
    setShowTaskDialog(true);
  };

  const createManualTask = () =>
    execute("create-task", async () => {
      if (!delivery || !manualTaskTitle.trim() || !manualTaskDescription.trim())
        throw new Error("请填写任务标题和说明。");
      if (!manualTaskRepositoryId) throw new Error("请选择允许写入的目标仓库。");
      if (!manualTaskAgentId && !manualTaskRoleId)
        throw new Error("请指定优先 Agent 或角色，确保任务可以被派发。");
      const retryCount = Number(manualTaskRetryCount);
      if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 10)
        throw new Error("重试次数必须是 0 到 10 的整数。");
      await createAiTaskNode({
        deliveryId: delivery.id,
        title: manualTaskTitle.trim(),
        description: manualTaskDescription.trim(),
        roleId: manualTaskRoleId || null,
        preferredAgentId: manualTaskRoleId ? null : manualTaskAgentId || null,
        taskPrompt: manualTaskPrompt.trim() || manualTaskDescription.trim(),
        executionMode: manualTaskExecutionMode,
        executionContext: manualTaskExecutionContext,
        targetRepositoryId: manualTaskRepositoryId,
        allowedWritePaths: parseTaskLines(manualTaskAllowedPaths),
        dependencyIds: manualTaskDependencyIds,
        inputArtifacts: parseTaskLines(manualTaskInputArtifacts),
        expectedArtifacts: parseTaskLines(manualTaskExpectedArtifacts),
        acceptanceCommands: parseTaskLines(manualTaskAcceptanceCommands),
        retryCount,
      });
      setShowTaskDialog(false);
      await refresh(projectId, delivery.id);
    });

  const selectProject = async (id: string) => {
    setActiveTaskTab("planned");
    await refresh(id, "");
  };
  const selectDelivery = async (id: string) => {
    setActiveTaskTab("planned");
    await refresh(projectId, id);
  };

  const openDeliveryEditor = () => {
    if (!delivery) return;
    setEditDeliveryTitle(delivery.title);
    setEditRequirement(delivery.requirement);
    setEditManagerId(delivery.managerAgentId ?? "");
    setEditWorkflowId(delivery.workflowId ?? "");
    setShowDeliveryEditDialog(true);
  };

  const updateDelivery = () =>
    execute("update-delivery", async () => {
      if (!delivery || !editDeliveryTitle.trim() || !editRequirement.trim() || !editManagerId || !editWorkflowId)
        throw new Error("请填写交付标题、需求，并选择管理者 Agent 和任务编排。");
      await updateAiDelivery({
        id: delivery.id,
        title: editDeliveryTitle.trim(),
        requirement: editRequirement.trim(),
        managerAgentId: editManagerId,
        workflowId: editWorkflowId,
      });
      setShowDeliveryEditDialog(false);
      await refresh(projectId, delivery.id);
    });

 const replanLegacyDelivery = () =>
   execute("replan", async () => {
     if (!delivery || !legacyTaskGraph) return;
      if (!await showConfirm("旧任务图的状态和运行记录会保留为历史，并重新生成一份可校验的任务图。是否继续？", {
        title: "确认重新规划",
        confirmText: "重新规划",
        danger: true,
      })) return;
     const replacement = await replanLegacyAiDelivery(delivery.id);
      setActiveTaskTab("planned");
      try {
        await planAiDeliveryWithManager(replacement.id);
      } finally {
        await refresh(projectId, replacement.id);
      }
    });

 const removeDelivery = () =>
   execute("delete-delivery", async () => {
     if (!delivery || delivery.state !== "drafting") return;
      if (!await showConfirm(`确定删除草稿"${delivery.title}"吗？`, {
        title: "确认删除草稿",
        confirmText: "删除",
        danger: true,
      })) return;
     const nextDeliveryId = deliveries.find((item) => item.id !== delivery.id)?.id ?? "";
      await deleteAiDelivery(delivery.id);
      await refresh(projectId, nextDeliveryId);
    });

  const runReview = (task: AiTaskNode) =>
    execute(`review-${task.id}`, async () => {
      await runAiQualityGate(task.id);
      await refresh(projectId, deliveryId);
    });

  const resolveReview = (gate: AiReviewGate, approved: boolean) =>
    execute(`resolve-review-${gate.id}`, async () => {
      await resolveAiReviewGate(gate.id, approved);
      if (approved && delivery) {
        await dispatchAndStartReadyTasks(delivery.id);
      }
      await refresh(projectId, deliveryId);
    });

  const answerDecision = (request: AiDecisionRequest) =>
    execute(`decision-${request.id}`, async () => {
      const answer = decisionAnswers[request.id]?.trim();
      if (!answer) throw new Error("请先选择或填写决策回答。");
      await answerAiDecisionRequest(request.id, answer);
      setDecisionAnswers((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      await refresh(projectId, deliveryId);
    });

  const retryTask = (task: AiTaskNode) =>
    execute(`retry-${task.id}`, async () => {
      await retryAiTaskNode(task.id);
      if (!await dispatchAndStartReadyTasks(task.deliveryId)) {
        throw new Error("任务仍在等待前置依赖完成，暂时不能派发。");
      }
      await refresh(projectId, deliveryId);
    });

 const mergeDelivery = () =>
   execute("merge", async () => {
     if (!delivery) return;
      if (!await showConfirm(`确定在本地合并"${delivery.title}"的交付成果吗？这会执行 Git 合并操作。`, {
        title: "确认合并交付",
        confirmText: "合并",
        danger: true,
      })) return;
     await mergeAiDeliveryLocally(delivery.id);
      await refresh(projectId, delivery.id);
    });

 const cleanupDeliveryIntegration = () =>
   execute("cleanup-integration", async () => {
     if (!delivery) return;
      if (!await showConfirm(`确定清理"${delivery.title}"的集成产物吗？这会删除 worktree 并尝试删除临时分支。`, {
        title: "确认清理集成",
        confirmText: "清理",
        danger: true,
      })) return;
     await cleanupAiDeliveryIntegration(delivery.id);
      await refresh(projectId, delivery.id);
    });

 const cancelDelivery = () =>
   execute("cancel-delivery", async () => {
     if (!delivery || !project) return;
      if (!await showConfirm(`确定终止交付"${delivery.title}"吗？运行中的 Agent 将被关闭，worktree 会保留供检查。`, {
        title: "确认终止交付",
        confirmText: "终止",
        danger: true,
      })) return;
     await cancelAiDelivery(delivery.id);
      await refresh(project.id, delivery.id);
    });

  const reviewGateByTask = useMemo(
    () => new Map(reviewGates.map((gate) => [gate.taskNodeId, gate])),
    [reviewGates],
  );
  const taskContractByTask = useMemo(
    () => new Map(taskContracts.map((contract) => [contract.taskId, contract])),
    [taskContracts],
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks],
  );
  const selectedTaskContract = selectedTask
    ? taskContractByTask.get(selectedTask.id)
    : null;
  const allTasksApproved =
    tasks.length > 0 && tasks.every((task) => task.state === "succeeded");
  const pendingDecisions = decisionRequests.filter(
    (request) => request.state === "pending",
  );
  const lastMergeRecord = mergeRecords[0];
  const allDeliveryStatesSelected = defaultDeliveryStateFilterIds.every((id) =>
    selectedDeliveryStateFilters.includes(id),
  );
  const toggleDeliveryStateFilter = (id: string) => {
    const next = selectedDeliveryStateFilters.includes(id)
      ? selectedDeliveryStateFilters.filter((filterId) => filterId !== id)
      : [...selectedDeliveryStateFilters, id];
    setSelectedDeliveryStateFilters(next);
    saveAppSettings({ ...getAppSettings(), aiDeliveryStateFilters: next });
  };
  const toggleAllDeliveryStateFilters = () => {
    const next = allDeliveryStatesSelected ? [] : defaultDeliveryStateFilterIds;
    setSelectedDeliveryStateFilters(next);
    saveAppSettings({ ...getAppSettings(), aiDeliveryStateFilters: next });
  };
  
  const toggleDeliveryStateFilterGroup = (group: typeof deliveryStateFilterGroups[number]) => {
    let childIds: string[];
    if ('children' in group) {
      childIds = group.children.map(child => child.id);
    } else {
      childIds = [group.id];
    }
    const allSelected = childIds.every(id => selectedDeliveryStateFilters.includes(id));
    let next: string[];
    if (allSelected) {
      next = selectedDeliveryStateFilters.filter(id => !childIds.includes(id));
    } else {
      next = [...selectedDeliveryStateFilters];
      for (const childId of childIds) {
        if (!next.includes(childId)) next.push(childId);
      }
    }
    setSelectedDeliveryStateFilters(next);
    saveAppSettings({ ...getAppSettings(), aiDeliveryStateFilters: next });
  };

  const filteredDeliveries = useMemo(
    () => {
      if (allDeliveryStatesSelected) return deliveries;
      return deliveries.filter((item) =>
        selectedDeliveryStateFilters.some((id) =>
          deliveryStateFilterById[id]?.matches(item.state),
        ),
      );
    },
    [allDeliveryStatesSelected, deliveries, selectedDeliveryStateFilters],
  );
  const recentDeliveryEvents = useMemo(
    () => [...deliveryEvents].slice(-20).reverse(),
    [deliveryEvents],
  );
  const filteredAttempts = useMemo(
    () => {
      if (showSuccessAttempts && showFailedAttempts) return attempts;
      return attempts.filter((attempt) => {
        const failed = isFailedAttemptState(attempt.state);
        return (failed && showFailedAttempts) || (!failed && showSuccessAttempts);
      });
    },
    [attempts, showSuccessAttempts, showFailedAttempts],
  );
  const filteredRecentDeliveryEvents = useMemo(
    () => {
      if (showSuccessEvents && showFailedEvents) return recentDeliveryEvents;
      return recentDeliveryEvents.filter((event) => {
        const failed = isFailedEventType(event.eventType);
        return (failed && showFailedEvents) || (!failed && showSuccessEvents);
      });
    },
    [recentDeliveryEvents, showSuccessEvents, showFailedEvents],
  );

 const openAttemptTerminal = (terminalId: string) => {
   window.dispatchEvent(
     new CustomEvent("open-ai-attempt-terminal", { detail: { terminalId } }),
   );
 };

 const toggleAttemptOutput = async (attemptId: string) => {
    setExpandedOutputId(attemptId);
   if (!attemptOutputMap[attemptId]) {
     setLoadingOutputId(attemptId);
     try {
       const output = await readAiAttemptOutput(attemptId);
       setAttemptOutputMap((prev) => ({ ...prev, [attemptId]: output }));
     } catch (err) {
       console.error("加载执行产出失败:", err);
     } finally {
       setLoadingOutputId(null);
     }
   }
 };
 const cancelAttempt = (attempt: AiAttempt) =>
   execute(`cancel-attempt-${attempt.id}`, async () => {
      if (!await showConfirm("确定取消该任务吗？运行中的 Agent 进程将被终止。", {
        title: "确认取消任务",
        confirmText: "取消任务",
        danger: true,
      })) return;
     await cancelAiAttempt(attempt.id);
     await refresh(projectId, deliveryId);
   });

 const completeAttempt = (attempt: AiAttempt) =>
   execute(`complete-attempt-${attempt.id}`, async () => {
      if (!await showConfirm("确定手动标记该任务为已完成吗？这会跳过自动审查流程。", {
        title: "确认完成任务",
        confirmText: "标记完成",
        danger: true,
      })) return;
     await completeAiAttempt(attempt.id);
      await refresh(projectId, deliveryId);
    });

  const saveRoleAgent = (role: AiRole, agentId: string) =>
    execute(`role-${role.id}`, async () => {
      const candidates = agentId
        ? [agentId]
        : agents.filter((agent) => agent.enabled).map((agent) => agent.id);
      await saveAiRole({
        ...role,
        candidateAgentIds: candidates,
        lockedAgentId: agentId || null,
      });
      await refresh();
    });

  const saveRoleDetails = (
    role: AiRole,
    patch: Pick<AiRole, "name" | "description">,
  ) =>
    execute(`role-${role.id}`, async () => {
      await saveAiRole({ ...role, ...patch });
      await refresh();
    });

  const createRole = () =>
    execute("create-role", async () => {
      const agent = agents.find((item) => item.enabled);
      if (!agent) throw new Error("请先创建并启用一个执行 Agent。");
      await saveAiRole({
        id: crypto.randomUUID(),
        name: "未命名角色",
        description: "",
        candidateAgentIds: [agent.id],
        lockedAgentId: agent.id,
        createdAt: timestamp(),
        updatedAt: timestamp(),
      });
      await refresh();
    });

 const removeRole = (role: AiRole) =>
   execute(`delete-role-${role.id}`, async () => {
      if (!await showConfirm(`确定删除角色"${role.name}"吗？`, {
        title: "确认删除角色",
        confirmText: "删除",
        danger: true,
      })) return;
     await deleteAiRole(role.id);
     await refresh();
   });

  const saveWorkflowConfig = (
    workflow: AiWorkflow,
    patch: Partial<Pick<AiWorkflow, "name" | "description" | "steps">>,
  ) =>
    execute(`workflow-${workflow.id}`, async () => {
      await saveAiWorkflow({ ...workflow, ...patch });
      await refresh();
    });

  const createWorkflow = () =>
    execute("create-workflow", async () => {
      const role = roles.find((item) => item.lockedAgentId || item.candidateAgentIds.length);
      if (!role) throw new Error("请先创建一个已绑定执行 Agent 的角色。");
      const stamp = timestamp();
      const created = await saveAiWorkflow({
        id: crypto.randomUUID(),
        name: "标准交付流程",
        description: "分析、需求评审、编码、功能测试与代码审核",
        steps: [
          {
            id: crypto.randomUUID(),
            name: "任务分析",
            roleId: role.id,
            executionMode: "readonly",
            executionContext: "workspaceRoot",
            prompt: "分析需求与现有实现，明确完成目标、影响范围和验收标准。",
          },
          {
            id: crypto.randomUUID(),
            name: "需求评审",
            roleId: role.id,
            executionMode: "readonly",
            executionContext: "workspaceRoot",
            prompt: "评审需求与任务分析结论，识别歧义、遗漏、风险和不可验证的验收条件。",
          },
          {
            id: crypto.randomUUID(),
            name: "编码实现",
            roleId: role.id,
            executionMode: "write",
            executionContext: "taskWorktree",
            prompt: "依据已评审的目标完成实现，保持改动范围最小，并提交本地 Git commit。",
          },
          {
            id: crypto.randomUUID(),
            name: "功能测试",
            roleId: role.id,
            executionMode: "readonly",
            executionContext: "taskWorktree",
            prompt: "根据验收标准执行功能测试和必要的回归检查，明确记录通过项、失败项和复现方式。",
          },
          {
            id: crypto.randomUUID(),
            name: "Code Review",
            roleId: role.id,
            executionMode: "readonly",
            executionContext: "taskWorktree",
            prompt: "审查实现提交与 diff，重点检查正确性、边界条件、安全性、可维护性和测试缺口。",
          },
        ],
        createdAt: stamp,
        updatedAt: stamp,
      });
      setWorkflowId(created.id);
      setEditWorkflowId(created.id);
      setExpandedWorkflowId(created.id);
      await refresh();
    });

  const addWorkflowStep = (workflow: AiWorkflow) => {
    const role = roles.find((item) => item.lockedAgentId || item.candidateAgentIds.length);
    if (!role) {
      setError("请先创建一个已绑定执行 Agent 的角色。");
      return;
    }
    const stepId = crypto.randomUUID();
    setExpandedWorkflowId(workflow.id);
    void saveWorkflowConfig(workflow, {
      steps: [
        ...workflow.steps,
        {
          id: stepId,
          name: `步骤 ${workflow.steps.length + 1}`,
          roleId: role.id,
          executionMode: "write",
          executionContext: "taskWorktree",
          prompt: "",
        },
      ],
    });
  };

  const updateWorkflowStep = (
    workflow: AiWorkflow,
    stepId: string,
    patch: Partial<AiWorkflow["steps"][number]>,
  ) =>
    saveWorkflowConfig(workflow, {
      steps: workflow.steps.map((step) =>
        step.id === stepId ? { ...step, ...patch } : step,
      ),
    });

  const moveWorkflowStep = (
    workflow: AiWorkflow,
    stepIndex: number,
    direction: -1 | 1,
  ) => {
    const targetIndex = stepIndex + direction;
    if (targetIndex < 0 || targetIndex >= workflow.steps.length) return;
    const steps = [...workflow.steps];
    [steps[stepIndex], steps[targetIndex]] = [steps[targetIndex], steps[stepIndex]];
    void saveWorkflowConfig(workflow, { steps });
  };

  const removeWorkflowStep = async (workflow: AiWorkflow, stepId: string) => {
   if (workflow.steps.length === 1) {
     setError("编排方案至少需要一个步骤。");
     return;
   }
    if (!await showConfirm("确定删除该编排步骤吗？", {
      title: "确认删除步骤",
      confirmText: "删除",
      danger: true,
    })) return;
   void saveWorkflowConfig(workflow, {
      steps: workflow.steps.filter((step) => step.id !== stepId),
    });
  };

  const removeWorkflow = (workflow: AiWorkflow) =>
    execute(`delete-workflow-${workflow.id}`, async () => {
      if (!await showConfirm(`确定删除编排方案“${workflow.name}”吗？`, {
        title: "确认删除编排方案",
        confirmText: "删除",
        danger: true,
      })) return;
      await deleteAiWorkflow(workflow.id);
      if (workflowId === workflow.id) setWorkflowId("");
      if (editWorkflowId === workflow.id) setEditWorkflowId("");
      await refresh();
    });

  const openConfiguration = (
    view: AiDeliveryConfigView,
    returnTarget: "create" | "edit" | null = null,
  ) => {
    setConfigDialogReturn(returnTarget);
    if (returnTarget === "create") setShowDeliveryDialog(false);
    if (returnTarget === "edit") setShowDeliveryEditDialog(false);
    onConfigDialogViewChange(view);
  };

  const closeConfiguration = () => {
    onConfigDialogViewChange(null);
    if (configDialogReturn === "create") setShowDeliveryDialog(true);
    if (configDialogReturn === "edit") setShowDeliveryEditDialog(true);
    setConfigDialogReturn(null);
  };

  const saveAgentConfig = (agent: AiAgent, patch: Partial<AiAgent>) =>
    execute(`agent-${agent.id}`, async () => {
      await saveAiAgent({ ...agent, ...patch });
      await refresh();
    });

  const saveRuntimeConfig = (
    runtime: AiAgentRuntime,
    patch: Partial<Pick<AiAgentRuntime, "name" | "command" | "enabled">>,
  ) =>
    execute(`runtime-${runtime.id}`, async () => {
      await saveAiRuntime({ ...runtime, ...patch });
      await refresh();
    });

  const openRuntimeCreate = () => {
    setNewRuntimeName("");
    setNewRuntimeKind("");
    setNewRuntimeCommand("");
    setShowRuntimeCreate(true);
  };

  const createRuntime = () =>
    execute("create-runtime", async () => {
      if (!newRuntimeName.trim() || !newRuntimeKind.trim() || !newRuntimeCommand.trim())
        throw new Error("请填写 Runtime 名称、类型和命令。");
      const stamp = timestamp();
      await saveAiRuntime({
        id: crypto.randomUUID(),
        name: newRuntimeName.trim(),
        kind: newRuntimeKind.trim().toLowerCase(),
        command: newRuntimeCommand.trim(),
        enabled: true,
        createdAt: stamp,
        updatedAt: stamp,
      });
      setShowRuntimeCreate(false);
      await refresh();
    });

 const removeRuntime = (runtime: AiAgentRuntime) =>
   execute(`delete-runtime-${runtime.id}`, async () => {
      if (!await showConfirm(`确定删除 Runtime"${runtime.name}"吗？`, {
        title: "确认删除 Runtime",
        confirmText: "删除",
        danger: true,
      })) return;
     await deleteAiRuntime(runtime.id);
      await refresh();
    });

  const createAgent = () =>
    execute("create-agent", async () => {
      const runtime = savedRuntimes.find((item) => item.enabled);
      if (!runtime) throw new Error("请先初始化或启用一个本机 CLI Runtime。");
      const stamp = timestamp();
      await saveAiAgent({
        id: crypto.randomUUID(),
        name: "未命名 Agent",
        runtimeId: runtime.id,
        runtimeArgs: [],
        startupPresetName: null,
        maxConcurrency: 2,
        enabled: true,
        createdAt: stamp,
        updatedAt: stamp,
      });
      await refresh();
    });

 const removeAgent = (agent: AiAgent) =>
   execute(`delete-agent-${agent.id}`, async () => {
      if (!await showConfirm(`确定删除执行 Agent"${agent.name}"吗？`, {
        title: "确认删除 Agent",
        confirmText: "删除",
        danger: true,
      })) return;
     await deleteAiAgent(agent.id);
     await refresh();
   });

  return (
    <main className="ai-workspace" aria-label="AI 交付工作区">
      <header className="ai-workspace-header">
        <div>
          <div className="ai-workspace-eyebrow">
            <Bot size={15} />
            本机交付团队
          </div>
          <h1>AI 交付</h1>
          <p>从需求到本地合并，由可审计的任务图驱动。</p>
        </div>
      </header>
      {error && (
        <div className="ai-workspace-error">
          <CircleAlert size={16} />
          {error}
        </div>
      )}
      <section className="ai-projects-panel ai-projects-panel-compact" aria-label="交付项目">
        {projects.length === 0 ? (
          <div className="ai-projects-compact-empty">
            <span>尚未登记项目</span>
            <div className="ai-projects-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() => setShowProjectForm(true)}
              >
                <Plus size={15} />
                新建项目
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="ai-projects-compact-toolbar">
              <label className="ai-project-selector">
                <span>当前项目</span>
                <select value={projectId} onChange={(event) => void selectProject(event.target.value)}>
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              {project && (
                <span className="ai-project-quick-meta">
                  {project.repositories.length} 仓库 · 并发 {project.maxConcurrency}
                </span>
              )}
              {deliveries.length > 1 && (
                <div className="ai-delivery-filter-bar" role="group" aria-label="状态筛选">
                  <span className="ai-delivery-filter-label">状态</span>
                  <button
                    type="button"
                    className={`ai-delivery-filter-chip${allDeliveryStatesSelected ? " active" : ""}`}
                    aria-pressed={allDeliveryStatesSelected}
                    onClick={toggleAllDeliveryStateFilters}
                  >
                    全部
                  </button>
                  {deliveryStateFilterGroups.map((group) => {
                    if ('children' in group) {
                      const childIds = group.children.map(child => child.id);
                      const allChildSelected = childIds.every(id => selectedDeliveryStateFilters.includes(id));
                      const tooltip = group.title + '：' + group.children.map(c => c.title).join('、');
                      return (
                        <button
                          type="button"
                          key={group.id}
                          className={`ai-delivery-filter-chip${allChildSelected ? " active" : ""}`}
                          aria-pressed={allChildSelected}
                          title={tooltip}
                          onClick={() => toggleDeliveryStateFilterGroup(group)}
                        >
                          {group.title}
                        </button>
                      );
                    }
                    return (
                      <button
                        type="button"
                        key={group.id}
                        className={`ai-delivery-filter-chip${selectedDeliveryStateFilters.includes(group.id) ? " active" : ""}`}
                        aria-pressed={selectedDeliveryStateFilters.includes(group.id)}
                        onClick={() => toggleDeliveryStateFilter(group.id)}
                      >
                        {group.title}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="ai-projects-actions">
                {(savedRuntimes.length === 0 || agents.length === 0 || workflows.length === 0) && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy === "team"}
                    onClick={() => void initializeTeam()}
                  >
                    <WandSparkles size={15} />
                    {savedRuntimes.length === 0 ? "初始化本地团队" : "补齐团队模板"}
                  </button>
                )}
               {project && (
                 <>
                   <button
                     type="button"
                     className="ai-icon-button"
                      title="项目概览"
                      aria-label="项目概览"
                      onClick={() => setShowProjectOverview(true)}
                    >
                      <CircleHelp size={15} />
                    </button>
                    <button
                      type="button"
                      className="ai-icon-button"
                     title="重新发现仓库"
                     aria-label="重新发现仓库"
                     disabled={busy === "refresh-project-repositories"}
                      onClick={() => void refreshProjectRepositories()}
                    >
                      <RefreshCw size={15} />
                    </button>
                    <button
                      type="button"
                      className="ai-icon-button"
                      title="编辑项目"
                      aria-label="编辑项目"
                      onClick={openProjectSettings}
                    >
                      <Pencil size={15} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setShowProjectForm(true)}
                >
                  <Plus size={15} />
                  新建项目
                </button>
              </div>
            </div>
          </>
        )}
        <div className="ai-projects-heading">
          <div>
            <h2>交付项目</h2>
            <p>选择项目后，在下方查看并管理该项目的交付任务。</p>
          </div>
          <div className="ai-projects-actions">
            {(savedRuntimes.length === 0 || agents.length === 0 || workflows.length === 0) && (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy === "team"}
                onClick={() => void initializeTeam()}
              >
                <WandSparkles size={15} />
                {savedRuntimes.length === 0 ? "初始化本机团队" : "补齐团队模板"}
              </button>
            )}
            <button
              type="button"
              className="btn-primary"
              onClick={() => setShowProjectForm(true)}
            >
              <Plus size={15} />
              新建项目
            </button>
          </div>
        </div>
        {projects.length === 0 ? (
          <p className="ai-projects-empty">尚未登记项目。创建项目后会自动发现工作区中的 Git 仓库。</p>
        ) : (
          <div className="ai-project-list">
            {projects.map((item) => {
              const selected = item.id === projectId;
              return (
                <article className={selected ? "active" : ""} key={item.id}>
                  <button
                    type="button"
                    className="ai-project-select-button"
                    aria-pressed={selected}
                    onClick={() => void selectProject(item.id)}
                  >
                    <FolderGit2 size={16} />
                    <span>
                      <strong>{item.name}</strong>
                      <small title={displayLocalPath(item.workspaceRoot)}>{displayLocalPath(item.workspaceRoot)}</small>
                    </span>
                    <em>{item.repositories.length} 个仓库</em>
                  </button>
                  {selected && (
                    <div className="ai-project-card-actions" aria-label={`${item.name} 项目操作`}>
                      <button
                        type="button"
                        className="ai-icon-button"
                        title="重新发现仓库"
                        aria-label="重新发现仓库"
                        disabled={busy === "refresh-project-repositories"}
                        onClick={() => void refreshProjectRepositories()}
                      >
                        <RefreshCw size={15} />
                      </button>
                      <button
                        type="button"
                        className="ai-icon-button"
                        title="编辑项目"
                        aria-label="编辑项目"
                        onClick={openProjectSettings}
                      >
                        <Pencil size={15} />
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
      {configDialogView && (
        <Dialog
          title="AI 交付配置"
          ariaLabel="AI 交付配置"
          className="ai-config-dialog"
          bodyClassName="ai-config-dialog-body"
          onClose={closeConfiguration}
          footer={
            <button type="button" className="btn-primary" onClick={closeConfiguration}>
              <Check size={15} />
              完成
            </button>
          }
        >
          <nav className="ai-config-tabs" aria-label="AI 交付配置分类">
            <button
              type="button"
              className={configDialogView === "workflow" ? "active" : ""}
              onClick={() => onConfigDialogViewChange("workflow")}
            >
              <Workflow size={15} />
              任务编排
            </button>
            <button
              type="button"
              className={configDialogView === "roles" ? "active" : ""}
              onClick={() => onConfigDialogViewChange("roles")}
            >
              <Users size={15} />
              角色
            </button>
            <button
              type="button"
              className={configDialogView === "runtimes" ? "active" : ""}
              onClick={() => onConfigDialogViewChange("runtimes")}
            >
              <SquareTerminal size={15} />
              Runtime
            </button>
            <button
              type="button"
              className={configDialogView === "agents" ? "active" : ""}
              onClick={() => onConfigDialogViewChange("agents")}
            >
              <Bot size={15} />
              Agent
            </button>
          </nav>
          {configDialogView === "workflow" && (
            <div className="ai-workflow-config ai-config-pane">
              <div className="ai-agent-config-heading">
                <div>
                  <h3>任务编排</h3>
                  <p>步骤按顺序执行；同一步骤可由管理者按微服务拆成多个并行任务。</p>
                </div>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy === "create-workflow"}
                  onClick={() => void createWorkflow()}
                >
                  <Plus size={14} />
                  新建编排
                </button>
              </div>
              {workflows.length === 0 ? (
                <div className="ai-team-empty">
                  尚未配置任务编排。新建后可自由添加分析、评审、编码、测试等步骤。
                </div>
              ) : (
                <div className="ai-workflow-list">
                  {workflows.map((workflow) => {
                    const expandedWorkflow = expandedWorkflowId === workflow.id;
                    return (
                    <article className={`ai-workflow-item${expandedWorkflow ? " expanded" : ""}`} key={workflow.id}>
                      <div className="ai-workflow-summary-row">
                        <button
                          type="button"
                          className="ai-workflow-summary"
                          aria-expanded={expandedWorkflow}
                          onClick={() => setExpandedWorkflowId(expandedWorkflow ? null : workflow.id)}
                        >
                          <span className="ai-workflow-summary-title">
                            <strong>{workflow.name}</strong>
                            <small>{workflow.description || "未填写流程说明"}</small>
                          </span>
                          <span className="ai-workflow-summary-count">{workflow.steps.length} 个步骤</span>
                          {expandedWorkflow ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </button>
                        <button
                          type="button"
                          className="ai-icon-button danger"
                          title="删除编排方案"
                          aria-label={`删除编排方案 ${workflow.name}`}
                          disabled={busy === `delete-workflow-${workflow.id}`}
                          onClick={() => void removeWorkflow(workflow)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                      {expandedWorkflow && <>
                      <div className="ai-workflow-heading">
                        <div className="ai-workflow-title-fields">
                          <input
                            aria-label="编排方案名称"
                            defaultValue={workflow.name}
                            onBlur={(event) => {
                              const name = event.currentTarget.value.trim();
                              if (name && name !== workflow.name)
                                void saveWorkflowConfig(workflow, { name });
                            }}
                          />
                          <input
                            aria-label={`${workflow.name}说明`}
                            defaultValue={workflow.description}
                            placeholder="适用范围或流程说明（可选）"
                            onBlur={(event) => {
                              const description = event.currentTarget.value.trim();
                              if (description !== workflow.description)
                                void saveWorkflowConfig(workflow, { description });
                            }}
                          />
                        </div>
                        <div className="ai-workflow-actions">
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={busy === `workflow-${workflow.id}`}
                            onClick={() => addWorkflowStep(workflow)}
                          >
                            <Plus size={14} />
                            添加步骤
                          </button>
                        </div>
                      </div>
                      <div className="ai-workflow-steps">
                        {workflow.steps.map((step, stepIndex) => {
                          return (
                          <div className="ai-workflow-step" key={step.id}>
                            <div className="ai-workflow-step-editor">
                            <span className="ai-workflow-step-index">{stepIndex + 1}</span>
                            <label className="ai-workflow-step-name">
                              步骤名
                              <input
                                aria-label={`步骤 ${stepIndex + 1} 名称`}
                                defaultValue={step.name}
                                onBlur={(event) => {
                                  const name = event.currentTarget.value.trim();
                                  if (name && name !== step.name)
                                    void updateWorkflowStep(workflow, step.id, { name });
                                }}
                              />
                            </label>
                            <label className="ai-workflow-step-mode">
                              执行模式
                              <select
                                value={step.executionMode}
                                onChange={(event) =>
                                  void updateWorkflowStep(workflow, step.id, {
                                    executionMode: event.target.value as "write" | "readonly",
                                    executionContext: event.target.value === "write" ? "taskWorktree" : "workspaceRoot",
                                  })
                                }
                              >
                                <option value="readonly">只读分析 / 评审</option>
                                <option value="write">修改代码</option>
                              </select>
                            </label>
                            <label className="ai-workflow-step-mode">
                              执行目录
                              <select
                                value={step.executionContext ?? (step.executionMode === "readonly" ? "workspaceRoot" : "taskWorktree")}
                                disabled={step.executionMode === "write"}
                                onChange={(event) =>
                                  void updateWorkflowStep(workflow, step.id, {
                                    executionContext: event.target.value as "workspaceRoot" | "taskWorktree",
                                  })
                                }
                              >
                                <option value="workspaceRoot">项目工作区根目录</option>
                                <option value="taskWorktree">任务 worktree</option>
                              </select>
                            </label>
                            <label className="ai-workflow-step-role">
                              执行角色
                              <select
                                value={step.roleId ?? ""}
                                onChange={(event) => {
                                  const roleId = event.target.value || null;
                                  const nextRole = roles.find((item) => item.id === roleId);
                                  if (roleId && !nextRole?.lockedAgentId && !nextRole?.candidateAgentIds.length) {
                                    setError("所选角色尚未配置 Agent，请先在角色管理中完成绑定。");
                                    return;
                                  }
                                  void updateWorkflowStep(workflow, step.id, {
                                    roleId,
                                  });
                                }}
                              >
                                <option value="">请选择角色</option>
                                {roles.map((role) => (
                                  <option key={role.id} value={role.id}>{role.name}</option>
                                ))}
                              </select>
                            </label>
                            <label className="ai-workflow-step-prompt">
                              步骤提示词
                              <textarea
                                aria-label={`${step.name}通用任务提示词`}
                                defaultValue={step.prompt}
                                placeholder="此步骤每个任务都会附带的通用提示词"
                                onBlur={(event) => {
                                  const prompt = event.currentTarget.value.trim();
                                  if (prompt !== step.prompt)
                                    void updateWorkflowStep(workflow, step.id, { prompt });
                                }}
                              />
                            </label>
                            <div className="ai-workflow-step-actions">
                              <button
                                type="button"
                                className="ai-icon-button"
                                title="上移步骤"
                                aria-label={`上移步骤 ${step.name}`}
                                disabled={stepIndex === 0 || busy === `workflow-${workflow.id}`}
                                onClick={() => moveWorkflowStep(workflow, stepIndex, -1)}
                              >
                                <ArrowUp size={14} />
                              </button>
                              <button
                                type="button"
                                className="ai-icon-button"
                                title="下移步骤"
                                aria-label={`下移步骤 ${step.name}`}
                                disabled={stepIndex === workflow.steps.length - 1 || busy === `workflow-${workflow.id}`}
                                onClick={() => moveWorkflowStep(workflow, stepIndex, 1)}
                              >
                                <ArrowDown size={14} />
                              </button>
                              <button
                                type="button"
                                className="ai-icon-button danger"
                                title="删除步骤"
                                aria-label={`删除步骤 ${step.name}`}
                                disabled={workflow.steps.length === 1 || busy === `workflow-${workflow.id}`}
                                onClick={() => removeWorkflowStep(workflow, step.id)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                            </div>
                          </div>
                          );
                        })}
                      </div>
                      </>}
                    </article>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {configDialogView === "roles" && (
            <div className="ai-config-pane">
          <div className="ai-team-config-heading">
            <div>
              <h2>角色管理</h2>
              <p>
                角色由你自由定义。每个角色指定一个执行 Agent；Agent 决定本机
                CLI、环境与可为空的启动参数。
              </p>
            </div>
            <span>所有配置只在本机生效</span>
          </div>
          <div className="ai-team-section-actions">
            <h3>角色</h3>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy === "create-role"}
              onClick={() => void createRole()}
            >
              <Plus size={14} />
              新建角色
            </button>
          </div>
          <div className="ai-role-map">
            <div className="ai-team-table-head">
              <span>角色与职责</span>
              <span>执行 Agent</span>
              <span>实际运行配置</span>
              <span>操作</span>
            </div>
            {roles.length === 0 ? (
              <div className="ai-team-empty">
                尚未配置角色。创建后可由管理者在任务图中分配该角色。
              </div>
            ) : (
              roles.map((role) => {
                const selectedAgent = agents.find(
                  (agent) => agent.id === role.lockedAgentId,
                );
                const runtime = selectedAgent
                  ? savedRuntimes.find(
                      (item) => item.id === selectedAgent.runtimeId,
                    )
                  : null;
                return (
                  <div className="ai-role-map-row" key={role.id}>
                    <div className="ai-role-details">
                      <input
                        aria-label={`${role.name}名称`}
                        defaultValue={role.name}
                        onBlur={(event) => {
                          const name = event.currentTarget.value.trim();
                          if (name && name !== role.name)
                            void saveRoleDetails(role, {
                              name,
                              description: role.description,
                            });
                        }}
                      />
                      <input
                        aria-label={`${role.name}职责`}
                        defaultValue={role.description}
                        placeholder="职责说明（可选）"
                        onBlur={(event) => {
                          const description = event.currentTarget.value.trim();
                          if (description !== role.description)
                            void saveRoleDetails(role, {
                              name: role.name,
                              description,
                            });
                        }}
                      />
                    </div>
                    <select
                      value={role.lockedAgentId ?? ""}
                      onChange={(event) =>
                        void saveRoleAgent(role, event.target.value)
                      }
                    >
                      <option value="">自动从候选池选择</option>
                      {agents
                        .filter((agent) => agent.enabled)
                        .map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                          </option>
                        ))}
                    </select>
                    <div className="ai-role-runtime-summary">
                      {selectedAgent ? (
                        <>
                          <span>{runtime?.name ?? "未配置 Runtime"}</span>
                          <small>
                            {selectedAgent.runtimeArgs.length
                              ? "启动参数："
                              : "无启动参数"}
                            {selectedAgent.runtimeArgs.length
                              ? ` · ${selectedAgent.runtimeArgs.join(" ")}`
                              : ""}
                          </small>
                        </>
                      ) : (
                        <small>尚未指定，调度时按候选池和容量选择</small>
                      )}
                    </div>
                    <button
                      type="button"
                      className="ai-icon-button danger"
                      title="删除角色"
                      aria-label={`删除角色 ${role.name}`}
                      disabled={busy === `delete-role-${role.id}`}
                      onClick={() => void removeRole(role)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
            </div>
          )}
          {configDialogView === "runtimes" && (
            <div className="ai-runtime-config ai-config-pane">
              <div className="ai-agent-config-heading">
                <div>
                  <h3>本机 CLI Runtime</h3>
                  <p>Runtime 决定 Agent 启动的本地命令。检测状态只在应用启动或手动重新检测时更新；自定义命令可填写绝对路径。</p>
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy === "create-runtime"}
                  onClick={openRuntimeCreate}
                >
                  <Plus size={14} />
                  新建 Runtime
                </button>
              </div>
              {showRuntimeCreate && (
                <form
                  className="ai-runtime-create"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createRuntime();
                  }}
                >
                  <label>
                    名称
                    <input autoFocus value={newRuntimeName} onChange={(event) => setNewRuntimeName(event.target.value)} placeholder="例如：本机 Pi" />
                  </label>
                  <label>
                    类型
                    <input value={newRuntimeKind} onChange={(event) => setNewRuntimeKind(event.target.value)} placeholder="例如：pi" />
                  </label>
                  <label>
                    命令或绝对路径
                    <input value={newRuntimeCommand} onChange={(event) => setNewRuntimeCommand(event.target.value)} placeholder="例如：C:\\Tools\\pi.cmd" />
                  </label>
                  <div className="ai-runtime-create-actions">
                    <button type="button" className="btn-secondary" onClick={() => setShowRuntimeCreate(false)}>取消</button>
                    <button type="submit" className="btn-primary" disabled={busy === "create-runtime"}>保存</button>
                  </div>
                </form>
              )}
              {savedRuntimes.length === 0 ? (
                <div className="ai-team-empty">尚未配置 Runtime。可新建一个 Runtime，或在侧栏执行重新检测后自动添加。</div>
              ) : (
                <div className="ai-runtime-config-list">
                  {savedRuntimes.map((runtime) => {
                    const probe = runtimes.find((item) => item.command === runtime.command)
                      ?? runtimes.find((item) => item.kind === runtime.kind);
                    return (
                      <div className="ai-runtime-config-row" key={runtime.id}>
                        <label>
                          名称
                          <input
                            aria-label={`${runtime.name} 名称`}
                            defaultValue={runtime.name}
                            onBlur={(event) => {
                              const name = event.currentTarget.value.trim();
                              if (name && name !== runtime.name)
                                void saveRuntimeConfig(runtime, { name });
                            }}
                          />
                        </label>
                        <label>
                          命令
                          <input
                            aria-label={`${runtime.name} 命令`}
                            defaultValue={runtime.command}
                            onBlur={(event) => {
                              const command = event.currentTarget.value.trim();
                              if (command && command !== runtime.command)
                                void saveRuntimeConfig(runtime, { command });
                            }}
                          />
                        </label>
                        <div className="ai-runtime-config-status">
                          <small className={!isRuntimeDetecting && probe?.available ? "online" : ""}>
                            {isRuntimeDetecting ? "检测中" : probe?.available ? "已就绪" : "不可用"}
                          </small>
                          <label>
                            <input
                              type="checkbox"
                              checked={runtime.enabled}
                              onChange={(event) =>
                                void saveRuntimeConfig(runtime, {
                                  enabled: event.target.checked,
                                })
                              }
                            />
                            启用
                          </label>
                        </div>
                        <button
                          type="button"
                          className="ai-icon-button danger"
                          title="删除 Runtime"
                          aria-label={`删除 Runtime ${runtime.name}`}
                          disabled={busy === `delete-runtime-${runtime.id}`}
                          onClick={() => void removeRuntime(runtime)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {configDialogView === "agents" && (
          <div className="ai-agent-config ai-config-pane">
            <div className="ai-agent-config-heading">
              <div>
                <h3>执行 Agent 配置</h3>
                <p>
                  可创建多个 Agent 供不同角色选择。任务目录始终固定为 worktree。
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy === "create-agent"}
                onClick={() => void createAgent()}
              >
                <Plus size={14} />
                新建执行 Agent
              </button>
            </div>
            {agents.map((agent) => {
              const runtime = savedRuntimes.find((item) => item.id === agent.runtimeId);
              const matchingPresets = presets.filter((preset) => presetMatchesRuntime(preset, runtime));
              const selectedPreset = matchingPresets.find((preset) => preset.name === agent.startupPresetName);
              return (
                <div className="ai-agent-config-row" key={agent.id}>
                <label className="ai-agent-name">
                  执行 Agent
                  <input
                    aria-label="执行 Agent 名称"
                    defaultValue={agent.name}
                    onBlur={(event) => {
                      const name = event.currentTarget.value.trim();
                      if (name && name !== agent.name)
                        void saveAgentConfig(agent, { name });
                    }}
                  />
                </label>
                <label>
                  最大并发（1-16）
                  <input
                    aria-label={`${agent.name}最大并发`}
                    type="number"
                    min="1"
                    max="16"
                    defaultValue={agent.maxConcurrency}
                    onBlur={(event) => {
                      const maxConcurrency = Number(event.currentTarget.value);
                      if (
                        Number.isInteger(maxConcurrency) &&
                        maxConcurrency >= 1 &&
                        maxConcurrency <= 16 &&
                        maxConcurrency !== agent.maxConcurrency
                      )
                        void saveAgentConfig(agent, { maxConcurrency });
                    }}
                  />
                </label>
                <label>
                  CLI
                  <select
                    value={agent.runtimeId}
                    onChange={(event) => {
                      const runtimeId = event.target.value;
                      const nextRuntime = savedRuntimes.find((item) => item.id === runtimeId);
                      const currentPreset = presets.find(
                        (preset) => preset.name === agent.startupPresetName,
                      );
                      void saveAgentConfig(agent, {
                        runtimeId,
                        ...(currentPreset && !presetMatchesRuntime(currentPreset, nextRuntime)
                          ? { startupPresetName: null, runtimeArgs: [] }
                          : {}),
                      });
                    }}
                  >
                    {savedRuntimes
                      .filter((item) => item.enabled)
                      .map((runtime) => (
                        <option key={runtime.id} value={runtime.id}>
                          {runtime.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  启动参数（可空）
                  <input
                    defaultValue={agent.runtimeArgs.join(" ")}
                    placeholder="例如 --model sonnet"
                    onBlur={(event) => {
                      const value = event.currentTarget.value.trim();
                      const runtimeArgs = parseRuntimeArgs(value);
                      if (
                        runtimeArgs.join("\u0000") !==
                        agent.runtimeArgs.join("\u0000")
                      )
                        void saveAgentConfig(agent, {
                          runtimeArgs,
                          startupPresetName: null,
                        });
                    }}
                  />
                </label>
                <label>
                  套用参数预设
                  <select
                    value={selectedPreset?.name ?? ""}
                    onChange={(event) => {
                      const preset = matchingPresets.find(
                        (item) => item.name === event.target.value,
                      );
                      void saveAgentConfig(agent, {
                        startupPresetName: preset?.name ?? null,
                        runtimeArgs: preset
                          ? parseRuntimeArgs(preset.params)
                          : [],
                      });
                    }}
                  >
                    <option value="">不附加参数</option>
                    {matchingPresets.map((preset) => (
                      <option key={preset.id} value={preset.name}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="ai-icon-button danger"
                  title="删除执行 Agent"
                  aria-label={`删除执行 Agent ${agent.name}`}
                  disabled={busy === `delete-agent-${agent.id}`}
                  onClick={() => void removeAgent(agent)}
                >
                  <Trash2 size={15} />
                </button>
                </div>
              );
            })}
          </div>
          )}
        </Dialog>
     )}
      {showProjectOverview && project && (
        <Dialog
          title={"项目概览 · " + project.name}
          ariaLabel="项目概览"
          className="ai-project-overview-dialog"
          bodyClassName="ai-project-overview-body"
          onClose={() => setShowProjectOverview(false)}
          footer={
            <button type="button" className="btn-primary" onClick={() => setShowProjectOverview(false)}>
              关闭
            </button>
          }
        >
          <div className="ai-project-context">
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
              <small>{project.qualityGate.commands.length ? "命令已配置" : "禁止自动合并"}</small>
            </div>
          </div>
          {project.repositories.length > 0 && (
            <section className="ai-project-overview-section">
              <h4>仓库列表</h4>
              <ul className="ai-project-overview-repos">
                {project.repositories.map((repo) => (
                  <li key={repo.id}>
                    <FolderGit2 size={13} />
                    <span>{repo.name}</span>
                    <small>{repo.writeEnabled ? "可写入" : "只读"}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {project.qualityGate.commands.length > 0 && (
            <section className="ai-project-overview-section">
              <h4>质量门禁命令</h4>
              <ul className="ai-project-overview-commands">
                {project.qualityGate.commands.map((cmd, idx) => (
                  <li key={idx}><code>{cmd}</code></li>
                ))}
              </ul>
            </section>
          )}
        </Dialog>
      )}
      {showProjectSettings && project && (
        <Dialog
          title="项目设置"
          ariaLabel="AI 交付项目设置"
          className="ai-project-settings-dialog"
          bodyClassName="ai-project-settings-body"
          onClose={() => setShowProjectSettings(false)}
          onSubmit={(event) => {
            event.preventDefault();
            void saveProjectSettings();
          }}
          footer={
            <>
              <button type="button" className="btn-danger" disabled={busy === "delete-project"} onClick={() => void removeProject()}>
                <Trash2 size={15} />
                删除项目
              </button>
              <button type="button" className="btn-secondary" onClick={() => setShowProjectSettings(false)}>
                取消
              </button>
              <button type="submit" className="btn-primary" disabled={busy === "update-project"}>
                <Check size={15} />
                保存设置
              </button>
            </>
          }
        >
          <label>
            项目名称
            <input autoFocus value={editProjectName} onChange={(event) => setEditProjectName(event.target.value)} />
          </label>
          <label>
            工作区根目录
            <input readOnly value={displayLocalPath(project.workspaceRoot)} />
          </label>
          <label>
            项目最大并发（1-32）
            <input type="number" min="1" max="32" value={editProjectMaxConcurrency} onChange={(event) => setEditProjectMaxConcurrency(event.target.value)} />
          </label>
          <label>
            <div className="ai-quality-gate-heading">
              <span>质量门禁（每行一条命令）</span>
              <button
                type="button"
                className="btn-secondary"
                disabled={
                  busy === "update-project" ||
                  busy === "generate-quality-gate-edit" ||
                  busy === "refresh-project-repositories"
                }
                onClick={() => void regenerateProjectQualityGate()}
              >
                <Sparkles size={13} />
                {busy === "generate-quality-gate-edit"
                  ? "AI 扫描生成中"
                  : "AI 重新生成"}
              </button>
            </div>
            <textarea value={editProjectQualityCommands} onChange={(event) => setEditProjectQualityCommands(event.target.value)} placeholder={"npm run build\nnpm test"} />
            <small>至少保留一条命令；清空后将无法保存，避免交付无法完成本地合并。</small>
          </label>
          <section className="ai-project-repository-settings">
            <div>
              <h3>服务仓库</h3>
              <button type="button" className="btn-secondary" disabled={busy === "refresh-project-repositories"} onClick={() => void refreshProjectRepositories()}>
                <RefreshCw size={14} />
                重新发现
              </button>
            </div>
            {editProjectRepositories.map((repository) => (
              <div className="ai-project-repository-row" key={repository.id}>
                <span>
                  <strong>{repository.name}</strong>
                  <small>{repository.relativePath} · {repository.defaultBranch}</small>
                </span>
                <label>
                  写入并发
                  <input
                    type="number"
                    min="1"
                    max="16"
                    value={repository.writeConcurrency}
                    onChange={(event) => {
                      const writeConcurrency = Number(event.target.value);
                      setEditProjectRepositories((current) => current.map((item) => item.id === repository.id ? { ...item, writeConcurrency: Number.isInteger(writeConcurrency) && writeConcurrency >= 1 && writeConcurrency <= 16 ? writeConcurrency : item.writeConcurrency } : item));
                    }}
                  />
                </label>
                <label className="ai-project-repository-toggle">
                  <input
                    type="checkbox"
                    checked={repository.writeEnabled}
                    onChange={(event) => setEditProjectRepositories((current) => current.map((item) => item.id === repository.id ? { ...item, writeEnabled: event.target.checked } : item))}
                  />
                  允许写入
                </label>
              </div>
            ))}
          </section>
        </Dialog>
      )}
      {showProjectForm && (
        <Dialog
          title="新建交付项目"
          ariaLabel="新建交付项目"
          className="ai-project-create-dialog"
          bodyClassName="ai-project-create-body"
          onClose={() => setShowProjectForm(false)}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setShowProjectForm(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy === "project"}
                onClick={() => void createProject()}
              >
                <FolderGit2 size={15} />
                登记并发现仓库
              </button>
            </>
          }
        >
          <p>填写工作区根目录后，系统会登记其中的 Git 服务仓库。</p>
          <label>
            项目名称
            <input
              autoFocus
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="平台微服务"
            />
          </label>
          <label>
            工作区根目录
            <div className="ai-project-root-input">
              <input
                value={workspaceRoot}
                onChange={(event) => setWorkspaceRoot(event.target.value)}
                placeholder="D:\kyber\platform_src"
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={busy === "project"}
                onClick={() => void browseWorkspaceRoot()}
              >
                <FolderOpen size={15} aria-hidden="true" />
                浏览
              </button>
            </div>
          </label>
          <label>
            <div className="ai-quality-gate-heading">
              <span>质量门禁</span>
              <button
                type="button"
                className="btn-secondary"
                disabled={
                  busy === "project" ||
                  busy === "generate-quality-gate-create"
                }
                onClick={() => void generateCreateProjectQualityGate()}
              >
                <Sparkles size={13} />
                {busy === "generate-quality-gate-create"
                  ? "AI 扫描生成中"
                  : "AI 扫描生成"}
              </button>
            </div>
            <textarea
              value={qualityCommands}
              onChange={(event) => setQualityCommands(event.target.value)}
              placeholder={"npm run build\nnpm test"}
              required
            />
            <small>每行一条命令，至少配置一条。任务审核与本地合并都会执行这些命令。</small>
          </label>
        </Dialog>
      )}
      {!project ? (
        <section className="ai-workspace-empty">
          <div className="ai-empty-icon">
            <Layers3 size={24} />
          </div>
          <h2>先登记你的项目工作区</h2>
          <p>
            项目可以包含多个 Git 仓库。每个 Coder 任务只会获得一个服务的独立
            worktree。
          </p>
        </section>
      ) : (
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
                      {delivery.state === "drafting" && (
                        <button
                          type="button"
                          className="btn-danger"
                          disabled={busy === "delete-delivery"}
                          onClick={() => void removeDelivery()}
                        >
                          <Trash2 size={15} />
                          删除草稿
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
        </>
      )}
      {selectedTask && (
        <Dialog
          title="任务契约"
          ariaLabel="任务契约详情"
          className="ai-task-contract-dialog"
          bodyClassName="ai-task-contract-body"
          onClose={() => setSelectedTaskId("")}
          footer={
            <button type="button" className="btn-primary" onClick={() => setSelectedTaskId("")}>
              关闭
            </button>
          }
        >
          <div className="ai-task-contract-heading">
            <div>
              <span className="ai-status-chip">{deliveryStateName(selectedTask.state)}</span>
              <h3>{selectedTask.title}</h3>
              <p>{selectedTask.description}</p>
            </div>
            <small>{selectedTask.executionMode === "write" ? "写入任务" : "只读任务"} · {(selectedTask.executionContext ?? (selectedTask.executionMode === "readonly" ? "workspaceRoot" : "taskWorktree")) === "workspaceRoot" ? "项目根目录" : "任务 worktree"}</small>
          </div>
          <dl className="ai-task-contract-summary">
            <div><dt>目标仓库</dt><dd>{project?.repositories.find((repo) => repo.id === selectedTask.targetRepositoryId)?.name ?? "未识别仓库"}</dd></div>
            <div><dt>执行 Agent</dt><dd>{agents.find((agent) => agent.id === selectedTask.assignedAgentId || agent.id === selectedTask.preferredAgentId)?.name ?? "待调度"}</dd></div>
            <div><dt>分支</dt><dd>{selectedTaskContract?.branchName ?? "派发后创建"}</dd></div>
            <div>
              <dt>worktree</dt>
              <dd title={selectedTaskContract?.worktreePath ?? ""}>{selectedTaskContract?.worktreePath ?? "派发后创建"}
                {selectedTaskContract?.worktreePath && (<button type="button" className="ai-contract-open-btn" onClick={() => void openInExplorer(selectedTaskContract.worktreePath!)}>打开</button>)}
              </dd>
            </div>
            <div>
              <dt>成果目录</dt>
              <dd title={selectedTaskContract?.outputArtifactDirectory ?? ""}>{selectedTaskContract?.outputArtifactDirectory ?? "任务 worktree"}
                {selectedTaskContract?.outputArtifactDirectory && (<button type="button" className="ai-contract-open-btn" onClick={() => void openInExplorer(selectedTaskContract.outputArtifactDirectory!)}>打开</button>)}
              </dd>
            </div>
            <div><dt>审计基线</dt><dd title={selectedTaskContract?.baseCommit ?? ""}>{selectedTaskContract?.baseCommit ?? "派发后记录"}</dd></div>
          </dl>
          <section className="ai-task-contract-section">
            <h4>允许写入</h4>
            <ul>{selectedTask.allowedWritePaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          </section>
          <section className="ai-task-contract-section">
            <h4>依赖任务</h4>
            {selectedTask.dependencyIds.length === 0 ? <p>无前置任务</p> : <ul>{selectedTask.dependencyIds.map((id) => <li key={id}>{tasks.find((task) => task.id === id)?.title ?? id}</li>)}</ul>}
          </section>
          <section className="ai-task-contract-section ai-task-contract-artifacts">
            <div><h4>输入成果</h4>{selectedTask.inputArtifacts.length === 0 ? <p>无</p> : <ul>{selectedTask.inputArtifacts.map((path) => <li key={path}><code>{path}</code></li>)}</ul>}{selectedTaskContract?.inputArtifactDirectory && (<button type="button" className="ai-contract-open-btn" onClick={() => void openInExplorer(selectedTaskContract.inputArtifactDirectory!)}>打开输入目录</button>)}</div>
            <div><h4>预期成果</h4>{selectedTask.expectedArtifacts.length === 0 ? <p>无</p> : <ul>{selectedTask.expectedArtifacts.map((path) => <li key={path}><code>{path}</code></li>)}</ul>}{selectedTaskContract?.outputArtifactDirectory && (<button type="button" className="ai-contract-open-btn" onClick={() => void openInExplorer(selectedTaskContract.outputArtifactDirectory!)}>打开成果目录</button>)}</div>
          </section>
          <section className="ai-task-contract-section">
            <h4>验收命令</h4>
            {selectedTask.acceptanceCommands.length === 0 ? <p>未声明验收命令</p> : <pre>{selectedTask.acceptanceCommands.join("\n")}</pre>}
          </section>
          <section className="ai-task-contract-section">
            <h4>给 Agent 的任务说明</h4>
            <pre>{selectedTask.taskPrompt}</pre>
          </section>
        </Dialog>
      )}
      {showTaskDialog && delivery && project && (
        <Dialog
          title="新增任务"
          ariaLabel="新增交付任务"
          className="ai-task-create-dialog"
          bodyClassName="ai-task-create-body"
          onClose={() => setShowTaskDialog(false)}
          onSubmit={(event) => {
            event.preventDefault();
            void createManualTask();
          }}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setShowTaskDialog(false)}>
                取消
              </button>
              <button type="submit" className="btn-primary" disabled={busy === "create-task"}>
                <Plus size={15} />
                添加任务
              </button>
            </>
          }
        >
          <p>手工任务会进入待批准任务图；批准前不会创建 worktree 或启动 Agent。</p>
          <div className="ai-task-create-grid">
            <label>
              任务标题
              <input autoFocus value={manualTaskTitle} onChange={(event) => setManualTaskTitle(event.target.value)} placeholder="例如：实现导入接口" />
            </label>
            <label>
              目标仓库
              <select value={manualTaskRepositoryId} onChange={(event) => setManualTaskRepositoryId(event.target.value)}>
                <option value="">选择允许写入的仓库</option>
                {project.repositories.filter((repository) => repository.writeEnabled).map((repository) => <option key={repository.id} value={repository.id}>{repository.name}</option>)}
              </select>
            </label>
            <label>
              执行模式
              <select value={manualTaskExecutionMode} onChange={(event) => {
                const executionMode = event.target.value as "write" | "readonly";
                setManualTaskExecutionMode(executionMode);
                setManualTaskExecutionContext(executionMode === "write" ? "taskWorktree" : "workspaceRoot");
              }}>
                <option value="write">写入</option>
                <option value="readonly">只读</option>
              </select>
            </label>
            <label>
              执行目录
              <select
                value={manualTaskExecutionContext}
                disabled={manualTaskExecutionMode === "write"}
                onChange={(event) => setManualTaskExecutionContext(event.target.value as "workspaceRoot" | "taskWorktree")}
              >
                <option value="workspaceRoot">项目工作区根目录</option>
                <option value="taskWorktree">任务 worktree</option>
              </select>
            </label>
            {!manualTaskRoleId && <label>
              优先 Agent
              <select
                value={manualTaskAgentId}
                onChange={(event) => setManualTaskAgentId(event.target.value)}
              >
                <option value="">由调度器选择</option>
                {agents.filter((agent) => agent.enabled).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>}
            <label>
              角色
              <select
                value={manualTaskRoleId}
                onChange={(event) => {
                  setManualTaskRoleId(event.target.value);
                  if (event.target.value) setManualTaskAgentId("");
                }}
              >
                <option value="">不限定角色</option>
                {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
              </select>
            </label>
            <label>
              最大重试次数
              <input type="number" min="0" max="10" value={manualTaskRetryCount} onChange={(event) => setManualTaskRetryCount(event.target.value)} />
            </label>
          </div>
          <label>
            任务说明
            <textarea value={manualTaskDescription} onChange={(event) => setManualTaskDescription(event.target.value)} placeholder="说明目标、范围和完成条件" />
          </label>
          <label>
            给 Agent 的任务说明
            <textarea value={manualTaskPrompt} onChange={(event) => setManualTaskPrompt(event.target.value)} placeholder="留空时使用任务说明" />
          </label>
          <label>
            允许写入路径（每行或逗号分隔）
            <textarea value={manualTaskAllowedPaths} onChange={(event) => setManualTaskAllowedPaths(event.target.value)} placeholder="src/features/import" />
          </label>
          {tasks.length > 0 && (
            <fieldset className="ai-task-dependencies">
              <legend>前置任务</legend>
              {tasks.map((task) => <label key={task.id}><input type="checkbox" checked={manualTaskDependencyIds.includes(task.id)} onChange={(event) => setManualTaskDependencyIds((current) => event.target.checked ? [...current, task.id] : current.filter((id) => id !== task.id))} />{task.title}</label>)}
            </fieldset>
          )}
          <div className="ai-task-create-grid ai-task-create-artifacts">
            <label>
              输入成果（每行或逗号分隔）
              <textarea value={manualTaskInputArtifacts} onChange={(event) => setManualTaskInputArtifacts(event.target.value)} />
            </label>
            <label>
              预期成果（每行或逗号分隔）
              <textarea value={manualTaskExpectedArtifacts} onChange={(event) => setManualTaskExpectedArtifacts(event.target.value)} />
            </label>
          </div>
          <label>
            验收命令（每行一条）
            <textarea value={manualTaskAcceptanceCommands} onChange={(event) => setManualTaskAcceptanceCommands(event.target.value)} placeholder="npm test" />
          </label>
        </Dialog>
      )}
      {showDeliveryDialog && (
        <Dialog
          title="新建交付"
          ariaLabel="新建交付"
          className="ai-delivery-create-dialog"
          bodyClassName="ai-delivery-create-body"
          onClose={() => setShowDeliveryDialog(false)}
          onSubmit={(event) => {
            event.preventDefault();
            void createDelivery();
          }}
          footer={
            <>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowDeliveryDialog(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={busy === "delivery"}
              >
                <Sparkles size={15} />
                创建草案
              </button>
            </>
          }
        >
          <p>管理者先生成可审核的任务图，确认后才会派发本机 Agent。</p>
          <label>
            交付标题
            <input
              autoFocus
              value={deliveryTitle}
              onChange={(event) => setDeliveryTitle(event.target.value)}
              placeholder="例如：增加用户批量导入"
            />
          </label>
          <label>
            需求说明
            <textarea
              value={requirement}
              onChange={(event) => setRequirement(event.target.value)}
              placeholder="描述目标、约束和验收标准"
            />
          </label>
          <label>
            管理者 Agent
            <select
              value={managerId}
              onChange={(event) => setManagerId(event.target.value)}
            >
              <option value="" disabled>选择管理者 Agent</option>
              {agents
                .filter((item) => item.enabled)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="ai-workflow-picker">
            <label>
              任务编排
              <select
                value={workflowId}
                onChange={(event) => setWorkflowId(event.target.value)}
              >
                <option value="" disabled>选择任务编排</option>
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}（{workflow.steps.length} 步）
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => openConfiguration("workflow", "create")}
            >
              <Workflow size={14} />
              管理编排
            </button>
          </div>
        </Dialog>
      )}
      {showDeliveryEditDialog && delivery && (
        <Dialog
          title="编辑交付草案"
          ariaLabel="编辑交付草案"
          className="ai-delivery-create-dialog"
          bodyClassName="ai-delivery-create-body"
          onClose={() => setShowDeliveryEditDialog(false)}
          onSubmit={(event) => {
            event.preventDefault();
            void updateDelivery();
          }}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setShowDeliveryEditDialog(false)}>取消</button>
              <button type="submit" className="btn-primary" disabled={busy === "update-delivery"}><Check size={15} />保存草案</button>
            </>
          }
        >
          <p>修改管理者或需求后再生成任务图。任务图生成后，草案将锁定以保持执行范围可审计。</p>
          <label>交付标题<input autoFocus value={editDeliveryTitle} onChange={(event) => setEditDeliveryTitle(event.target.value)} /></label>
          <label>需求说明<textarea value={editRequirement} onChange={(event) => setEditRequirement(event.target.value)} /></label>
          <label>管理者 Agent<select value={editManagerId} onChange={(event) => setEditManagerId(event.target.value)}><option value="" disabled>选择管理者 Agent</option>{agents.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <div className="ai-workflow-picker">
            <label>
              任务编排
              <select value={editWorkflowId} onChange={(event) => setEditWorkflowId(event.target.value)}>
                <option value="" disabled>选择任务编排</option>
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}（{workflow.steps.length} 步）
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => openConfiguration("workflow", "edit")}
            >
              <Workflow size={14} />
              管理编排
            </button>
          </div>
       </Dialog>
     )}
      {expandedOutputId && attemptOutputMap[expandedOutputId] && (
        <AttemptOutputDialog
          output={attemptOutputMap[expandedOutputId]}
          attemptLabel={(() => {
            const att = attempts.find((a) => a.id === expandedOutputId);
            const agent = agents.find((ag) => ag.id === att?.agentId);
            return agent?.name ?? att?.id ?? "";
          })()}
          onClose={() => setExpandedOutputId(null)}
        />
      )}
   </main>
  );
}
