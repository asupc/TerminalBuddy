import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createClaudeAsset,
  deleteClaudeAsset,
  deployClaudeAsset,
  importClaudeAsset,
  listClaudeAssets,
  listClaudeProjects,
  listImportableClaudeAssets,
  readClaudeAsset,
  syncClaudeAsset,
  undeployClaudeAsset,
  writeClaudeAsset,
  type AssetScope,
  type ClaudeAssetEntry,
  type ClaudeAssetKind,
  type ClaudeProjectInfo,
  type ImportableClaudeAsset,
} from '../../../services/tauri';
import { useAppStore } from '../../../stores/appStore';
import { useClaudeProjectScope } from '../../../hooks/useClaudeProjectScope';
import { ConfirmDialog, Dialog } from '../../shared/Dialog';

const KIND_TABS: Array<{ kind: ClaudeAssetKind; label: string; noun: string }> = [
  { kind: 'skills', label: '技能', noun: '技能' },
  { kind: 'agents', label: '子代理', noun: '子代理' },
  { kind: 'commands', label: '命令', noun: '命令' },
];

function scopeLabel(scope: AssetScope, projectDir: string | null, projects: ClaudeProjectInfo[]): string {
  if (scope === 'user') return '用户级';
  const hit = projects.find(project => project.dir === projectDir);
  return hit ? hit.label : (projectDir ?? '项目');
}

/** 技能 / 子代理 / 命令管理器：资产库 + 部署模型（库为唯一编辑处，启用=复制到目标）。 */
export const AssetsSegment: FC = () => {
  const showToast = useAppStore(s => s.showToast);
  // 激活的是 claude 终端时，部署状态只看该项目
  const scopeDir = useClaudeProjectScope();
  const [kind, setKind] = useState<ClaudeAssetKind>('skills');
  const [assets, setAssets] = useState<ClaudeAssetEntry[]>([]);
  const [projects, setProjects] = useState<ClaudeProjectInfo[]>([]);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [deployTarget, setDeployTarget] = useState<ClaudeAssetEntry | null>(null);
  const [deployChoice, setDeployChoice] = useState<{ scope: AssetScope; projectDir: string }>({ scope: 'user', projectDir: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editDirty, setEditDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '' });
  const [importing, setImporting] = useState(false);
  const [importSource, setImportSource] = useState<{ scope: AssetScope; projectDir: string }>({ scope: 'user', projectDir: '' });
  // 导入来源切换的请求序号（审查 M-19）：快来源的响应晚到会覆盖新来源的
  // 列表，勾选项与实际导入来源错位。
  const importRequestSeq = useRef(0);
  const [importable, setImportable] = useState<ImportableClaudeAsset[]>([]);
  const [importChecked, setImportChecked] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<ClaudeAssetEntry | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // 激活的是 claude 终端时只看该项目下的部署情况（用户级部署始终在列）
      setAssets(await listClaudeAssets(scopeDir));
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      setBusy(false);
    }
  }, [scopeDir, showToast]);

  useEffect(() => {
    void load();
    listClaudeProjects().then(setProjects).catch(() => setProjects([]));
  }, [load]);

  const kindAssets = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    return assets.filter(asset =>
      asset.kind === kind
      && (!keyword
        || asset.name.toLowerCase().includes(keyword)
        || (asset.description ?? '').toLowerCase().includes(keyword)));
  }, [assets, kind, filter]);

  const toggleExpand = (name: string) => {
    setExpanded(prev => (prev === name ? null : name));
  };

  const runAction = async (action: () => Promise<void>, successText: string) => {
    try {
      await action();
      showToast(successText, 'success');
      await load();
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const openEditor = async (name: string) => {
    try {
      setEditContent(await readClaudeAsset(kind, name));
      setEditDirty(false);
      setEditing(name);
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const saveEditor = async () => {
    if (!editing) return;
    try {
      await writeClaudeAsset(kind, editing, editContent);
      setEditDirty(false);
      showToast('已保存到资产库', 'success');
      await load();
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const create = async () => {
    try {
      await createClaudeAsset(kind, createForm.name, createForm.description || '（未填写描述）');
      setCreating(false);
      setCreateForm({ name: '', description: '' });
      showToast('已创建（模板已生成，可点行展开编辑内容）', 'success');
      await load();
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const loadImportable = async (source: { scope: AssetScope; projectDir: string }) => {
    const seq = ++importRequestSeq.current;
    try {
      const list = await listImportableClaudeAssets(source.scope, source.scope === 'project' ? source.projectDir : undefined);
      if (seq !== importRequestSeq.current) return; // 已切换到其他来源，丢弃过时响应
      setImportable(list.filter(item => item.kind === kind));
      setImportChecked(new Set());
    } catch (error) {
      if (seq !== importRequestSeq.current) return;
      setImportable([]);
      showToast(String(error), 'error');
    }
  };

  const doImport = async () => {
    const picked = importable.filter(item => importChecked.has(`${item.kind}/${item.name}`));
    if (picked.length === 0) return;
    setBusy(true);
    let failed = 0;
    for (const item of picked) {
      try {
        await importClaudeAsset(
          item.kind,
          importSource.scope,
          importSource.scope === 'project' ? importSource.projectDir : undefined,
          item.name,
        );
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    setImporting(false);
    showToast(failed === 0 ? `已收编 ${picked.length} 项到资产库` : `收编完成，${failed} 项失败`, failed === 0 ? 'success' : 'error');
    await load();
  };

  const currentNoun = KIND_TABS.find(tab => tab.kind === kind)?.noun ?? '资产';
  const importableCount = importable.filter(item => importChecked.has(`${item.kind}/${item.name}`)).length;

  return (
    <div className="claude-segment assets-segment">
      <div className="claude-segment-toolbar">
        <div className="claude-segment-seg">
          {KIND_TABS.map(tab => (
            <button key={tab.kind} type="button" className={kind === tab.kind ? 'on' : ''} onClick={() => { setKind(tab.kind); setExpanded(null); }}>
              {tab.label}
            </button>
          ))}
        </div>
        <span className="claude-segment-actions">
          <button type="button" className="claude-segment-btn" onClick={() => setImporting(true)}>导入</button>
          <button type="button" className="claude-segment-btn" onClick={() => setCreating(true)}>新建</button>
          <button type="button" className="claude-segment-btn" disabled={busy} onClick={() => void load()}>↻</button>
        </span>
      </div>
      <input
        className="claude-segment-filter"
        value={filter}
        placeholder={`过滤${currentNoun}…`}
        onChange={e => setFilter(e.target.value)}
      />

      {kindAssets.length === 0 && (
        <div className="claude-segment-empty">
          资产库还是空的
          <small>「新建」在库里创建模板，或「导入」收编 ~/.claude 下已有的{currentNoun}</small>
        </div>
      )}

      <div className="assets-list">
        {kindAssets.map(asset => {
          const isExpanded = expanded === asset.name;
          const hasDrift = asset.deployments.some(dep => dep.drifted);
          return (
            <div key={asset.name} className={`assets-item${isExpanded ? ' expanded' : ''}`}>
              <div className="assets-item-head" onClick={() => toggleExpand(asset.name)}>
                <span className="assets-item-caret">{isExpanded ? '▾' : '▸'}</span>
                <span className="assets-item-name">{asset.name}</span>
                {hasDrift && <span className="assets-drift-mark" title="部署目标内容与库不一致">⚠</span>}
                {asset.deployments.map((dep, index) => (
                  <span key={`${dep.scope}-${dep.projectDir ?? ''}-${index}`} className="assets-scope-badge">
                    {dep.scope === 'user' ? '用户' : '项目'}
                  </span>
                ))}
              </div>
              {isExpanded && (
                <div className="assets-item-body">
                  {asset.description && <div className="assets-item-desc">{asset.description}</div>}
                  <div className="assets-deploy-list">
                    {asset.deployments.length === 0 && <div className="assets-deploy-empty">尚未部署（不生效）</div>}
                    {asset.deployments.map((dep, index) => (
                      <div key={`${dep.scope}-${dep.projectDir ?? ''}-${index}`} className="assets-deploy-row">
                        <span className="assets-deploy-target" title={dep.projectDir ?? '~/.claude'}>
                          {scopeLabel(dep.scope, dep.projectDir, projects)}
                        </span>
                        {dep.drifted && <span className="assets-drift-mark" title="目标内容已偏离库版本">已偏离</span>}
                        <span className="claude-segment-actions">
                          {dep.drifted && (
                            <>
                              <button
                                type="button"
                                className="claude-segment-btn mini"
                                title="用库版本覆盖部署目标"
                                onClick={() => void runAction(
                                  () => syncClaudeAsset(kind, asset.name, 'overwrite', dep.scope, dep.projectDir ?? undefined),
                                  '已用库版本覆盖目标',
                                )}
                              >覆盖</button>
                              <button
                                type="button"
                                className="claude-segment-btn mini"
                                title="把目标处的改动收回到资产库"
                                onClick={() => void runAction(
                                  () => syncClaudeAsset(kind, asset.name, 'pull_back', dep.scope, dep.projectDir ?? undefined),
                                  '已把目标改动收回库',
                                )}
                              >回库</button>
                            </>
                          )}
                          <button
                            type="button"
                            className="claude-segment-btn mini"
                            title="从目标移除（备份到回收目录）"
                            onClick={() => void runAction(
                              () => undeployClaudeAsset(kind, asset.name, dep.scope, dep.projectDir ?? undefined),
                              '已停用（移入回收目录）',
                            )}
                          >停用</button>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="assets-item-actions">
                    <button
                      type="button"
                      className="claude-segment-btn primary"
                      onClick={() => { setDeployTarget(asset); setDeployChoice({ scope: 'user', projectDir: projects[0]?.dir ?? '' }); }}
                    >启用到…</button>
                    <button type="button" className="claude-segment-btn" onClick={() => void openEditor(asset.name)}>编辑</button>
                    <button type="button" className="claude-segment-btn danger" onClick={() => setDeleteTarget(asset)}>删除</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {deployTarget && (
        <Dialog
          title={`启用「${deployTarget.name}」到…`}
          onClose={() => setDeployTarget(null)}
          footer={(
            <>
              <button type="button" className="btn-secondary" onClick={() => setDeployTarget(null)}>取消</button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  const target = deployTarget;
                  setDeployTarget(null);
                  void runAction(
                    () => deployClaudeAsset(
                      target.kind,
                      target.name,
                      deployChoice.scope,
                      deployChoice.scope === 'project' ? deployChoice.projectDir : undefined,
                    ),
                    '已启用（复制到目标位置）',
                  );
                }}
              >启用</button>
            </>
          )}
        >
          <label className="claude-form-row radio">
            <input
              type="radio"
              checked={deployChoice.scope === 'user'}
              onChange={() => setDeployChoice({ scope: 'user', projectDir: '' })}
            />
            用户级（~/.claude，所有项目可用）
          </label>
          <div className="claude-form-group-title">或部署到项目：</div>
          {projects.map(project => (
            <label key={project.dir} className="claude-form-row radio">
              <input
                type="radio"
                checked={deployChoice.scope === 'project' && deployChoice.projectDir === project.dir}
                onChange={() => setDeployChoice({ scope: 'project', projectDir: project.dir })}
              />
              {project.label}
            </label>
          ))}
          {projects.length === 0 && <div className="claude-segment-empty">（没有发现过 Claude 会话的项目）</div>}
        </Dialog>
      )}

      {editing && (
        <Dialog
          title={`编辑${currentNoun} · ${editing}`}
          onClose={() => setEditing(null)}
          className="assets-edit-dialog"
          footer={(
            <>
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>关闭</button>
              <button type="button" className="btn-primary" disabled={!editDirty} onClick={() => void saveEditor()}>保存</button>
            </>
          )}
        >
          <textarea
            className="assets-editor"
            value={editContent}
            spellCheck={false}
            onChange={e => { setEditContent(e.target.value); setEditDirty(true); }}
            onKeyDown={e => {
              if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void saveEditor();
              }
            }}
          />
        </Dialog>
      )}

      {creating && (
        <Dialog
          title={`新建${currentNoun}`}
          onClose={() => setCreating(false)}
          footer={(
            <>
              <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>取消</button>
              <button type="button" className="btn-primary" onClick={() => void create()}>创建</button>
            </>
          )}
        >
          <label className="claude-form-row">名称
            <input value={createForm.name} onChange={e => setCreateForm({ ...createForm, name: e.target.value })} placeholder="如：commit-helper" />
          </label>
          <label className="claude-form-row">描述
            <input value={createForm.description} onChange={e => setCreateForm({ ...createForm, description: e.target.value })} placeholder="一句话说明用途" />
          </label>
        </Dialog>
      )}

      {importing && (
        <Dialog
          title={`导入${currentNoun}到资产库`}
          onClose={() => setImporting(false)}
          footer={(
            <>
              <button type="button" className="btn-secondary" onClick={() => setImporting(false)}>取消</button>
              <button type="button" className="btn-primary" disabled={importableCount === 0 || busy} onClick={() => void doImport()}>
                导入所选（{importableCount}）
              </button>
            </>
          )}
        >
          <div className="claude-form-group-title">从哪里收编：</div>
          <label className="claude-form-row radio">
            <input
              type="radio"
              checked={importSource.scope === 'user'}
              onChange={() => { const next = { scope: 'user' as AssetScope, projectDir: '' }; setImportSource(next); void loadImportable(next); }}
            />
            用户级（~/.claude）
          </label>
          <div className="claude-form-group-title">或从项目目录：</div>
          {projects.map(project => (
            <label key={project.dir} className="claude-form-row radio">
              <input
                type="radio"
                checked={importSource.scope === 'project' && importSource.projectDir === project.dir}
                onChange={() => { const next = { scope: 'project' as AssetScope, projectDir: project.dir }; setImportSource(next); void loadImportable(next); }}
              />
              {project.label}
            </label>
          ))}
          {projects.length === 0 && <div className="claude-segment-empty">（没有发现过 Claude 会话的项目）</div>}
          <div className="importable-list">
            {importable.length === 0
              ? <div className="assets-deploy-empty">该位置没有可收编的{currentNoun}（已在库中的不再列出）</div>
              : importable.map(item => {
                const key = `${item.kind}/${item.name}`;
                const checked = importChecked.has(key);
                return (
                  <label key={key} className="claude-form-row radio">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setImportChecked(prev => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })}
                    />
                    <span className="importable-name">{item.name}</span>
                    {item.description && <span className="importable-desc">{item.description}</span>}
                  </label>
                );
              })}
          </div>
        </Dialog>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除资产库项"
          message={`「${deleteTarget.name}」将从资产库移除（备份到回收目录）。已部署到目标的副本不受影响。确定删除吗？`}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => { const target = deleteTarget; void runAction(() => deleteClaudeAsset(target.kind, target.name), '已从资产库移除'); }}
        />
      )}
    </div>
  );
};
