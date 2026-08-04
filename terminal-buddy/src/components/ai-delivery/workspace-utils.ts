import type { AiDelivery, AiProject, AiTaskNode } from "../../types/aiDelivery";


export const runtimeName = (kind: string) =>
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
export const timestamp = () => new Date().toISOString();
export const displayLocalPath = (path: string) => {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
};
export const parseRuntimeArgs = (value: string) =>
  Array.from(
    value.matchAll(/(?:"([^"]*)")|(?:'([^']*)')|([^\s]+)/g),
    (match) => match[1] ?? match[2] ?? match[3],
  ).filter(Boolean);
export const parseTaskLines = (value: string) =>
  value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
export const boardColumns = [
  { id: "planned", title: "待规划" },
  { id: "needsInput", title: "待决策" },
  { id: "ready", title: "待执行" },
  { id: "running", title: "执行中" },
  { id: "awaitingReview", title: "验收中" },
  { id: "done", title: "已完成" },
  { id: "failed", title: "异常" },
] as const;
export type DeliveryTabId = "dag" | (typeof boardColumns)[number]["id"] | "attempts" | "events" | "artifacts" | "report";
export function taskColumn(task: AiTaskNode) {
  if (task.state === "succeeded" || task.state === "skipped") return "done";
  if (task.state === "awaitingReview") return "awaitingReview";
  if (["running", "queued"].includes(task.state)) return "running";
  if (task.state === "needsInput") return "needsInput";
  if (task.state === "ready") return "ready";
  if (["failed", "cancelled", "rework", "policyViolation"].includes(task.state)) return "failed";
  return "planned";
}
export const isLegacyTaskGraph = (delivery: AiDelivery, taskNodes: AiTaskNode[]) =>
  delivery.workflowSteps.length > 0 && taskNodes.some((task) =>
    !task.executionContext
      || task.expectedArtifacts.length === 0
      || task.expectedArtifacts.some((artifact) => /[\r\n]/.test(artifact) || artifact.includes("\uFF1A")),
  );
export const taskStateNames: Record<string, string> = {
  planned: "待规划",
  ready: "待执行",
  queued: "已入队",
  running: "执行中",
  needsInput: "等待决策",
  awaitingReview: "验收中",
  succeeded: "已完成",
  skipped: "已忽略",
  failed: "失败",
  cancelled: "已取消",
  rework: "待返工",
  policyViolation: "策略违规",
};
export const taskStateName = (state: string) => taskStateNames[state] ?? state;
export const deliveryStateNames: Record<string, string> = {
  drafting: "草稿",
  planning: "正在生成任务图",
  awaitingApproval: "待批准",
  running: "执行中",
  needsInput: "等待决策",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  mergeFailed: "合并失败",
  blocked: "已阻塞",
  succeeded: "已成功",
  cancelled: "已取消",
  merging: "合并中",
};
export const deliveryStateName = (state: string) => deliveryStateNames[state] ?? state;
export const ongoingDeliveryStates = new Set([
  "planning",
  "awaitingApproval",
  "running",
  "needsInput",
  "paused",
  "merging",
]);
export const deliveryStateFilterGroups = [
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
  { id: "mergeFailed", title: "合并失败" },
  { id: "blocked", title: "已阻塞" },
  { id: "cancelled", title: "已取消" },
] as const;
export const deliveryStateFilterIds = deliveryStateFilterGroups.flatMap((group) =>
  "children" in group ? group.children.map((child) => child.id) : [group.id],
);
export const deliveryStateFilterById: Record<string, { id: string; title: string; matches: (state: string) => boolean }> = {};
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
})();
export const defaultDeliveryStateFilterIds = deliveryStateFilterIds;
export const pickMostRecentDelivery = (items: AiDelivery[]) =>
  [...items].sort((left, right) => {
    const ongoingDifference = Number(ongoingDeliveryStates.has(right.state))
      - Number(ongoingDeliveryStates.has(left.state));
    return ongoingDifference || right.updatedAt.localeCompare(left.updatedAt);
  })[0];
export const pickMostRecentProject = (items: AiProject[]) =>
  [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
export const attemptStateNames: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  needsInput: "等待决策",
  interrupted: "已中断",
  policyViolation: "策略违规",
};
export const attemptStateName = (state: string) => attemptStateNames[state] ?? state;
export const mergeStateNames: Record<string, string> = {
  pending: "待合并",
  merging: "合并中",
  completed: "已完成",
  failed: "失败",
  rolledBack: "已回滚",
  rollbackFailed: "回滚失败",
  blocked: "已阻断",
};
export const mergeStateName = (state: string) => mergeStateNames[state] ?? state;
export const eventTypeNames: Record<string, string> = {
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
  taskRetryBlocked: "重试触顶",
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
  autoMerged: "自动合并成功",
  autoMergeFailed: "自动合并失败",
  deliverySucceeded: "交付成功",
  deliveryReplanned: "已重新规划",
  approachingTimeout: "即将超时",
  taskNodeEdited: "任务已编辑",
  taskNodeDeleted: "任务已删除",
  taskCancelled: "任务已取消",
  taskSkipped: "已标记忽略",
  policyViolationAccepted: "现场已确认",
};
export const eventTypeName = (eventType: string) => eventTypeNames[eventType] ?? eventType;
export const failedEventTypeSet = new Set(Object.keys(eventTypeNames).filter(
  (key) => key.endsWith("Failed") || key.endsWith("Cancelled") || key.endsWith("TimedOut") || key.endsWith("Interrupted") || key === "policyViolation",
));
export const isFailedEventType = (eventType: string) => failedEventTypeSet.has(eventType);
export const failedAttemptStateSet = new Set(["failed", "cancelled", "policyViolation"]);
export const isFailedAttemptState = (state: string) => failedAttemptStateSet.has(state);
export const formatEventTime = (value: string) => {
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
