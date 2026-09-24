import { FC, useCallback, useEffect, useState } from 'react';
import { listClaudeProjects, readClaudeMd, writeClaudeMd, type ClaudeProjectInfo } from '../../../services/tauri';
import { useAppStore } from '../../../stores/appStore';
import { pickScopedProject, useClaudeProjectScope } from '../../../hooks/useClaudeProjectScope';

const SNIPPETS: Array<{ label: string; content: string }> = [
  {
    label: '沟通规范',
    content: '\n## 沟通规范\n\n- 与用户交流一律使用中文，代码注释同理；报错与命令输出保留原文。\n- 不确定时先问再动，不要擅自扩大改动范围。\n',
  },
  {
    label: '编码规范',
    content: '\n## 编码规范\n\n- 优先复用现有模式，不引入新依赖，除非明确要求。\n- 所有 Rust↔TS 序列化使用 camelCase。\n- 改动保持最小：只动与需求直接相关的代码。\n',
  },
  {
    label: '提交规范',
    content: '\n## 提交规范\n\n- commit message 用中文，格式：[模块] 变更描述。\n- 不执行 git push，除非明确要求。\n',
  },
  {
    label: '测试要求',
    content: '\n## 测试要求\n\n- 纯逻辑（解析/校验/权限）放进带 #[cfg(test)] 的可测模块。\n- 改动后运行 cargo test --lib 与 npx tsc --noEmit 再交付。\n',
  },
];

/** CLAUDE.md 管理器：全局 / 项目两级编辑 + 片段模板插入。 */
export const ClaudeMdSegment: FC = () => {
  const showToast = useAppStore(s => s.showToast);
  // 激活的是 claude 终端时默认编辑该项目的 CLAUDE.md（仍可手动切回全局）
  const scopeDir = useClaudeProjectScope();
  const [kind, setKind] = useState<'global' | 'project'>(() => (scopeDir ? 'project' : 'global'));
  const [projects, setProjects] = useState<ClaudeProjectInfo[]>([]);
  const [projectDir, setProjectDir] = useState('');
  const [content, setContent] = useState('');
  const [exists, setExists] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listClaudeProjects().then(list => {
      setProjects(list);
      const first = pickScopedProject(list, scopeDir) ?? list.find(item => item.hasClaudeMd) ?? list[0];
      if (first) setProjectDir(first.dir);
    }).catch(error => showToast(`加载项目列表失败: ${String(error)}`, 'error'));
  }, [scopeDir, showToast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const target = kind === 'global' ? '' : projectDir;
      if (kind === 'project' && !target) {
        setContent('');
        setExists(false);
        setDirty(false);
        return;
      }
      const text = await readClaudeMd(kind, target);
      setContent(text ?? '');
      setExists(text !== null);
      setDirty(false);
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [kind, projectDir, showToast]);

  useEffect(() => {
    if (kind === 'global' || projectDir) void load();
  }, [kind, projectDir, load]);

  const save = useCallback(async () => {
    try {
      await writeClaudeMd(kind, kind === 'global' ? '' : projectDir, content);
      setDirty(false);
      setExists(true);
      showToast('已保存', 'success');
    } catch (error) {
      showToast(String(error), 'error');
    }
  }, [kind, projectDir, content, showToast]);

  const insertSnippet = (snippet: string) => {
    setContent(prev => prev + snippet);
    setDirty(true);
  };

  return (
    <div className="claude-segment claudemd-segment">
      <div className="claude-segment-toolbar">
        <div className="claude-segment-seg">
          <button type="button" className={kind === 'global' ? 'on' : ''} onClick={() => setKind('global')}>全局</button>
          <button type="button" className={kind === 'project' ? 'on' : ''} onClick={() => setKind('project')}>项目</button>
        </div>
        {kind === 'project' && (
          <select
            className="claude-segment-select"
            value={projectDir}
            onChange={e => setProjectDir(e.target.value)}
          >
            {projects.length === 0 && <option value="">（未发现项目）</option>}
            {projects.map(project => (
              <option key={project.dir} value={project.dir}>
                {project.hasClaudeMd ? '📝 ' : ''}{project.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="claude-segment-toolbar">
        <select
          className="claude-segment-select"
          value=""
          onChange={e => {
            const snippet = SNIPPETS.find(item => item.label === e.target.value);
            if (snippet) insertSnippet(snippet.content);
          }}
        >
          <option value="">插入片段…</option>
          {SNIPPETS.map(snippet => <option key={snippet.label} value={snippet.label}>{snippet.label}</option>)}
        </select>
        <span className="claude-segment-note">
          {loading ? '加载中…' : exists ? (dirty ? '● 未保存' : '') : '（尚未创建，保存后新建）'}
        </span>
        <button type="button" className="claude-segment-btn primary" disabled={!dirty} onClick={() => void save()}>保存</button>
      </div>
      <textarea
        className="claudemd-editor"
        value={content}
        spellCheck={false}
        placeholder="# CLAUDE.md"
        onChange={e => { setContent(e.target.value); setDirty(true); }}
        onKeyDown={e => {
          if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="claude-segment-note foot">
        ⓘ 项目 CLAUDE.md 与全局叠加生效，同名指令项目优先
      </div>
    </div>
  );
};
