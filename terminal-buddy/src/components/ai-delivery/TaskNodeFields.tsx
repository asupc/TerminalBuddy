import type { AiAgent, AiProject, AiRole, AiTaskNode } from "../../types/aiDelivery";

/** TaskCreateDialog 与 TaskNodeEditor 共用的任务字段区（受控表单，由父组件持有 state）。 */
export interface TaskNodeFieldsProps {
  project: AiProject;
  agents: AiAgent[];
  roles: AiRole[];
  tasks: AiTaskNode[];
  manualTaskTitle: string;
  setManualTaskTitle: React.Dispatch<React.SetStateAction<string>>;
  manualTaskRepositoryId: string;
  setManualTaskRepositoryId: React.Dispatch<React.SetStateAction<string>>;
  manualTaskExecutionMode: "write" | "readonly";
  setManualTaskExecutionMode: React.Dispatch<React.SetStateAction<"write" | "readonly">>;
  manualTaskExecutionContext: "workspaceRoot" | "taskWorktree";
  setManualTaskExecutionContext: React.Dispatch<React.SetStateAction<"workspaceRoot" | "taskWorktree">>;
  manualTaskRoleId: string;
  setManualTaskRoleId: React.Dispatch<React.SetStateAction<string>>;
  manualTaskAgentId: string;
  setManualTaskAgentId: React.Dispatch<React.SetStateAction<string>>;
  manualTaskRetryCount: string;
  setManualTaskRetryCount: React.Dispatch<React.SetStateAction<string>>;
  manualTaskDescription: string;
  setManualTaskDescription: React.Dispatch<React.SetStateAction<string>>;
  manualTaskPrompt: string;
  setManualTaskPrompt: React.Dispatch<React.SetStateAction<string>>;
  manualTaskAllowedPaths: string;
  setManualTaskAllowedPaths: React.Dispatch<React.SetStateAction<string>>;
  manualTaskDependencyIds: string[];
  setManualTaskDependencyIds: React.Dispatch<React.SetStateAction<string[]>>;
  manualTaskInputArtifacts: string;
  setManualTaskInputArtifacts: React.Dispatch<React.SetStateAction<string>>;
  manualTaskExpectedArtifacts: string;
  setManualTaskExpectedArtifacts: React.Dispatch<React.SetStateAction<string>>;
  manualTaskAcceptanceCommands: string;
  setManualTaskAcceptanceCommands: React.Dispatch<React.SetStateAction<string>>;
  /** 超时（分钟），留空使用 Agent 默认 */
  manualTaskTimeoutMinutes: string;
  setManualTaskTimeoutMinutes: React.Dispatch<React.SetStateAction<string>>;
  /** Agent 默认超时提示文案，如「60 分钟」 */
  defaultAgentTimeoutText: string;
}

export function TaskNodeFields(props: TaskNodeFieldsProps) {
  const {
    project, agents, roles, tasks,
    manualTaskTitle, setManualTaskTitle,
    manualTaskRepositoryId, setManualTaskRepositoryId,
    manualTaskExecutionMode, setManualTaskExecutionMode,
    manualTaskExecutionContext, setManualTaskExecutionContext,
    manualTaskRoleId, setManualTaskRoleId,
    manualTaskAgentId, setManualTaskAgentId,
    manualTaskRetryCount, setManualTaskRetryCount,
    manualTaskDescription, setManualTaskDescription,
    manualTaskPrompt, setManualTaskPrompt,
    manualTaskAllowedPaths, setManualTaskAllowedPaths,
    manualTaskDependencyIds, setManualTaskDependencyIds,
    manualTaskInputArtifacts, setManualTaskInputArtifacts,
    manualTaskExpectedArtifacts, setManualTaskExpectedArtifacts,
    manualTaskAcceptanceCommands, setManualTaskAcceptanceCommands,
    manualTaskTimeoutMinutes, setManualTaskTimeoutMinutes,
    defaultAgentTimeoutText,
  } = props;

  return (
    <>
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
        <label>
          超时时间（分钟）
          <input type="number" min="5" max="480" placeholder="" value={manualTaskTimeoutMinutes}
            onChange={(event) => setManualTaskTimeoutMinutes(event.target.value)} />
          <span className="ai-field-hint">
            留空使用 Agent 默认（{defaultAgentTimeoutText}），设置范围 5-480
          </span>
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
    </>
  );
}
