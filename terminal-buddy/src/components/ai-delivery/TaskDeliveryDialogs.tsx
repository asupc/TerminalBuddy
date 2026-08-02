import { Check, Plus, Sparkles, Workflow } from "lucide-react";
import type React from "react";
import { Dialog } from "../shared/Dialog";
import { deliveryStateName, type AiDeliveryConfigView } from "./workspace-utils";
import type {
  AiAgent, AiDelivery, AiProject,
  AiTaskContract, AiTaskNode, AiWorkflow,
} from "../../types/aiDelivery";
import { openInExplorer } from "../../services/tauri";
import { TaskNodeFields, type TaskNodeFieldsProps } from "./TaskNodeFields";

interface TaskContractDialogProps {
  task: AiTaskNode;
  taskContract: AiTaskContract | undefined;
  project: AiProject | null;
  agents: AiAgent[];
  tasks: AiTaskNode[];
  onClose: () => void;
}

export function TaskContractDialog({
  task, taskContract, project, agents, tasks, onClose,
}: TaskContractDialogProps) {
  const selectedTask = task;
  const selectedTaskContract = taskContract;
  return (
    <Dialog
      title="任务契约"
      ariaLabel="任务契约详情"
      className="ai-task-contract-dialog"
      bodyClassName="ai-task-contract-body"
      onClose={() => onClose()}
      footer={
        <button type="button" className="btn-primary" onClick={() => onClose()}>
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
  );
}

interface TaskCreateDialogProps extends TaskNodeFieldsProps {
  busy: string | null;
  onClose: () => void;
  onSubmit: () => void;
}

export function TaskCreateDialog(props: TaskCreateDialogProps) {
  const { busy, onClose, onSubmit } = props;
  return (
    <Dialog
      title="新增任务"
      ariaLabel="新增交付任务"
      className="ai-task-create-dialog"
      bodyClassName="ai-task-create-body"
      onClose={() => onClose()}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={() => onClose()}>
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
      <TaskNodeFields {...props} />
    </Dialog>
  );
}

interface DeliveryCreateDialogProps {
  busy: string | null;
  deliveryTitle: string;
  setDeliveryTitle: React.Dispatch<React.SetStateAction<string>>;
  requirement: string;
  setRequirement: React.Dispatch<React.SetStateAction<string>>;
  managerId: string;
  setManagerId: React.Dispatch<React.SetStateAction<string>>;
  workflowId: string;
  setWorkflowId: React.Dispatch<React.SetStateAction<string>>;
  agents: AiAgent[];
  workflows: AiWorkflow[];
  onClose: () => void;
  onSubmit: () => void;
  onOpenConfiguration: (view: AiDeliveryConfigView, returnTarget: "create" | "edit" | null) => void;
}

export function DeliveryCreateDialog({
  busy, deliveryTitle, setDeliveryTitle, requirement, setRequirement,
  managerId, setManagerId, workflowId, setWorkflowId,
  agents, workflows, onClose, onSubmit, onOpenConfiguration,
}: DeliveryCreateDialogProps) {
  return (
    <Dialog
      title="新建交付"
      ariaLabel="新建交付"
      className="ai-delivery-create-dialog"
      bodyClassName="ai-delivery-create-body"
      onClose={() => onClose()}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      footer={
        <>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onClose()}
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
          onClick={() => onOpenConfiguration("workflow", "create")}
        >
          <Workflow size={14} />
          管理编排
        </button>
      </div>
    </Dialog>
  );
}

interface DeliveryEditDialogProps {
  delivery: AiDelivery;
  busy: string | null;
  editDeliveryTitle: string;
  setEditDeliveryTitle: React.Dispatch<React.SetStateAction<string>>;
  editRequirement: string;
  setEditRequirement: React.Dispatch<React.SetStateAction<string>>;
  editManagerId: string;
  setEditManagerId: React.Dispatch<React.SetStateAction<string>>;
  editWorkflowId: string;
  setEditWorkflowId: React.Dispatch<React.SetStateAction<string>>;
  agents: AiAgent[];
  workflows: AiWorkflow[];
  onClose: () => void;
  onSave: () => void;
  onOpenConfiguration: (view: AiDeliveryConfigView, returnTarget: "create" | "edit" | null) => void;
}

export function DeliveryEditDialog({
  delivery, busy, editDeliveryTitle, setEditDeliveryTitle,
  editRequirement, setEditRequirement, editManagerId, setEditManagerId,
  editWorkflowId, setEditWorkflowId, agents, workflows, onClose, onSave, onOpenConfiguration,
}: DeliveryEditDialogProps) {
  void delivery;
  return (
    <Dialog
      title="编辑交付草案"
      ariaLabel="编辑交付草案"
      className="ai-delivery-create-dialog"
      bodyClassName="ai-delivery-create-body"
      onClose={() => onClose()}
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={() => onClose()}>取消</button>
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
          onClick={() => onOpenConfiguration("workflow", "edit")}
        >
          <Workflow size={14} />
          管理编排
        </button>
      </div>
   </Dialog>
  );
}