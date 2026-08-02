import { useState } from "react";
import Editor from "@monaco-editor/react";
import { updateAiTaskNode, deleteAiTaskNode } from "../../services/tauri";
import type { AiTaskNode, AiAgent, AiRole, AiProject } from "../../types/aiDelivery";

interface Props {
  task: AiTaskNode;
  agents: AiAgent[];
  roles: AiRole[];
  project: AiProject;
  deliveryTasks: AiTaskNode[];
  onClose: () => void;
  onSaved: () => void;
}

/** 任务节点编辑抽屉：左侧字段表单 + 右侧实时预览；环依赖即时检测阻止保存；删除带级联清理确认。 */
export function TaskNodeEditor({ task, agents, roles, project, deliveryTasks, onClose, onSaved }: Props) {
  const [form, setForm] = useState({ ...task, dependencyIds: [...task.dependencyIds] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 环依赖即时检测（保存 disabled 条件，与后端 has_cycle 语义一致）
  const hasCycle = (() => {
    const others = deliveryTasks.filter((t) => t.id !== task.id);
    const graph = new Map<string, string[]>(others.map((t) => [t.id, t.dependencyIds]));
    graph.set(task.id, form.dependencyIds);
    const visiting = new Set<string>();
    const dfs = (id: string): boolean => {
      if (visiting.has(id)) return true;
      visiting.add(id);
      for (const dep of graph.get(id) ?? []) if (dfs(dep)) return true;
      visiting.delete(id);
      return false;
    };
    for (const id of graph.keys()) if (dfs(id)) return true;
    return false;
  })();

  const save = async () => {
    setBusy(true);
    try {
      await updateAiTaskNode({
        id: task.id,
        title: form.title,
        description: form.description,
        roleId: form.roleId,
        preferredAgentId: form.preferredAgentId,
        taskPrompt: form.taskPrompt,
        executionMode: form.executionMode,
        executionContext: form.executionContext,
        targetRepositoryId: form.targetRepositoryId,
        allowedWritePaths: form.allowedWritePaths,
        dependencyIds: form.dependencyIds,
        expectedArtifacts: form.expectedArtifacts,
        acceptanceCommands: form.acceptanceCommands,
        timeoutSeconds: form.timeoutSeconds,
        retryCount: form.retryCount,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("删除该任务将级联清理其 contract、attempt 运行目录、审查记录与未决决策，且引用它的依赖关系将被移除。确定删除？")) return;
    setBusy(true);
    try {
      await deleteAiTaskNode(task.id);
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-task-editor" role="dialog" aria-label="编辑任务节点">
      <h3>编辑任务 {task.title}</h3>
      <div className="ai-task-editor-grid">
        <div className="ai-task-editor-fields">
          <label>任务标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label>任务说明<textarea value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label>角色<select value={form.roleId ?? ""} onChange={(e) => setForm({ ...form, roleId: e.target.value || null })}>
            <option value="">不限定角色</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select></label>
          <label>优先 Agent<select value={form.preferredAgentId ?? ""} onChange={(e) => setForm({ ...form, preferredAgentId: e.target.value || null })}>
            <option value="">由调度器选择</option>
            {agents.filter((a) => a.enabled).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></label>
          <label>执行模式<select value={form.executionMode} onChange={(e) => setForm({ ...form, executionMode: e.target.value as "write" | "readonly" })}>
            <option value="write">写入</option><option value="readonly">只读</option>
          </select></label>
          <label>执行目录<select value={form.executionContext ?? ""} onChange={(e) => setForm({ ...form, executionContext: e.target.value as "workspaceRoot" | "taskWorktree" })}>
            <option value="workspaceRoot">项目工作区根目录</option><option value="taskWorktree">任务 worktree</option>
          </select></label>
          <label>目标仓库<select value={form.targetRepositoryId} onChange={(e) => setForm({ ...form, targetRepositoryId: e.target.value })}>
            <option value="">选择允许写入的仓库</option>
            {project.repositories.filter((r) => r.writeEnabled).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select></label>
          <label>允许写入路径<textarea value={form.allowedWritePaths.join("\n")} onChange={(e) => setForm({ ...form, allowedWritePaths: e.target.value.split(/\n|,/) })} /></label>
          <fieldset className="ai-task-dependencies">
            <legend>前置任务（依赖循环时红框警告）</legend>
            <div className={hasCycle ? "ai-dependency-cycle" : ""}>
              {deliveryTasks.filter((t) => t.id !== task.id).map((t) => (
                <label key={t.id}><input type="checkbox" checked={form.dependencyIds.includes(t.id)}
                  onChange={(e) => setForm({ ...form, dependencyIds: e.target.checked ? [...form.dependencyIds, t.id] : form.dependencyIds.filter((id) => id !== t.id) })} />{t.title}</label>
              ))}
            </div>
            {hasCycle && <span className="ai-field-error">依赖关系形成环，无法保存</span>}
          </fieldset>
          <label>预期成果<textarea value={form.expectedArtifacts.join("\n")} onChange={(e) => setForm({ ...form, expectedArtifacts: e.target.value.split(/\n|,/) })} /></label>
          <label>验收命令<textarea value={form.acceptanceCommands.join("\n")} onChange={(e) => setForm({ ...form, acceptanceCommands: e.target.value.split(/\n/) })} /></label>
          <label>超时时间（分钟）
            <input type="number" min="5" max="480" value={form.timeoutSeconds ? String(Math.round(form.timeoutSeconds / 60)) : ""}
              onChange={(e) => setForm({ ...form, timeoutSeconds: e.target.value ? Number(e.target.value) * 60 : null })} /></label>
          <label>最大重试次数（0 = 不限，允许超过 10）
            <input type="number" min="0" max="50" value={form.retryCount} onChange={(e) => setForm({ ...form, retryCount: Number(e.target.value) })} /></label>
          <label>给 Agent 的任务说明
            <Editor height="180px" defaultLanguage="markdown" value={form.taskPrompt}
              onChange={(v) => setForm({ ...form, taskPrompt: v ?? "" })} /></label>
          {error && <div className="ai-field-error">{error}</div>}
          <div className="ai-task-editor-actions">
            <button className="btn-primary" disabled={busy || hasCycle || !form.title} onClick={save}>保存</button>
            <button className="btn-danger" disabled={busy} onClick={remove}>删除此任务</button>
            <button className="btn-secondary" onClick={onClose}>取消</button>
          </div>
        </div>
        <div className="ai-task-editor-preview">
          <h4>实时预览</h4>
          <p><strong>标题：</strong>{form.title || "（空）"}</p>
          <p><strong>执行模式：</strong>{form.executionMode === "write" ? "写入" : "只读"}</p>
          <p><strong>执行目录：</strong>{form.executionContext === "taskWorktree" ? "任务 worktree" : "项目工作区根目录"}</p>
          <p><strong>目标仓库：</strong>{project.repositories.find((r) => r.id === form.targetRepositoryId)?.name ?? "（未选择）"}</p>
          <p><strong>前置任务：</strong>{form.dependencyIds.length === 0 ? "无" : form.dependencyIds.map((id) => deliveryTasks.find((t) => t.id === id)?.title ?? id).join("、")}</p>
          <p><strong>超时：</strong>{form.timeoutSeconds ? `${Math.round(form.timeoutSeconds / 60)} 分钟` : "Agent 默认"}</p>
          <p><strong>重试：</strong>{form.retryCount === 0 ? "不限" : `${form.retryCount} 次`}</p>
        </div>
      </div>
    </div>
  );
}
