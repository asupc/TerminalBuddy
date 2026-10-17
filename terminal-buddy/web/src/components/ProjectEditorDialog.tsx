import { useState } from 'react';
import type { Profile, Project } from '../types';
import { saveProject } from '../utils/projects';
import { Dialog } from './Dialog';
import { ServerPathPicker } from './ServerPathPicker';

export function ProjectEditorDialog({
  original,
  defaultName,
  projects,
  profiles,
  windows,
  onClose,
  onSaved,
}: {
  original: Project | null;
  defaultName?: string;
  projects: Project[];
  profiles: Profile[];
  windows: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(original?.name || defaultName || '');
  const [path, setPath] = useState(original?.path || '');
  const [command, setCommand] = useState(original?.startupCommand || '');
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    const project = { name: name.trim(), path: path.trim(), startupCommand: command.trim() };
    if (!project.name || !(windows ? /^(?:[a-z]:[\\/]|\\\\)/i : /^\//).test(project.path)) {
      setError('请输入项目名称和服务器绝对路径');
      return;
    }
    if (
      projects.some(
        (p) => p.name.toLowerCase() === project.name.toLowerCase() && p.name !== original?.name,
      )
    ) {
      setError('项目名称已存在');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveProject(project, original, projects, profiles, windows);
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await onSaved().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        title={original ? '编辑项目' : '添加项目'}
        className="project-editor-dialog"
        onClose={() => {
          if (!busy) onClose();
        }}
        footer={
          <>
            <button className="btn" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button
              className="btn primary"
              disabled={busy}
              type="submit"
              form="mobile-project-form"
            >
              {busy ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <form
          id="mobile-project-form"
          className="project-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy}>
            <label>
              项目名称 *<input required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              项目路径 *
              <div className="project-input-action">
                <input
                  required
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder={windows ? 'C:\\Projects\\MyProject' : '/workspace/my-project'}
                />
                <button type="button" className="btn" onClick={() => setBrowsing(true)}>
                  浏览
                </button>
              </div>
            </label>
            <label>
              启动命令
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="例如 claude 或 npm run dev"
              />
            </label>
            <small>在项目目录执行；留空仅打开终端。启动参数会按此命令匹配。</small>
          </fieldset>
          {error && (
            <div className="nav-error" role="alert">
              {error}
            </div>
          )}
        </form>
      </Dialog>
      {browsing && (
        <ServerPathPicker
          projects={projects}
          initialPath={path}
          onClose={() => setBrowsing(false)}
          onPick={(value) => {
            setPath(value);
            setBrowsing(false);
          }}
        />
      )}
    </>
  );
}
