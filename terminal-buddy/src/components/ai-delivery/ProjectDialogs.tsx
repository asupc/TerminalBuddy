import {
  Check,
  FolderGit2,
  FolderOpen,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import type React from "react";
import { Dialog } from "../shared/Dialog";
import { displayLocalPath } from "./workspace-utils";
import type { AiProject, AiRepository } from "../../types/aiDelivery";

// ===== 项目概览对话框 =====
interface ProjectOverviewDialogProps {
  project: AiProject;
  onClose: () => void;
}

export function ProjectOverviewDialog({ project, onClose }: ProjectOverviewDialogProps) {
  return (
    <Dialog
      title={"项目概览 · " + project.name}
      ariaLabel="项目概览"
      className="ai-project-overview-dialog"
      bodyClassName="ai-project-overview-body"
      onClose={() => onClose()}
      footer={
        <button type="button" className="btn-primary" onClick={() => onClose()}>
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
  );
}

// ===== 项目设置对话框 =====
interface ProjectSettingsDialogProps {
  project: AiProject;
  busy: string | null;
  editProjectName: string;
  setEditProjectName: (value: string) => void;
  editProjectMaxConcurrency: string;
  setEditProjectMaxConcurrency: (value: string) => void;
  editProjectQualityCommands: string;
  setEditProjectQualityCommands: (value: string) => void;
  editProjectRepositories: AiRepository[];
  setEditProjectRepositories: React.Dispatch<React.SetStateAction<AiRepository[]>>;
  onClose: () => void;
  onSubmit: () => void;
  onRegenerateQualityGate: () => void;
  onRefreshRepositories: () => void;
  onRemoveProject: () => void;
}

export function ProjectSettingsDialog({
  project, busy, editProjectName, setEditProjectName,
  editProjectMaxConcurrency, setEditProjectMaxConcurrency,
  editProjectQualityCommands, setEditProjectQualityCommands,
  editProjectRepositories, setEditProjectRepositories,
  onClose, onSubmit, onRegenerateQualityGate, onRefreshRepositories, onRemoveProject,
}: ProjectSettingsDialogProps) {
  return (
    <Dialog
      title="项目设置"
      ariaLabel="AI 交付项目设置"
      className="ai-project-settings-dialog"
      bodyClassName="ai-project-settings-body"
      onClose={() => onClose()}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      footer={
        <>
          <button type="button" className="btn-danger" disabled={busy === "delete-project"} onClick={() => onRemoveProject()}>
            <Trash2 size={15} />
            删除项目
          </button>
          <button type="button" className="btn-secondary" onClick={() => onClose()}>
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
            onClick={() => onRegenerateQualityGate()}
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
          <button type="button" className="btn-secondary" disabled={busy === "refresh-project-repositories"} onClick={() => onRefreshRepositories()}>
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
  );
}

// ===== 新建项目对话框 =====
interface ProjectFormDialogProps {
  busy: string | null;
  projectName: string;
  setProjectName: (value: string) => void;
  workspaceRoot: string;
  setWorkspaceRoot: (value: string) => void;
  qualityCommands: string;
  setQualityCommands: (value: string) => void;
  onClose: () => void;
  onCreate: () => void;
  onBrowseWorkspaceRoot: () => void;
  onGenerateQualityGate: () => void;
}

export function ProjectFormDialog({
  busy, projectName, setProjectName, workspaceRoot, setWorkspaceRoot,
  qualityCommands, setQualityCommands,
  onClose, onCreate, onBrowseWorkspaceRoot, onGenerateQualityGate,
}: ProjectFormDialogProps) {
  return (
    <Dialog
      title="新建交付项目"
      ariaLabel="新建交付项目"
      className="ai-project-create-dialog"
      bodyClassName="ai-project-create-body"
      onClose={() => onClose()}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={() => onClose()}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy === "project"}
            onClick={() => onCreate()}
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
            onClick={() => onBrowseWorkspaceRoot()}
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
            onClick={() => onGenerateQualityGate()}
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
  );
}