import { useState } from "react";
import {
  ArrowDown, ArrowUp, Bot, Check,
  ChevronDown, ChevronRight, Eye,
  Plus, SquareTerminal, Trash2, Users, Workflow,
} from "lucide-react";
import { Dialog } from "../shared/Dialog";
import { TaskDagView } from "./TaskDagView";
import { type AiDeliveryConfigView, parseRuntimeArgs } from "./workspace-utils";
import type {
  AiAgent, AiAgentRuntime, AiRole, AiRuntimeProbe, AiTaskNode, AiWorkflow,
  AiWorkflowStep,
} from "../../types/aiDelivery";
import { testWorkflowStep } from "../../services/tauri";

interface ConfigDialogProps {
  view: AiDeliveryConfigView;
  onViewChange: (view: AiDeliveryConfigView) => void;
  onClose: () => void;
  workflows: AiWorkflow[];
  roles: AiRole[];
  agents: AiAgent[];
  savedRuntimes: AiAgentRuntime[];
  runtimeProbes: AiRuntimeProbe[];
  isRuntimeDetecting: boolean;
  busy: string | null;
  setError: (error: string) => void;
  onCreateWorkflow: () => void;
  onSaveWorkflowConfig: (workflow: AiWorkflow, patch: Partial<Pick<AiWorkflow, "name" | "description" | "steps">>) => Promise<void>;
  onRemoveWorkflow: (workflow: AiWorkflow) => void;
  onAddWorkflowStep: (workflow: AiWorkflow) => void;
  onUpdateWorkflowStep: (workflow: AiWorkflow, stepId: string, patch: Partial<AiWorkflowStep>) => Promise<void>;
  onMoveWorkflowStep: (workflow: AiWorkflow, stepIndex: number, direction: -1 | 1) => void;
  onRemoveWorkflowStep: (workflow: AiWorkflow, stepId: string) => Promise<void>;
  onCreateRole: () => void;
  onSaveRoleAgent: (role: AiRole, agentId: string) => Promise<void>;
  onSaveRoleDetails: (role: AiRole, details: { name: string; description: string }) => Promise<void>;
  onRemoveRole: (role: AiRole) => void;
  onCreateRuntime: (params: { name: string; kind: string; command: string }) => Promise<void>;
  onSaveRuntimeConfig: (runtime: AiAgentRuntime, patch: Partial<AiAgentRuntime>) => Promise<void>;
  onRemoveRuntime: (runtime: AiAgentRuntime) => void;
  onCreateAgent: () => void;
  onSaveAgentConfig: (agent: AiAgent, patch: Partial<AiAgent>) => Promise<void>;
  onRemoveAgent: (agent: AiAgent) => void;
}

/** AI 交付配置对话框，包含任务编排、角色、Runtime 和 Agent 管理。 */
export function ConfigDialog({
  view, onViewChange, onClose,
  workflows, roles, agents, savedRuntimes, runtimeProbes, isRuntimeDetecting,
  busy, setError,
  onCreateWorkflow, onSaveWorkflowConfig, onRemoveWorkflow,
  onAddWorkflowStep, onUpdateWorkflowStep, onMoveWorkflowStep, onRemoveWorkflowStep,
  onCreateRole, onSaveRoleAgent, onSaveRoleDetails, onRemoveRole,
  onCreateRuntime, onSaveRuntimeConfig, onRemoveRuntime,
  onCreateAgent, onSaveAgentConfig, onRemoveAgent,
}: ConfigDialogProps) {
  const [expandedWorkflowId, setExpandedWorkflowId] = useState<string | null>(null);
  const [showRuntimeCreate, setShowRuntimeCreate] = useState(false);
  const [newRuntimeName, setNewRuntimeName] = useState("");
  const [newRuntimeKind, setNewRuntimeKind] = useState("");
  const [newRuntimeCommand, setNewRuntimeCommand] = useState("");
  const [previewWorkflow, setPreviewWorkflow] = useState<AiWorkflow | null>(null);
  const [draggedStepId, setDraggedStepId] = useState<string | null>(null);
  const [testingStepId, setTestingStepId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  // 工作流拓扑预览：把 steps 映射为模拟任务节点（依赖 = 前一 step），只读渲染
  const previewTasks = (workflow: AiWorkflow): AiTaskNode[] =>
    workflow.steps.map((step, index) => ({
      id: `preview-step-${step.id}`,
      deliveryId: "preview",
      title: step.name,
      description: step.prompt || "（未填写步骤提示词）",
      roleId: step.roleId,
      workflowStepId: step.id,
      preferredAgentId: null,
      taskPrompt: step.prompt,
      executionMode: step.executionMode,
      executionContext: step.executionContext ?? (step.executionMode === "readonly" ? "workspaceRoot" : "taskWorktree"),
      targetRepositoryId: "",
      allowedWritePaths: [],
      dependencyIds: index > 0 ? [`preview-step-${workflow.steps[index - 1].id}`] : [],
      inputArtifacts: [],
      expectedArtifacts: [],
      acceptanceCommands: [],
      retryCount: 3,
      state: "planned",
      attemptIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

  // HTML5 拖拽重排 steps
  const dropWorkflowStep = (workflow: AiWorkflow, targetStepId: string) => {
    if (!draggedStepId || draggedStepId === targetStepId) return;
    const from = workflow.steps.findIndex((step) => step.id === draggedStepId);
    const to = workflow.steps.findIndex((step) => step.id === targetStepId);
    if (from === -1 || to === -1) return;
    const steps = [...workflow.steps];
    const [moved] = steps.splice(from, 1);
    steps.splice(to, 0, moved);
    setDraggedStepId(null);
    void saveWorkflowConfig(workflow, { steps });
  };

  const runStepTest = (workflow: AiWorkflow, step: AiWorkflowStep) => {
    setTestingStepId(step.id);
    setTestResults((results) => {
      const next = { ...results };
      delete next[step.id];
      return next;
    });
    void testWorkflowStep(step.id, workflow.name)
      .then((output) => {
        setTestResults((results) => ({ ...results, [step.id]: output }));
      })
      .catch((reason) => {
        setTestResults((results) => ({
          ...results,
          [step.id]: `模拟失败：${reason instanceof Error ? reason.message : String(reason)}`,
        }));
      })
      .finally(() => setTestingStepId(null));
  };

  // 映射到原始变量名，保持提取的 JSX 不变
  const configDialogView = view;
  const onConfigDialogViewChange = onViewChange;
  const closeConfiguration = onClose;
  const runtimes = runtimeProbes;
  const createWorkflow = onCreateWorkflow;
  const saveWorkflowConfig = onSaveWorkflowConfig;
  const removeWorkflow = onRemoveWorkflow;
  const addWorkflowStep = onAddWorkflowStep;
  const updateWorkflowStep = onUpdateWorkflowStep;
  const moveWorkflowStep = onMoveWorkflowStep;
  const removeWorkflowStep = onRemoveWorkflowStep;
  const createRole = onCreateRole;
  const saveRoleAgent = onSaveRoleAgent;
  const saveRoleDetails = onSaveRoleDetails;
  const removeRole = onRemoveRole;
  const saveRuntimeConfig = onSaveRuntimeConfig;
  const removeRuntime = onRemoveRuntime;
  const createAgent = onCreateAgent;
  const saveAgentConfig = onSaveAgentConfig;
  const removeAgent = onRemoveAgent;
  const openRuntimeCreate = () => {
    setNewRuntimeName("");
    setNewRuntimeKind("");
    setNewRuntimeCommand("");
    setShowRuntimeCreate(true);
  };
  const createRuntime = () =>
    void onCreateRuntime({ name: newRuntimeName, kind: newRuntimeKind, command: newRuntimeCommand })
      .then(() => { setShowRuntimeCreate(false); });

  return (
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
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setPreviewWorkflow(workflow)}
                      >
                        <Eye size={14} />
                        预览拓扑
                      </button>
                    </div>
                  </div>
                  <div className="ai-workflow-steps">
                    {workflow.steps.map((step, stepIndex) => {
                      return (
                      <div
                        className={`ai-workflow-step${draggedStepId === step.id ? " dragging" : ""}`}
                        key={step.id}
                        draggable
                        onDragStart={() => setDraggedStepId(step.id)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => dropWorkflowStep(workflow, step.id)}
                        onDragEnd={() => setDraggedStepId(null)}
                      >
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
                            className="btn-secondary"
                            title="用当前默认 Claude 运行时模拟执行一次该步骤提示词（实验性）"
                            disabled={testingStepId !== null || busy === `workflow-${workflow.id}`}
                            onClick={() => runStepTest(workflow, step)}
                          >
                            <SquareTerminal size={13} />
                            {testingStepId === step.id ? "模拟中..." : "模拟测试"}
                          </button>
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
                        {testResults[step.id] && (
                          <pre className="ai-workflow-step-test-result">
                            {testResults[step.id]}
                          </pre>
                        )}
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
          <span>角色名</span>
          <span>角色备注</span>
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
                </div>
                <div className="ai-role-remark">
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
                    <div className="ai-runtime-config-status">
                      <small className={!isRuntimeDetecting && probe?.available ? "online" : ""}>
                        {isRuntimeDetecting ? "检测中" : probe?.available ? "已就绪" : "不可用"}
                      </small>
                    </div>
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
                    <label className="ai-runtime-config-enable">
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
                  void saveAgentConfig(agent, { runtimeId });
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
                    void saveAgentConfig(agent, { runtimeArgs });
                }}
              />
            </label>
            <label>
              默认超时（分钟）
              <input
                type="number"
                min="5"
                max="480"
                value={agent.defaultTimeoutSeconds ? String(Math.round(agent.defaultTimeoutSeconds / 60)) : ""}
                placeholder="留空使用 60 分钟"
                onChange={(event) => {
                  const value = event.target.value;
                  void saveAgentConfig(agent, {
                    defaultTimeoutSeconds: value ? Number(value) * 60 : null,
                  });
                }}
              />
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
      {previewWorkflow && (
        <Dialog
          title={`任务拓扑预览 — ${previewWorkflow.name}`}
          onClose={() => setPreviewWorkflow(null)}
          className="ai-workflow-preview-dialog"
          style={{ width: "min(1180px, 96vw)", height: "min(800px, 90vh)" }}
        >
          <p className="ai-workflow-preview-hint">
            将按步骤顺序生成串行任务（每个步骤一个节点，依赖前一步骤）。实际派发时同一步骤可拆分为多个并行任务。
          </p>
          <TaskDagView
            tasks={previewTasks(previewWorkflow)}
            roles={roles}
            agents={agents}
            runtimes={savedRuntimes}
            onNodeClick={() => undefined}
          />
        </Dialog>
      )}
    </Dialog>
  );
}
