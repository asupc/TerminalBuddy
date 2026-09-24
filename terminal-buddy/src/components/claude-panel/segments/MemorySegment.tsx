import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import {
  createClaudeMemoryFile,
  deleteClaudeMemoryFile,
  listClaudeMemoryFiles,
  listClaudeProjects,
  readClaudeMemoryFile,
  writeClaudeMemoryFile,
  type ClaudeMemoryFile,
  type ClaudeProjectInfo,
} from '../../../services/tauri';
import { useAppStore } from '../../../stores/appStore';
import { pickScopedProject, useClaudeProjectScope } from '../../../hooks/useClaudeProjectScope';
import { ConfirmDialog, Dialog } from '../../shared/Dialog';

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];

/** Memory 浏览器：项目选择 + 文件列表 + 查看/编辑 + [[链接]] 跳转。 */
export const MemorySegment: FC = () => {
  const showToast = useAppStore(s => s.showToast);
  // 激活的是 claude 终端时，默认选中它所在的项目（下拉仍可切走）
  const scopeDir = useClaudeProjectScope();
  const [projects, setProjects] = useState<ClaudeProjectInfo[]>([]);
  const [projectDir, setProjectDir] = useState('');
  const [files, setFiles] = useState<ClaudeMemoryFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', memoryType: 'project', description: '' });

  useEffect(() => {
    listClaudeProjects().then(list => {
      setProjects(list);
      const first = pickScopedProject(list, scopeDir) ?? list.find(item => item.hasMemory) ?? list[0];
      if (first) setProjectDir(first.dir);
    }).catch(error => showToast(`加载项目列表失败: ${String(error)}`, 'error'));
  }, [scopeDir, showToast]);

  const loadFiles = useCallback(async (dir: string, keepSelection?: string) => {
    setLoading(true);
    try {
      const list = await listClaudeMemoryFiles(dir);
      setFiles(list);
      const target = keepSelection && list.some(file => file.name === keepSelection)
        ? keepSelection
        : list[0]?.name ?? null;
      setSelected(target);
      setDirty(false);
      setContent(target ? await readClaudeMemoryFile(dir, target) : '');
    } catch (error) {
      setFiles([]);
      setSelected(null);
      setContent('');
      showToast(String(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (projectDir) void loadFiles(projectDir);
  }, [projectDir, loadFiles]);

  const openFile = useCallback(async (name: string) => {
    if (dirty && selected && !window.confirm('当前文件未保存，切换将丢失修改，确定吗？')) return;
    try {
      setSelected(name);
      setContent(await readClaudeMemoryFile(projectDir, name));
      setDirty(false);
    } catch (error) {
      showToast(String(error), 'error');
    }
  }, [projectDir, dirty, selected, showToast]);

  const save = useCallback(async () => {
    if (!selected) return;
    try {
      await writeClaudeMemoryFile(projectDir, selected, content);
      setDirty(false);
      showToast('已保存', 'success');
      await loadFiles(projectDir, selected);
    } catch (error) {
      showToast(String(error), 'error');
    }
  }, [projectDir, selected, content, loadFiles, showToast]);

  const create = useCallback(async () => {
    try {
      const name = await createClaudeMemoryFile(
        projectDir,
        form.name,
        form.memoryType,
        form.description || '（未填写描述）',
      );
      setCreating(false);
      setForm({ name: '', memoryType: 'project', description: '' });
      showToast('已创建', 'success');
      await loadFiles(projectDir, name);
    } catch (error) {
      showToast(String(error), 'error');
    }
  }, [projectDir, form, loadFiles, showToast]);

  const removeFile = useCallback(async (name: string) => {
    try {
      await deleteClaudeMemoryFile(projectDir, name);
      showToast('已移入回收目录', 'success');
      await loadFiles(projectDir);
    } catch (error) {
      showToast(String(error), 'error');
    }
  }, [projectDir, loadFiles, showToast]);

  const links = useMemo(() => files.find(file => file.name === selected)?.links ?? [], [files, selected]);
  const selectedFile = files.find(file => file.name === selected);
  const memoryProjects = projects.filter(item => item.hasMemory);

  const openLink = (target: string) => {
    const hit = files.find(file => file.name === target || file.name === `${target}.md`);
    if (hit) void openFile(hit.name);
    else showToast(`没有找到 [[${target}]] 对应的文件`, 'info');
  };

  return (
    <div className="claude-segment memory-segment">
      <div className="claude-segment-toolbar">
        <select
          className="claude-segment-select"
          value={projectDir}
          onChange={e => setProjectDir(e.target.value)}
        >
          {projects.length === 0 && <option value="">（未发现项目）</option>}
          {projects.map(project => (
            <option key={project.dir} value={project.dir}>
              {project.hasMemory ? '🧠 ' : ''}{project.label}
            </option>
          ))}
        </select>
        <span className="claude-segment-actions">
          <button type="button" className="claude-segment-btn" disabled={!projectDir} onClick={() => setCreating(true)}>新建</button>
          <button type="button" className="claude-segment-btn" onClick={() => projectDir && loadFiles(projectDir)}>↻</button>
        </span>
      </div>

      {projects.length > 0 && memoryProjects.length === 0 && (
        <div className="claude-segment-empty">还没有任何项目产生过 memory（Claude Code 会话产生记忆后出现）</div>
      )}
      {loading && <div className="claude-segment-empty">加载中…</div>}

      {!loading && files.length > 0 && (
        <>
          <div className="memory-file-list">
            {files.map(file => (
              <div
                key={file.name}
                className={`memory-file-item${selected === file.name ? ' active' : ''}`}
                onClick={() => void openFile(file.name)}
                title={file.description ?? file.name}
              >
                <span className="memory-file-name">{file.name}</span>
                {file.memoryType && <span className={`memory-type-badge type-${file.memoryType}`}>{file.memoryType}</span>}
                <button
                  type="button"
                  className="memory-file-delete"
                  title="删除（移入回收目录）"
                  onClick={e => { e.stopPropagation(); setDeleteTarget(file.name); }}
                >✕</button>
              </div>
            ))}
          </div>
          {links.length > 0 && (
            <div className="memory-links">
              链接：
              {links.map(link => (
                <button key={link} type="button" className="memory-link-chip" onClick={() => openLink(link)}>{link}</button>
              ))}
            </div>
          )}
          <textarea
            className="memory-editor"
            value={content}
            spellCheck={false}
            onChange={e => { setContent(e.target.value); setDirty(true); }}
            onKeyDown={e => {
              if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <div className="memory-editor-foot">
            <span className="memory-dirty">{dirty ? '● 未保存' : selectedFile ? `${selectedFile.size} 字节` : ''}</span>
            <button type="button" className="claude-segment-btn primary" disabled={!selected || !dirty} onClick={() => void save()}>
              保存
            </button>
          </div>
        </>
      )}
      {!loading && files.length === 0 && projectDir && memoryProjects.some(item => item.dir === projectDir) && (
        <div className="claude-segment-empty">该项目还没有记忆文件</div>
      )}

      {creating && (
        <Dialog
          title="新建记忆"
          onClose={() => setCreating(false)}
          className="memory-create-dialog"
          footer={(
            <>
              <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>取消</button>
              <button type="button" className="btn-primary" onClick={() => void create()}>创建</button>
            </>
          )}
        >
          <label className="claude-form-row">名称
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="如：deploy-steps" />
          </label>
          <label className="claude-form-row">类型
            <select value={form.memoryType} onChange={e => setForm({ ...form, memoryType: e.target.value })}>
              {MEMORY_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <label className="claude-form-row">描述
            <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="一句话摘要（用于召回）" />
          </label>
        </Dialog>
      )}
      {deleteTarget && (
        <ConfirmDialog
          title="删除记忆文件"
          message={`「${deleteTarget}」将移入回收目录（dataPath/Trash）。确定删除吗？`}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => { void removeFile(deleteTarget); }}
        />
      )}
    </div>
  );
};
