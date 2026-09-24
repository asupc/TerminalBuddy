import { FC, useCallback, useEffect, useState } from 'react';
import {
  deleteClaudeMcpServer,
  getClaudeMcpConfigPath,
  listClaudeMcpServers,
  listClaudeProjects,
  openInExplorer,
  probeClaudeMcp,
  saveClaudeMcpServer,
  type AssetScope,
  type ClaudeMcpProbeStatus,
  type ClaudeMcpServerConfig,
  type ClaudeProjectInfo,
} from '../../../services/tauri';
import { useAppStore } from '../../../stores/appStore';
import { pickScopedProject, useClaudeProjectScope } from '../../../hooks/useClaudeProjectScope';
import { ConfirmDialog, Dialog } from '../../shared/Dialog';

type Transport = 'stdio' | 'sse' | 'http';

const TRANSPORT_LABEL: Record<string, string> = { stdio: 'stdio', sse: 'SSE', http: 'HTTP' };

const STATUS_CLASS: Record<string, string> = {
  connected: 'ok',
  pending: 'pending',
  failed: 'failed',
};

const STATUS_LABEL: Record<string, string> = {
  connected: '✔ 已连通',
  pending: '⏸ 待授权',
  failed: '✖ 失败',
  unknown: '· 未检测',
};

interface EditorState {
  originalName: string | null;
  name: string;
  transport: Transport;
  command: string;
  argsText: string;
  url: string;
  jsonMode: boolean;
  jsonText: string;
  raw: Record<string, unknown> | null;
}

function detailOf(server: ClaudeMcpServerConfig): string {
  if (server.command) {
    const args = server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
    return `${server.command}${args}`;
  }
  return server.url ?? '';
}

function editorFrom(server: ClaudeMcpServerConfig): EditorState {
  const transport = (server.transport === 'sse' || server.transport === 'http') ? server.transport : 'stdio';
  return {
    originalName: server.name,
    name: server.name,
    transport,
    command: server.command ?? '',
    argsText: (server.args ?? []).join('\n'),
    url: server.url ?? '',
    jsonMode: false,
    jsonText: JSON.stringify(server.raw ?? {}, null, 2),
    raw: server.raw ?? {},
  };
}

function emptyEditor(): EditorState {
  return {
    originalName: null,
    name: '',
    transport: 'stdio',
    command: 'npx',
    argsText: '-y\n@modelcontextprotocol/server-xxx',
    url: '',
    jsonMode: false,
    jsonText: '{}',
    raw: null,
  };
}

/** MCP 管理器：用户级（~/.claude.json）与项目级（.mcp.json）两级配置 + claude mcp list 连通探测。 */
export const McpSegment: FC = () => {
  const showToast = useAppStore(s => s.showToast);
  // 激活的是 claude 终端时默认看该项目的 .mcp.json（作用域下拉仍可切回用户级）
  const scopeDir = useClaudeProjectScope();
  const [scope, setScope] = useState<AssetScope>(() => (scopeDir ? 'project' : 'user'));
  const [projectDir, setProjectDir] = useState('');
  const [projects, setProjects] = useState<ClaudeProjectInfo[]>([]);
  const [servers, setServers] = useState<ClaudeMcpServerConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeMap, setProbeMap] = useState<Record<string, ClaudeMcpProbeStatus>>({});
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [copySource, setCopySource] = useState<ClaudeMcpServerConfig | null>(null);
  const [copyChoice, setCopyChoice] = useState<{ scope: AssetScope; projectDir: string }>({ scope: 'user', projectDir: '' });
  const [deleteTarget, setDeleteTarget] = useState<ClaudeMcpServerConfig | null>(null);

  useEffect(() => {
    listClaudeProjects().then(list => {
      setProjects(list);
      const first = pickScopedProject(list, scopeDir) ?? list[0];
      if (first) setProjectDir(first.dir);
    }).catch(() => setProjects([]));
  }, [scopeDir]);

  const activeProjectDir = scope === 'project' ? projectDir : undefined;

  const load = useCallback(async () => {
    if (scope === 'project' && !projectDir) {
      setServers([]);
      return;
    }
    setLoading(true);
    try {
      setServers(await listClaudeMcpServers(scope, activeProjectDir));
    } catch (error) {
      setServers([]);
      showToast(String(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [scope, projectDir, activeProjectDir, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const probe = async () => {
    setProbing(true);
    try {
      const list = await probeClaudeMcp(60);
      const map: Record<string, ClaudeMcpProbeStatus> = {};
      for (const item of list) map[item.name] = item;
      setProbeMap(map);
      const ok = list.filter(item => item.status === 'connected').length;
      showToast(`检测完成：${ok}/${list.length} 连通`, ok === list.length ? 'success' : 'info');
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      setProbing(false);
    }
  };

  const openConfigLocation = async () => {
    try {
      const path = await getClaudeMcpConfigPath(scope, activeProjectDir);
      await openInExplorer(path);
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const buildConfig = (): Record<string, unknown> | string => {
    if (editor === null) return '编辑器未打开';
    if (editor.jsonMode) {
      try {
        const parsed = JSON.parse(editor.jsonText) as Record<string, unknown>;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'JSON 必须是对象';
        return parsed;
      } catch (error) {
        return `JSON 解析失败: ${String(error)}`;
      }
    }
    const config: Record<string, unknown> = { ...(editor.raw ?? {}) };
    config.type = editor.transport;
    if (editor.transport === 'stdio') {
      config.command = editor.command.trim();
      config.args = editor.argsText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
      delete config.url;
    } else {
      config.url = editor.url.trim();
      delete config.command;
      delete config.args;
    }
    return config;
  };

  const saveEditor = async () => {
    if (!editor) return;
    const name = editor.name.trim();
    if (!name) {
      showToast('名称不能为空', 'error');
      return;
    }
    const config = buildConfig();
    if (typeof config === 'string') {
      showToast(config, 'error');
      return;
    }
    try {
      await saveClaudeMcpServer(scope, name, config, activeProjectDir);
      setEditor(null);
      showToast('已保存', 'success');
      await load();
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const doDelete = async (server: ClaudeMcpServerConfig) => {
    try {
      await deleteClaudeMcpServer(scope, server.name, activeProjectDir);
      showToast('已删除', 'success');
      await load();
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const doCopy = async () => {
    if (!copySource) return;
    try {
      await saveClaudeMcpServer(
        copyChoice.scope,
        copySource.name,
        copySource.raw,
        copyChoice.scope === 'project' ? copyChoice.projectDir : undefined,
      );
      setCopySource(null);
      showToast('已复制到目标作用域', 'success');
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  return (
    <div className="claude-segment mcp-segment">
      <div className="claude-segment-toolbar">
        <div className="claude-segment-seg">
          <button type="button" className={scope === 'user' ? 'on' : ''} onClick={() => setScope('user')}>用户级</button>
          <button type="button" className={scope === 'project' ? 'on' : ''} onClick={() => setScope('project')}>项目级</button>
        </div>
        {scope === 'project' && (
          <select className="claude-segment-select" value={projectDir} onChange={e => setProjectDir(e.target.value)}>
            {projects.length === 0 && <option value="">（未发现项目）</option>}
            {projects.map(project => <option key={project.dir} value={project.dir}>{project.label}</option>)}
          </select>
        )}
      </div>
      <div className="claude-segment-toolbar">
        <button type="button" className="claude-segment-btn" disabled={probing} onClick={() => void probe()}>
          {probing ? '检测中…' : '⟳ 检测连通'}
        </button>
        <span className="claude-segment-actions">
          <button type="button" className="claude-segment-btn" onClick={() => setEditor(emptyEditor())}>＋ 新增</button>
          <button type="button" className="claude-segment-btn" title="打开配置文件位置" onClick={() => void openConfigLocation()}>📂</button>
          <button type="button" className="claude-segment-btn" disabled={loading} onClick={() => void load()}>↻</button>
        </span>
      </div>

      {servers.length === 0 && !loading && (
        <div className="claude-segment-empty">
          {scope === 'user' ? '用户级还没有配置 MCP 服务器' : '该项目还没有 .mcp.json'}
          <small>「＋ 新增」添加；项目级配置随仓库共享给团队</small>
        </div>
      )}

      <div className="mcp-list">
        {servers.map(server => {
          const status = probeMap[server.name];
          const statusKey = status?.status ?? 'unknown';
          return (
            <div key={server.name} className="mcp-item">
              <div className="mcp-item-head">
                <span className={`mcp-status ${STATUS_CLASS[statusKey] ?? ''}`} title={status?.detail ?? ''}>
                  {STATUS_LABEL[statusKey]}
                </span>
                <span className="mcp-item-name" title={server.name}>{server.name}</span>
                <span className="mcp-transport-badge">{TRANSPORT_LABEL[server.transport] ?? server.transport}</span>
              </div>
              <div className="mcp-item-detail" title={detailOf(server)}>{detailOf(server)}</div>
              <div className="mcp-item-actions">
                <button type="button" className="claude-segment-btn mini" onClick={() => setEditor(editorFrom(server))}>编辑</button>
                <button
                  type="button"
                  className="claude-segment-btn mini"
                  onClick={() => { setCopySource(server); setCopyChoice({ scope: scope === 'user' ? 'project' : 'user', projectDir: projects[0]?.dir ?? '' }); }}
                >复制到…</button>
                <button type="button" className="claude-segment-btn mini danger" onClick={() => setDeleteTarget(server)}>删除</button>
              </div>
            </div>
          );
        })}
      </div>

      {editor && (
        <Dialog
          title={editor.originalName ? `编辑 MCP · ${editor.originalName}` : '新增 MCP 服务器'}
          onClose={() => setEditor(null)}
          className="mcp-edit-dialog"
          footer={(
            <>
              <button type="button" className="btn-secondary" onClick={() => setEditor(null)}>取消</button>
              <button type="button" className="btn-primary" onClick={() => void saveEditor()}>保存</button>
            </>
          )}
        >
          <label className="claude-form-row">名称
            <input
              value={editor.name}
              disabled={editor.originalName !== null}
              onChange={e => setEditor({ ...editor, name: e.target.value })}
              placeholder="如：dbhub"
            />
          </label>
          <label className="claude-form-row checkbox">
            <input
              type="checkbox"
              checked={editor.jsonMode}
              onChange={e => setEditor({ ...editor, jsonMode: e.target.checked })}
            />
            高级模式（直接编辑 JSON，可配 env / headers 等扩展字段）
          </label>
          {editor.jsonMode ? (
            <textarea
              className="mcp-json-editor"
              value={editor.jsonText}
              spellCheck={false}
              onChange={e => setEditor({ ...editor, jsonText: e.target.value })}
            />
          ) : (
            <>
              <div className="claude-segment-seg">
                {(['stdio', 'sse', 'http'] as Transport[]).map(transport => (
                  <button
                    key={transport}
                    type="button"
                    className={editor.transport === transport ? 'on' : ''}
                    onClick={() => setEditor({ ...editor, transport })}
                  >
                    {TRANSPORT_LABEL[transport]}
                  </button>
                ))}
              </div>
              {editor.transport === 'stdio' ? (
                <>
                  <label className="claude-form-row">命令
                    <input value={editor.command} onChange={e => setEditor({ ...editor, command: e.target.value })} placeholder="npx" />
                  </label>
                  <label className="claude-form-row">参数（每行一个）
                    <textarea
                      className="mcp-args-editor"
                      value={editor.argsText}
                      spellCheck={false}
                      onChange={e => setEditor({ ...editor, argsText: e.target.value })}
                    />
                  </label>
                </>
              ) : (
                <label className="claude-form-row">URL
                  <input value={editor.url} onChange={e => setEditor({ ...editor, url: e.target.value })} placeholder="https://…" />
                </label>
              )}
            </>
          )}
        </Dialog>
      )}

      {copySource && (
        <Dialog
          title={`复制「${copySource.name}」到…`}
          onClose={() => setCopySource(null)}
          footer={(
            <>
              <button type="button" className="btn-secondary" onClick={() => setCopySource(null)}>取消</button>
              <button type="button" className="btn-primary" onClick={() => void doCopy()}>复制</button>
            </>
          )}
        >
          {scope !== 'user' && (
            <label className="claude-form-row radio">
              <input type="radio" checked={copyChoice.scope === 'user'} onChange={() => setCopyChoice({ scope: 'user', projectDir: '' })} />
              用户级（~/.claude.json）
            </label>
          )}
          {scope !== 'project' && (
            <>
              <div className="claude-form-group-title">或复制到项目：</div>
              {projects.map(project => (
                <label key={project.dir} className="claude-form-row radio">
                  <input
                    type="radio"
                    checked={copyChoice.scope === 'project' && copyChoice.projectDir === project.dir}
                    onChange={() => setCopyChoice({ scope: 'project', projectDir: project.dir })}
                  />
                  {project.label}
                </label>
              ))}
              {projects.length === 0 && <div className="claude-segment-empty">（没有发现过 Claude 会话的项目）</div>}
            </>
          )}
        </Dialog>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除 MCP 服务器"
          message={`确定从${scope === 'user' ? '用户级配置' : '项目 .mcp.json'}中删除「${deleteTarget.name}」吗？`}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => { void doDelete(deleteTarget); }}
        />
      )}
    </div>
  );
};
