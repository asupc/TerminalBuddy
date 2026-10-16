import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import {
  listClaudeSettingsBackups,
  readClaudeSettings,
  restoreClaudeSettingsBackup,
  writeClaudeSettings,
  type ClaudeSettingsBackup,
} from '../../../services/tauri';
import {
  CLAUDE_SETTING_GROUPS,
  COMMON_CLAUDE_SETTING_KEYS,
  type ClaudeSettingTemplate,
} from '../../../data/claudeSettingsTemplate';
import { useAppStore } from '../../../stores/appStore';
import { ConfirmDialog, Dialog } from '../../shared/Dialog';
import { buildWriteModel, collectLeafPaths, deletePathValue, foldJsonText, getPathValue, setPathValue } from './claudeSettingsPath';
import './shared.css';
import './ClaudeSettingsSegment.css';

const ENV_BOOL_OPTIONS = ['', '1', '0', 'true', 'false'];
const ENV_BOOL_LABELS: Record<string, string> = {
  '': '未设置',
  '1': '1（开）',
  '0': '0（关）',
  'true': 'true（开）',
  'false': 'false（关）',
};
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SOURCE_LABEL: Record<string, string> = {
  'cc-switch': 'cc-switch',
  'local': '本机',
  'undoc': '未收录',
};

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function toEnvBoolOption(value: unknown): string {
  if (value === true || value === 'true' || value === '1' || value === 1) {
    return typeof value === 'boolean' ? String(value) : String(value);
  }
  if (value === false || value === 'false' || value === '0' || value === 0) {
    return typeof value === 'boolean' ? String(value) : String(value);
  }
  return '';
}

/** Claude 默认配置文件编辑器：分组表单＋JSON 双视图＋备份恢复。 */
export const ClaudeSettingsSegment: FC = () => {
  const showToast = useAppStore(s => s.showToast);
  const [content, setContent] = useState<Record<string, unknown>>({});
  const [filePath, setFilePath] = useState('');
  const [fileExists, setFileExists] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [deletedKeys, setDeletedKeys] = useState<Set<string>>(new Set());
  // 工具栏状态
  const [view, setView] = useState<'form' | 'json'>('form');
  const [pill, setPill] = useState(-1);
  const [query, setQuery] = useState('');
  const [customOnly, setCustomOnly] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // JSON 视图与校验
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [invalidKeys, setInvalidKeys] = useState<string[]>([]);
  // 自定义 env
  const [customKey, setCustomKey] = useState('');
  const [customValue, setCustomValue] = useState('');
  // 备份
  const [backups, setBackups] = useState<ClaudeSettingsBackup[]>([]);
  const [backupDialog, setBackupDialog] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ClaudeSettingsBackup | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const view = await readClaudeSettings();
      setContent(view.content ?? {});
      setFilePath(view.path);
      setFileExists(view.exists);
      setJsonText(JSON.stringify(view.content ?? {}, null, 2));
      setJsonError('');
      setDirty(false);
      setDeletedKeys(new Set());
      setInvalidKeys([]);
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const markDirty = useCallback(() => setDirty(true), []);

  const setValue = useCallback((path: string, value: unknown) => {
    setContent(current => setPathValue(current, path, value));
    setDeletedKeys(current => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    setDirty(true);
  }, []);

  const resetValue = useCallback((path: string) => {
    setContent(current => deletePathValue(current, path));
    setDeletedKeys(current => new Set(current).add(path));
    setDirty(true);
  }, []);

  // 模板键集合（未知键判定用）
  const templateKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const group of CLAUDE_SETTING_GROUPS) {
      for (const item of group.items) keys.add(item.key);
    }
    return keys;
  }, []);

  // 未知键：文件里有、模板里没有的叶子路径（permissions.* 规则与 hooks.* 除外，它们是只读保留段）。
  const unknownKeys = useMemo(() => {
    const leaves = new Set<string>();
    collectLeafPaths(content, '', leaves);
    const result: string[] = [];
    for (const leaf of leaves) {
      if (templateKeys.has(leaf)) continue;
      if (leaf === 'permissions' || leaf.startsWith('permissions.') || leaf === 'hooks' || leaf.startsWith('hooks.')) continue;
      result.push(leaf);
    }
    return result.sort();
  }, [content, templateKeys]);

  const isCustomized = useCallback((path: string) => getPathValue(content, path) !== undefined, [content]);

  // 可见性过滤：分组 pills ＋ 搜索 ＋ 仅看已自定义 ＋ 收敛规则（常用/已设置默认展示）。
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CLAUDE_SETTING_GROUPS.map((group, gi) => {
      const items = group.items.filter(item => {
        if (pill >= 0 && gi !== pill) return false;
        if (customOnly && !isCustomized(item.key)) return false;
        if (q) {
          const hay = `${item.key} ${item.desc} ${item.officialDefault}`.toLowerCase();
          if (!hay.includes(q)) return false;
          return true;
        }
        // 收敛：常用键或已设置的键默认展示
        if (!showAdvanced && !COMMON_CLAUDE_SETTING_KEYS.has(item.key) && !isCustomized(item.key)) return false;
        return true;
      });
      return { ...group, gi, items };
    }).filter(group => pill < 0 ? group.items.length > 0 : true);
  }, [pill, query, customOnly, showAdvanced, isCustomized]);

  // pills 计数：当前过滤（除分组外）下每组可见数/总数
  const pillCounts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CLAUDE_SETTING_GROUPS.map(group => {
      const visible = group.items.filter(item => {
        if (customOnly && !isCustomized(item.key)) return false;
        if (q) {
          const hay = `${item.key} ${item.desc} ${item.officialDefault}`.toLowerCase();
          if (!hay.includes(q)) return false;
        } else if (!showAdvanced && !COMMON_CLAUDE_SETTING_KEYS.has(item.key) && !isCustomized(item.key)) {
          return false;
        }
        return true;
      }).length;
      return { visible, total: group.items.length };
    });
  }, [query, customOnly, showAdvanced, isCustomized]);

  // 每组收起的不常用数（组标题标注用）
  const collapsedCounts = useMemo(() => {
    if (query.trim() || showAdvanced || customOnly) return CLAUDE_SETTING_GROUPS.map(() => 0);
    return CLAUDE_SETTING_GROUPS.map(group =>
      group.items.filter(item => !COMMON_CLAUDE_SETTING_KEYS.has(item.key) && !isCustomized(item.key)).length);
  }, [query, showAdvanced, customOnly, isCustomized]);

  // 切视图时双向折叠：表单 ↔ JSON 的编辑互不丢失。
  // JSON → 表单解析失败时拒绝切换（而非静默切走丢掉 JSON 编辑）。
  const switchView = useCallback((next: 'form' | 'json') => {
    if (next === view) return;
    if (next === 'json') {
      // 恢复默认的键显式写成 null（后端深合并删除语义），JSON 视图可见可编辑。
      setJsonText(JSON.stringify(buildWriteModel(content, deletedKeys), null, 2));
      setJsonError('');
      setView('json');
      return;
    }
    const folded = foldJsonText(jsonText, content);
    if ('error' in folded) {
      showToast(`JSON 解析失败，未切换视图：${folded.error}`, 'error');
      return;
    }
    setContent(folded.content);
    setDeletedKeys(folded.deletedKeys);
    setJsonError('');
    setView('form');
  }, [view, content, deletedKeys, jsonText, showToast]);

  const save = useCallback(async () => {
    if (invalidKeys.length > 0) {
      showToast(`有 ${invalidKeys.length} 个 JSON 格式无效：${invalidKeys.slice(0, 3).join('、')}${invalidKeys.length > 3 ? '…' : ''}，请修复后再保存`, 'error');
      return;
    }
    // 两视图统一走同一写回模型，避免切视图后保存丢掉另一边的编辑。
    let payload: Record<string, unknown>;
    if (view === 'json') {
      const folded = foldJsonText(jsonText, content);
      if ('error' in folded) {
        showToast(`JSON 解析失败，请修复后再保存`, 'error');
        return;
      }
      payload = buildWriteModel(folded.content, folded.deletedKeys);
    } else {
      payload = buildWriteModel(content, deletedKeys);
    }
    setSaving(true);
    try {
      const result = await writeClaudeSettings(payload);
      await load();
      showToast(result.backupId ? `已保存（已备份 ${result.backupId}）` : '已保存', 'success');
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      setSaving(false);
    }
  }, [invalidKeys, view, jsonText, content, deletedKeys, load, showToast]);

  const openBackups = async () => {
    try {
      setBackups(await listClaudeSettingsBackups());
      setBackupDialog(true);
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const doRestore = async (backup: ClaudeSettingsBackup) => {
    try {
      await restoreClaudeSettingsBackup(backup.id);
      setBackupDialog(false);
      setRestoreTarget(null);
      await load();
      showToast(`已从备份 ${backup.id} 恢复`, 'success');
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const addCustomEnv = () => {
    const key = customKey.trim();
    if (!key) {
      showToast('请输入环境变量名', 'error');
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      showToast('环境变量名只能包含字母、数字与下划线，且不能以数字开头', 'error');
      return;
    }
    setValue(`env.${key}`, customValue);
    setCustomKey('');
    setCustomValue('');
  };

  const reportInvalid = useCallback((path: string, invalid: boolean) => {
    setInvalidKeys(current => {
      const has = current.includes(path);
      if (invalid && !has) return [...current, path];
      if (!invalid && has) return current.filter(k => k !== path);
      return current;
    });
  }, []);

  // env.CLAUDE_CODE_EFFORT_LEVEL 优先级最高：与其他 effort 配置不一致时提示用户清理，
  // 否则普通启动的实际档位会与面板所见不符。
  const effortConflict = useMemo(() => {
    const envEffort = getPathValue(content, 'env.CLAUDE_CODE_EFFORT_LEVEL');
    if (typeof envEffort !== 'string' || !envEffort) return null;
    const others = new Set<string>();
    const topLevel = getPathValue(content, 'effortLevel');
    if (typeof topLevel === 'string' && topLevel) others.add(topLevel);
    const modelSettings = getPathValue(content, 'modelSettings');
    if (typeof modelSettings === 'object' && modelSettings !== null) {
      for (const value of Object.values(modelSettings as Record<string, unknown>)) {
        const effort = (value as Record<string, unknown> | null)?.effortLevel;
        if (typeof effort === 'string' && effort) others.add(effort);
      }
    }
    const conflicting = [...others].filter(item => item !== envEffort);
    return conflicting.length > 0 ? { envEffort, conflicting } : null;
  }, [content]);

  return (
    <div className="claude-segment claude-settings-segment">
      <div className="claude-segment-toolbar">
        <div className="claude-segment-seg">
          <button type="button" className={view === 'form' ? 'on' : ''} onClick={() => switchView('form')}>表单</button>
          <button type="button" className={view === 'json' ? 'on' : ''} onClick={() => switchView('json')}>JSON</button>
        </div>
        <span className="claude-segment-actions">
          <button type="button" className="claude-segment-btn" onClick={() => void openBackups()}>备份恢复</button>
          <button type="button" className="claude-segment-btn" disabled={loading} onClick={() => void load()}>↻</button>
          <button type="button" className="claude-segment-btn primary" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? '保存中…' : '保存修改'}
          </button>
        </span>
      </div>
      <div className="claude-settings-path" title={filePath}>
        {fileExists ? filePath : `${filePath}（全新，未保存过）`}
      </div>

      {view === 'form' && (
        <>
          <div className="claude-settings-pills">
            <button type="button" className={pill === -1 ? 'on' : ''} onClick={() => setPill(-1)}>全部</button>
            {CLAUDE_SETTING_GROUPS.map((group, gi) => (
              <button key={group.name} type="button" className={pill === gi ? 'on' : ''} onClick={() => setPill(gi)}>
                {group.name} {pillCounts[gi].visible}/{pillCounts[gi].total}
              </button>
            ))}
          </div>
          <div className="claude-settings-filterbar">
            <input
              className="claude-settings-search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索键名 / 说明（如 sandbox）"
            />
            <label className="claude-settings-check">
              <input type="checkbox" checked={customOnly} onChange={e => setCustomOnly(e.target.checked)} />
              仅看已自定义
            </label>
            <label className="claude-settings-check">
              <input type="checkbox" checked={showAdvanced} onChange={e => setShowAdvanced(e.target.checked)} />
              显示不常用
            </label>
          </div>
          {effortConflict && (
            <div className="claude-settings-effort-warning">
              <span className="claude-settings-effort-warning-text">
                冲突：env.CLAUDE_CODE_EFFORT_LEVEL={effortConflict.envEffort} 优先级最高，
                将覆盖 effortLevel / modelSettings 中的 {effortConflict.conflicting.join('、')}，
                普通启动会按 {effortConflict.envEffort} 运行。
              </span>
              <button type="button" className="claude-segment-btn" onClick={() => resetValue('env.CLAUDE_CODE_EFFORT_LEVEL')}>
                清除 env 覆盖
              </button>
            </div>
          )}
          {loading && <div className="claude-segment-empty">读取中…</div>}
          {!loading && visibleGroups.map(group => (
            <div key={group.name} className="settings-card-group claude-settings-card-group">
              <div className="card-group-header">
                <span className="card-group-title">{group.name}</span>
                {collapsedCounts[group.gi] > 0 && (
                  <span className="card-group-extra">已收起 {collapsedCounts[group.gi]} 项不常用</span>
                )}
              </div>
              <div className="claude-settings-group-items">
                {group.items.map(item => (
                  <SettingRow
                    key={item.key}
                    template={item}
                    value={getPathValue(content, item.key)}
                    customized={isCustomized(item.key)}
                    onChange={value => setValue(item.key, value)}
                    onReset={() => resetValue(item.key)}
                    onInvalid={invalid => reportInvalid(item.key, invalid)}
                  />
                ))}
              </div>
            </div>
          ))}
          {!loading && unknownKeys.length > 0 && (
            <div className="settings-card-group claude-settings-card-group">
              <div className="card-group-header">
                <span className="card-group-title">文件内其他键</span>
                <span className="card-group-extra">模板未收录，原样保留</span>
              </div>
              <div className="claude-settings-group-items">
                {unknownKeys.map(path => (
                  <div key={path} className="claude-settings-row customized">
                    <div className="claude-settings-row-info">
                      <div className="claude-settings-row-head">
                        <span className="claude-settings-key">{path}</span>
                        <span className="llm-badge">未知键</span>
                        <span className="llm-badge custom">已自定义</span>
                      </div>
                      <div className="claude-settings-desc">模板未收录该键，保存时原样保留（前向兼容官方新键）</div>
                    </div>
                    <div className="claude-settings-row-ctrl">
                      <input className="claude-settings-input" value={displayValue(getPathValue(content, path))} disabled />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!loading && (
            <div className="settings-card-group claude-settings-card-group">
              <div className="card-group-header">
                <span className="card-group-title">自定义环境变量</span>
                <span className="card-group-extra">以 env.KEY 保存到 settings.json</span>
              </div>
              <div className="claude-settings-customenv-wrap">
                <div className="claude-settings-customenv">
                  <input value={customKey} onChange={e => setCustomKey(e.target.value)} placeholder="变量名，如 MY_PROXY_URL" spellCheck={false} />
                  <input value={customValue} onChange={e => setCustomValue(e.target.value)} placeholder="值" spellCheck={false} />
                  <button type="button" className="claude-segment-btn primary" onClick={addCustomEnv}>添加</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {view === 'json' && (
        <div className="claude-settings-jsonview">
          <textarea
            className={`claude-settings-jsontext${jsonError ? ' invalid' : ''}`}
            value={jsonText}
            spellCheck={false}
            onChange={e => {
              setJsonText(e.target.value);
              markDirty();
              try {
                JSON.parse(e.target.value);
                setJsonError('');
              } catch (err) {
                setJsonError(String(err));
              }
            }}
          />
          {jsonError && <div className="claude-settings-jsonerror">{jsonError}</div>}
        </div>
      )}

      {backupDialog && (
        <Dialog title="备份恢复（保留最近 10 个）" onClose={() => setBackupDialog(false)}>
          {backups.length === 0 && <div className="claude-segment-empty">暂无备份</div>}
          {backups.map(backup => (
            <div key={backup.id} className="claude-settings-backup">
              <span className="claude-settings-backup-id" title={backup.id}>{backup.id}</span>
              <span className="claude-settings-backup-meta">
                {backup.createdAt ? new Date(backup.createdAt).toLocaleString('zh-CN', { hour12: false }) : ''} · {(backup.size / 1024).toFixed(1)} KB
              </span>
              <button type="button" className="claude-segment-btn mini" onClick={() => setRestoreTarget(backup)}>恢复</button>
            </div>
          ))}
        </Dialog>
      )}

      {restoreTarget && (
        <ConfirmDialog
          title="恢复备份"
          message={`确定用备份 ${restoreTarget.id} 覆盖当前配置吗？当前版本会被自动备份。`}
          confirmText="恢复"
          onClose={() => setRestoreTarget(null)}
          onConfirm={() => { void doRestore(restoreTarget); }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 单行控件
// ---------------------------------------------------------------------------

interface SettingRowProps {
  template: ClaudeSettingTemplate;
  value: unknown;
  customized: boolean;
  onChange: (value: unknown) => void;
  onReset: () => void;
  onInvalid: (invalid: boolean) => void;
}

const SettingRow: FC<SettingRowProps> = ({ template, value, customized, onChange, onReset, onInvalid }) => {
  const [text, setText] = useState('');
  const [textError, setTextError] = useState('');
  const [textTouched, setTextTouched] = useState(false);
  const isJsonLike = template.control === 'json' || template.control === 'list';

  // 外部值变化时同步文本态（未编辑过才同步，避免打断输入）。
  useEffect(() => {
    if (!isJsonLike || textTouched) return;
    setText(value === undefined ? '' : JSON.stringify(value, null, 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, isJsonLike]);

  useEffect(() => {
    if (!isJsonLike) {
      onInvalid(false);
      return;
    }
    if (!textTouched) {
      onInvalid(false);
      return;
    }
    onInvalid(text.trim() !== '' && textError !== '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textError, textTouched, text, isJsonLike]);

  // 行卸载（切视图 / 过滤隐藏）时清掉自己的无效标记，避免残留标记挡住保存。
  useEffect(() => () => onInvalid(false), []);

  const sourceLabel = SOURCE_LABEL[template.source];

  const renderControl = () => {
    switch (template.control) {
      case 'ro': {
        const summary = template.key === 'permissions'
          ? permissionsSummary(value)
          : hooksSummary(value);
        return <div className="claude-settings-ro">{summary}（只读，写回时原样保留）</div>;
      }
      case 'bool':
        return (
          <select
            className="claude-settings-input"
            value={value === undefined ? '' : String(Boolean(value))}
            onChange={e => {
              if (e.target.value === '') onReset();
              else onChange(e.target.value === 'true');
            }}
          >
            <option value="">未设置</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        );
      case 'envbool':
        return (
          <select
            className="claude-settings-input"
            value={toEnvBoolOption(value)}
            onChange={e => {
              if (e.target.value === '') onReset();
              else onChange(e.target.value);
            }}
          >
            {ENV_BOOL_OPTIONS.map(option => (
              <option key={option} value={option}>{ENV_BOOL_LABELS[option]}</option>
            ))}
          </select>
        );
      case 'effort':
      case 'effortmax':
        return (
          <select
            className="claude-settings-input"
            value={typeof value === 'string' ? value : ''}
            onChange={e => {
              if (e.target.value === '') onReset();
              else onChange(e.target.value);
            }}
          >
            <option value="">未设置</option>
            {EFFORT_OPTIONS.map(option => (
              <option key={option} value={option}>
                {option}{option === 'max' ? '（经 --effort 生效）' : ''}
              </option>
            ))}
          </select>
        );
      case 'select':
        return (
          <select
            className="claude-settings-input"
            value={typeof value === 'string' ? value : ''}
            onChange={e => {
              if (e.target.value === '') onReset();
              else onChange(e.target.value);
            }}
          >
            <option value="">未设置</option>
            {(template.options ?? []).map(([optionValue, label]) => (
              <option key={optionValue} value={optionValue}>{label}</option>
            ))}
          </select>
        );
      case 'num':
        return (
          <input
            className="claude-settings-input"
            type="number"
            value={typeof value === 'number' ? value : (typeof value === 'string' && value !== '' ? Number(value) || '' : '')}
            placeholder={customized ? '' : '未设置'}
            onChange={e => {
              if (e.target.value === '') onReset();
              else onChange(Number(e.target.value));
            }}
          />
        );
      case 'password':
        return (
          <input
            className="claude-settings-input"
            type="password"
            value={typeof value === 'string' ? value : displayValue(value)}
            placeholder={customized ? '' : '未设置'}
            spellCheck={false}
            onChange={e => {
              if (e.target.value === '') onReset();
              else onChange(e.target.value);
            }}
          />
        );
      case 'json':
      case 'list': {
        const valid = text.trim() === '' || textError === '';
        return (
          <div className="claude-settings-jsonwrap">
            <textarea
              className={`claude-settings-jsontext small${valid ? '' : ' invalid'}`}
              value={text}
              spellCheck={false}
              placeholder={customized ? '' : (template.control === 'list' ? 'JSON 数组，如 ["a", "b"]' : 'JSON 对象')}
              onChange={e => {
                const next = e.target.value;
                setText(next);
                setTextTouched(true);
                if (next.trim() === '') {
                  setTextError('');
                  onReset();
                  return;
                }
                try {
                  const parsed: unknown = JSON.parse(next);
                  if (template.control === 'list' && !Array.isArray(parsed)) {
                    setTextError('必须是 JSON 数组');
                    return;
                  }
                  if (template.control === 'json' && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
                    setTextError('必须是 JSON 对象');
                    return;
                  }
                  setTextError('');
                  onChange(parsed);
                } catch (err) {
                  setTextError(String(err));
                }
              }}
            />
            <div className="claude-settings-jsonbar">
              <button
                type="button"
                className="claude-segment-btn mini"
                onClick={() => {
                  try {
                    const parsed: unknown = JSON.parse(text);
                    setText(JSON.stringify(parsed, null, 2));
                    setTextError('');
                  } catch {
                    showToastStatic('内容不是有效 JSON，未格式化', 'error');
                  }
                }}
              >
                格式化
              </button>
              {textError && <span className="claude-settings-jsonerror">{textError}</span>}
            </div>
          </div>
        );
      }
      case 'text':
      default:
        return (
          <input
            className="claude-settings-input"
            value={typeof value === 'string' ? value : displayValue(value)}
            placeholder={customized ? '' : '未设置'}
            spellCheck={false}
            onChange={e => {
              if (e.target.value === '') onReset();
              else onChange(e.target.value);
            }}
          />
        );
    }
  };

  const isMultiline = isJsonLike || template.control === 'ro';

  return (
    <div className={`claude-settings-row${customized ? ' customized' : ''}${isMultiline ? ' is-multiline' : ''}`}>
      <div className="claude-settings-row-info">
        <div className="claude-settings-row-head">
          <span className="claude-settings-key" title={template.key}>{template.key}</span>
          {sourceLabel && <span className="llm-badge src">{sourceLabel}</span>}
          {customized
            ? <span className="llm-badge custom">已自定义</span>
            : <span className="llm-badge official">官方默认</span>}
        </div>
        <div className="claude-settings-desc">
          <span>{template.desc}</span>
          {!customized && template.officialDefault && (
            <span className="claude-settings-official"> · 默认值：{template.officialDefault}</span>
          )}
        </div>
      </div>
      <div className="claude-settings-row-ctrl">
        {renderControl()}
        {customized && template.control !== 'ro' && (
          <button
            type="button"
            className="claude-segment-btn mini claude-settings-reset-btn"
            title="恢复官方默认设置"
            onClick={onReset}
          >
            恢复默认
          </button>
        )}
      </div>
    </div>
  );
};

function showToastStatic(message: string, type: 'info' | 'success' | 'error') {
  useAppStore.getState().showToast(message, type);
}

function permissionsSummary(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '未设置';
  const record = value as Record<string, unknown>;
  const count = (key: string) => (Array.isArray(record[key]) ? (record[key] as unknown[]).length : 0);
  return `allow ${count('allow')} 条 · ask ${count('ask')} 条 · deny ${count('deny')} 条`;
}

function hooksSummary(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '未设置';
  const names = Object.keys(value as Record<string, unknown>);
  if (names.length === 0) return '空对象';
  return `${names.length} 类事件：${names.slice(0, 4).join('、')}${names.length > 4 ? '…' : ''}`;
}
