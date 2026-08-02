import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CircleHelp,
  CircleAlert,
  FolderGit2,
  Layers3,
  Pencil,
  Plus,
  RefreshCw,
  WandSparkles,
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
} from "../../types/aiDelivery";
import type { ExtraParamPreset } from "../../types";
import {
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
  readClientData,
  replanLegacyAiDelivery,
  refreshAiProjectRepositories,
  readAiAttemptOutput,
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
} from "../../services/tauri";
 import { showConfirm } from "../../services/dialog";
 import { AttemptOutputDialog } from "./AttemptOutputDialog";
import { getAppSettings, saveAppSettings } from "../../utils/settings";
import { runtimeName, timestamp, displayLocalPath, parseTaskLines, boardColumns, DeliveryTabId, taskColumn, isLegacyTaskGraph, deliveryStateFilterGroups, deliveryStateFilterById, pickMostRecentDelivery, pickMostRecentProject, isFailedEventType, isFailedAttemptState, AiDeliveryConfigView, defaultDeliveryStateFilterIds } from './workspace-utils';

import { ProjectOverviewDialog, ProjectSettingsDialog, ProjectFormDialog } from "./ProjectDialogs";
import { ConfigDialog } from "./ConfigDialog";
import { TaskContractDialog, TaskCreateDialog, DeliveryCreateDialog, DeliveryEditDialog } from "./TaskDeliveryDialogs";
import { DeliveryDetail } from "./DeliveryDetail";

import "./AiDeliveryWorkspace.css";

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
  const [manualTaskTimeoutMinutes, setManualTaskTimeoutMinutes] = useState("");
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
    setManualTaskTimeoutMinutes("");
    setManualTaskExecutionContext("taskWorktree");
    setShowTaskDialog(true);
  };
  const defaultAgentTimeoutText = (() => {
    const seconds = agents.find((a) => a.defaultTimeoutSeconds)?.defaultTimeoutSeconds ?? 3600;
    return `${Math.round(seconds / 60)} 分钟`;
  })();
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
      const timeoutSeconds = manualTaskTimeoutMinutes
        ? Number(manualTaskTimeoutMinutes) * 60
        : null;
      if (manualTaskTimeoutMinutes && (!Number.isInteger(timeoutSeconds) || timeoutSeconds! < 300 || timeoutSeconds! > 28800))
        throw new Error("超时时间必须是 5 到 480 分钟的整数。");
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
        timeoutSeconds,
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
     if (!delivery || !["drafting", "cancelled", "failed", "succeeded", "completed"].includes(delivery.state)) return;
      const isDraft = delivery.state === "drafting";
      if (!await showConfirm(
        isDraft
          ? `确定删除草稿"${delivery.title}"吗？`
          : `确定删除已结束的交付"${delivery.title}"吗？此操作将清理关联的 worktree、分支和数据，且不可恢复。`,
        {
          title: isDraft ? "确认删除草稿" : "确认删除交付",
          confirmText: "删除",
          danger: true,
        }
      )) return;
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
      await refresh();
    });
  const addWorkflowStep = (workflow: AiWorkflow) => {
    const role = roles.find((item) => item.lockedAgentId || item.candidateAgentIds.length);
    if (!role) {
      setError("请先创建一个已绑定执行 Agent 的角色。");
      return;
    }
    const stepId = crypto.randomUUID();
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
  const handleCreateRuntime = (params: { name: string; kind: string; command: string }) =>
    execute("create-runtime", async () => {
      if (!params.name.trim() || !params.kind.trim() || !params.command.trim())
        throw new Error("请填写 Runtime 名称、类型和命令。");
      const stamp = timestamp();
      await saveAiRuntime({
        id: crypto.randomUUID(),
        name: params.name.trim(),
        kind: params.kind.trim().toLowerCase(),
        command: params.command.trim(),
        enabled: true,
        createdAt: stamp,
        updatedAt: stamp,
      });
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
        <ConfigDialog
          view={configDialogView}
          onViewChange={onConfigDialogViewChange}
          onClose={closeConfiguration}
          workflows={workflows}
          roles={roles}
          agents={agents}
          savedRuntimes={savedRuntimes}
          runtimeProbes={runtimes}
          isRuntimeDetecting={isRuntimeDetecting}
          presets={presets}
          busy={busy}
          setError={setError}
          onCreateWorkflow={() => void createWorkflow()}
          onSaveWorkflowConfig={saveWorkflowConfig}
          onRemoveWorkflow={removeWorkflow}
          onAddWorkflowStep={addWorkflowStep}
          onUpdateWorkflowStep={updateWorkflowStep}
          onMoveWorkflowStep={moveWorkflowStep}
          onRemoveWorkflowStep={removeWorkflowStep}
          onCreateRole={() => void createRole()}
          onSaveRoleAgent={saveRoleAgent}
          onSaveRoleDetails={saveRoleDetails}
          onRemoveRole={removeRole}
          onCreateRuntime={handleCreateRuntime}
          onSaveRuntimeConfig={saveRuntimeConfig}
          onRemoveRuntime={removeRuntime}
          onCreateAgent={() => void createAgent()}
          onSaveAgentConfig={saveAgentConfig}
          onRemoveAgent={removeAgent}
        />
      )}
      {showProjectOverview && project && (
        <ProjectOverviewDialog project={project} onClose={() => setShowProjectOverview(false)} />
      )}
      {showProjectSettings && project && (
        <ProjectSettingsDialog
          project={project}
          busy={busy}
          editProjectName={editProjectName}
          setEditProjectName={setEditProjectName}
          editProjectMaxConcurrency={editProjectMaxConcurrency}
          setEditProjectMaxConcurrency={setEditProjectMaxConcurrency}
          editProjectQualityCommands={editProjectQualityCommands}
          setEditProjectQualityCommands={setEditProjectQualityCommands}
          editProjectRepositories={editProjectRepositories}
          setEditProjectRepositories={setEditProjectRepositories}
          onClose={() => setShowProjectSettings(false)}
          onSubmit={() => void saveProjectSettings()}
          onRegenerateQualityGate={() => void regenerateProjectQualityGate()}
          onRefreshRepositories={() => void refreshProjectRepositories()}
          onRemoveProject={() => void removeProject()}
        />
      )}
      {showProjectForm && (
        <ProjectFormDialog
          busy={busy}
          projectName={projectName}
          setProjectName={setProjectName}
          workspaceRoot={workspaceRoot}
          setWorkspaceRoot={setWorkspaceRoot}
          qualityCommands={qualityCommands}
          setQualityCommands={setQualityCommands}
          onClose={() => setShowProjectForm(false)}
          onCreate={() => void createProject()}
          onBrowseWorkspaceRoot={() => void browseWorkspaceRoot()}
          onGenerateQualityGate={() => void generateCreateProjectQualityGate()}
        />
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
        <DeliveryDetail
          tasks={tasks} agents={agents} roles={roles}
         reviewGateByTask={reviewGateByTask}
         project={project} delivery={delivery} deliveries={deliveries}
         attempts={attempts} deliveryEvents={deliveryEvents}
          filteredDeliveries={filteredDeliveries}
          filteredAttempts={filteredAttempts}
          filteredRecentDeliveryEvents={filteredRecentDeliveryEvents}
          visibleTasks={visibleTasks} taskCountsByColumn={taskCountsByColumn}
          legacyTaskGraph={legacyTaskGraph} allTasksApproved={allTasksApproved}
          pendingDecisions={pendingDecisions} lastMergeRecord={lastMergeRecord}
          deliveryId={deliveryId} activeTaskTab={activeTaskTab} busy={busy}
          showSuccessAttempts={showSuccessAttempts} showFailedAttempts={showFailedAttempts}
          showSuccessEvents={showSuccessEvents} showFailedEvents={showFailedEvents}
          loadingOutputId={loadingOutputId}
          decisionAnswers={decisionAnswers}
          selectDelivery={selectDelivery} setActiveTaskTab={setActiveTaskTab}
          setSelectedTaskId={setSelectedTaskId}
          setShowDeliveryDialog={setShowDeliveryDialog}
          setDecisionAnswers={setDecisionAnswers}
          setShowSuccessAttempts={setShowSuccessAttempts}
          setShowFailedAttempts={setShowFailedAttempts}
          setShowSuccessEvents={setShowSuccessEvents}
          setShowFailedEvents={setShowFailedEvents}
          openManualTaskDialog={openManualTaskDialog}
          openDeliveryEditor={openDeliveryEditor}
          execute={execute}
          dispatchAndStartReadyTasks={dispatchAndStartReadyTasks}
          answerDecision={answerDecision} retryTask={retryTask}
          runReview={runReview} resolveReview={resolveReview}
          toggleAttemptOutput={toggleAttemptOutput}
          openAttemptTerminal={openAttemptTerminal}
          cancelAttempt={cancelAttempt} completeAttempt={completeAttempt}
          removeDelivery={removeDelivery}
          replanLegacyDelivery={replanLegacyDelivery}
          cancelDelivery={cancelDelivery}
          mergeDelivery={mergeDelivery}
          cleanupDeliveryIntegration={cleanupDeliveryIntegration}
          planAiDeliveryWithManager={planAiDeliveryWithManager}
          refresh={refresh}
        />
      )}
      {selectedTask && (
        <TaskContractDialog
          task={selectedTask} taskContract={selectedTaskContract ?? undefined}
          project={project} agents={agents} tasks={tasks}
          onClose={() => setSelectedTaskId("")}
        />
      )}
      {showTaskDialog && delivery && project && (
        <TaskCreateDialog
          project={project} agents={agents} roles={roles} tasks={tasks} busy={busy}
          manualTaskTitle={manualTaskTitle} setManualTaskTitle={setManualTaskTitle}
          manualTaskRepositoryId={manualTaskRepositoryId} setManualTaskRepositoryId={setManualTaskRepositoryId}
          manualTaskExecutionMode={manualTaskExecutionMode} setManualTaskExecutionMode={setManualTaskExecutionMode}
          manualTaskExecutionContext={manualTaskExecutionContext} setManualTaskExecutionContext={setManualTaskExecutionContext}
          manualTaskRoleId={manualTaskRoleId} setManualTaskRoleId={setManualTaskRoleId}
          manualTaskAgentId={manualTaskAgentId} setManualTaskAgentId={setManualTaskAgentId}
          manualTaskRetryCount={manualTaskRetryCount} setManualTaskRetryCount={setManualTaskRetryCount}
          manualTaskDescription={manualTaskDescription} setManualTaskDescription={setManualTaskDescription}
          manualTaskPrompt={manualTaskPrompt} setManualTaskPrompt={setManualTaskPrompt}
          manualTaskAllowedPaths={manualTaskAllowedPaths} setManualTaskAllowedPaths={setManualTaskAllowedPaths}
          manualTaskDependencyIds={manualTaskDependencyIds} setManualTaskDependencyIds={setManualTaskDependencyIds}
          manualTaskInputArtifacts={manualTaskInputArtifacts} setManualTaskInputArtifacts={setManualTaskInputArtifacts}
          manualTaskExpectedArtifacts={manualTaskExpectedArtifacts} setManualTaskExpectedArtifacts={setManualTaskExpectedArtifacts}
          manualTaskAcceptanceCommands={manualTaskAcceptanceCommands} setManualTaskAcceptanceCommands={setManualTaskAcceptanceCommands}
          manualTaskTimeoutMinutes={manualTaskTimeoutMinutes} setManualTaskTimeoutMinutes={setManualTaskTimeoutMinutes}
          defaultAgentTimeoutText={defaultAgentTimeoutText}
          onClose={() => setShowTaskDialog(false)}
          onSubmit={() => void createManualTask()}
        />
      )}
      {showDeliveryDialog && (
        <DeliveryCreateDialog
          busy={busy}
          deliveryTitle={deliveryTitle} setDeliveryTitle={setDeliveryTitle}
          requirement={requirement} setRequirement={setRequirement}
          managerId={managerId} setManagerId={setManagerId}
          workflowId={workflowId} setWorkflowId={setWorkflowId}
          agents={agents} workflows={workflows}
          onClose={() => setShowDeliveryDialog(false)}
          onSubmit={() => void createDelivery()}
          onOpenConfiguration={openConfiguration}
        />
      )}
      {showDeliveryEditDialog && delivery && (
        <DeliveryEditDialog
          delivery={delivery} busy={busy}
          editDeliveryTitle={editDeliveryTitle} setEditDeliveryTitle={setEditDeliveryTitle}
          editRequirement={editRequirement} setEditRequirement={setEditRequirement}
          editManagerId={editManagerId} setEditManagerId={setEditManagerId}
          editWorkflowId={editWorkflowId} setEditWorkflowId={setEditWorkflowId}
          agents={agents} workflows={workflows}
          onClose={() => setShowDeliveryEditDialog(false)}
          onSave={() => void updateDelivery()}
          onOpenConfiguration={openConfiguration}
        />
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
