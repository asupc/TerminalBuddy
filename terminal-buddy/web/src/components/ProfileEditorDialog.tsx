import { useEffect, useState } from 'react';
import { api } from '../api';
import { PRESET_THEMES, TAB_COLORS, type Profile, type Project, type TerminalType } from '../types';
import { createProfileFrom, LOCAL_TYPES } from '../utils/projects';
import { Dialog } from './Dialog';
import { ServerPathPicker } from './ServerPathPicker';

const TERMINAL_NAMES: Record<string, string> = {
  powershell: 'PowerShell',
  pwsh: 'PowerShell 7',
  cmd: 'CMD',
  bash: 'Bash',
  sh: 'Shell',
  zsh: 'Zsh',
  ssh: 'SSH',
  docker: 'Docker',
  k8s: 'Kubernetes',
};

export function ProfileEditorDialog({
  profile,
  defaultGroup,
  projects,
  defaultShell,
  windows,
  onSaved,
  onClose,
}: {
  profile: Profile | null;
  defaultGroup?: string;
  projects: Project[];
  defaultShell: TerminalType;
  windows: boolean;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Profile>(() => ({
    id: '',
    name: '',
    group: defaultGroup || projects.find((p) => p.path)?.name || '',
    terminalType: defaultShell,
    startupPath: '',
    startupCommands: [],
    environmentVariables: {},
    colorTheme: 'dark-default',
    tabColor: null,
    sshHost: '',
    sshPort: 22,
    sshUser: '',
    sshAuthType: 'key',
    sshKeyPath: '',
    sshPassword: '',
    dockerContainerName: '',
    k8sNamespace: '',
    k8sPodName: '',
    k8sContainerName: '',
    ...profile,
  }));
  const [commands, setCommands] = useState(
    profile?.startupCommands?.length ? profile.startupCommands : [''],
  );
  const [env, setEnv] = useState(
    Object.entries(profile?.environmentVariables || {}).map(([key, value]) => ({ key, value })),
  );
  const [templates, setTemplates] = useState<{ name: string; command: string }[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const types = [
    ...(windows ? ['powershell', 'pwsh', 'cmd'] : ['bash', 'sh', 'zsh', 'pwsh']),
    'ssh',
    'docker',
    'k8s',
  ];
  if (!types.includes(draft.terminalType)) types.unshift(draft.terminalType);
  useEffect(() => {
    api
      .getCommandTemplates()
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw) as { commands: { name: string; command: string }[] }[];
        if (Array.isArray(parsed)) setTemplates(parsed.flatMap((t) => t.commands || []));
      })
      .catch(() => {});
  }, []);
  const change = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setDraft((p) => ({ ...p, [key]: value }));
  const textField = (
    key:
      | 'sshHost'
      | 'sshUser'
      | 'sshKeyPath'
      | 'sshPassword'
      | 'dockerContainerName'
      | 'k8sNamespace'
      | 'k8sPodName'
      | 'k8sContainerName',
    label: string,
    type = 'text',
  ) => (
    <label>
      {label}
      <input
        type={type}
        value={draft[key] || ''}
        onChange={(e) => change(key, e.target.value)}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
      />
    </label>
  );
  const submit = async () => {
    if (!draft.name.trim()) {
      setError('请输入配置名称');
      return;
    }
    if (!projects.some((p) => p.name === draft.group && p.path.trim())) {
      setError('请先添加项目并设置项目路径');
      return;
    }
    if (env.some((e) => e.key.trim() && /[=\x00-\x1f]/.test(e.key))) {
      setError('环境变量名不能包含等号或控制字符');
      return;
    }
    const keys = env.map((e) => e.key.trim()).filter(Boolean);
    if (new Set(keys).size !== keys.length) {
      setError('环境变量名不能重复');
      return;
    }
    const value = {
      ...draft,
      name: draft.name.trim(),
      startupCommands: commands.filter((c) => c.trim()),
      environmentVariables: Object.fromEntries(
        env.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value]),
      ),
    };
    setBusy(true);
    setError('');
    try {
      if (profile) await api.updateProfile(value);
      else await createProfileFrom(value);
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const moveCommand = (index: number, delta: number) => {
    const next = [...commands];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setCommands(next);
  };
  return (
    <>
      <Dialog
        title={profile ? '编辑配置' : '添加配置'}
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
              form="mobile-profile-form"
            >
              {busy ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <form
          id="mobile-profile-form"
          className="project-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy}>
            <label>
              终端类型
              <select
                value={draft.terminalType}
                onChange={(e) => change('terminalType', e.target.value as TerminalType)}
              >
                {types.map((t) => (
                  <option key={t} value={t}>
                    {TERMINAL_NAMES[t] || t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              名称 *
              <input required value={draft.name} onChange={(e) => change('name', e.target.value)} />
            </label>
            <label>
              项目 *
              <select
                required
                value={draft.group}
                onChange={(e) => change('group', e.target.value)}
              >
                <option value="">请选择项目</option>
                {projects
                  .filter((p) => p.path)
                  .map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            {LOCAL_TYPES.includes(draft.terminalType) && (
              <>
                <div className="project-field-label">启动命令</div>
                {commands.map((command, index) => (
                  <div className="project-command-row" key={index}>
                    <input
                      aria-label={`启动命令 ${index + 1}`}
                      list="mobile-command-templates"
                      value={command}
                      onChange={(e) =>
                        setCommands(commands.map((c, i) => (i === index ? e.target.value : c)))
                      }
                      placeholder="输入命令…"
                    />
                    <div className="project-row-actions">
                      <button
                        type="button"
                        className="btn small"
                        disabled={index === 0}
                        aria-label={`上移命令 ${index + 1}`}
                        onClick={() => moveCommand(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        disabled={index === commands.length - 1}
                        aria-label={`下移命令 ${index + 1}`}
                        onClick={() => moveCommand(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        aria-label={`删除命令 ${index + 1}`}
                        onClick={() => setCommands(commands.filter((_, i) => i !== index))}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
                <datalist id="mobile-command-templates">
                  {templates.map((t, i) => (
                    <option key={i} value={t.command}>
                      {t.name}
                    </option>
                  ))}
                </datalist>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setCommands([...commands, ''])}
                >
                  添加命令
                </button>
                <details className="project-env">
                  <summary>环境变量（{env.length} 项）</summary>
                  {env.map((entry, index) => (
                    <div className="project-env-row" key={index}>
                      <input
                        aria-label={`环境变量名 ${index + 1}`}
                        placeholder="变量名"
                        value={entry.key}
                        onChange={(e) =>
                          setEnv(
                            env.map((v, i) => (i === index ? { ...v, key: e.target.value } : v)),
                          )
                        }
                      />
                      <input
                        aria-label={`环境变量值 ${index + 1}`}
                        placeholder="值"
                        value={entry.value}
                        onChange={(e) =>
                          setEnv(
                            env.map((v, i) => (i === index ? { ...v, value: e.target.value } : v)),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="btn small"
                        aria-label={`删除环境变量 ${index + 1}`}
                        onClick={() => setEnv(env.filter((_, i) => i !== index))}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setEnv([...env, { key: '', value: '' }])}
                  >
                    添加变量
                  </button>
                </details>
                <label>
                  起始路径
                  <div className="project-input-action">
                    <input
                      value={draft.startupPath || ''}
                      onChange={(e) => change('startupPath', e.target.value)}
                      placeholder={
                        projects.find((p) => p.name === draft.group)?.path || '留空继承项目路径'
                      }
                    />
                    <button type="button" className="btn" onClick={() => setBrowsing(true)}>
                      浏览
                    </button>
                  </div>
                  <small>留空继承项目路径，也可填写相对路径。</small>
                </label>
              </>
            )}
            {draft.terminalType === 'ssh' && (
              <>
                {textField('sshHost', '主机地址')}
                <label>
                  端口
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.sshPort || 22}
                    onChange={(e) => change('sshPort', Number(e.target.value))}
                  />
                </label>
                {textField('sshUser', '用户名')}
                <label>
                  认证方式
                  <select
                    value={draft.sshAuthType || 'key'}
                    onChange={(e) => change('sshAuthType', e.target.value)}
                  >
                    <option value="key">密钥认证</option>
                    <option value="password">密码认证</option>
                  </select>
                </label>
                {draft.sshAuthType === 'password'
                  ? textField('sshPassword', '密码', 'password')
                  : textField('sshKeyPath', '服务器密钥路径')}
              </>
            )}
            {draft.terminalType === 'docker' && textField('dockerContainerName', '容器名称 / ID')}
            {draft.terminalType === 'k8s' && (
              <>
                {textField('k8sNamespace', '命名空间（Namespace）')}
                {textField('k8sPodName', 'Pod 名称')}
                {textField('k8sContainerName', '容器名称')}
              </>
            )}
            <label>
              颜色主题
              <select
                value={draft.colorTheme || 'dark-default'}
                onChange={(e) => change('colorTheme', e.target.value)}
              >
                {PRESET_THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              标签颜色
              <select
                value={draft.tabColor || ''}
                onChange={(e) => change('tabColor', e.target.value || null)}
              >
                {TAB_COLORS.map((c) => (
                  <option key={c?.id || 'default'} value={c?.color || ''}>
                    {c?.name || '跟随主题'}
                  </option>
                ))}
              </select>
            </label>
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
          initialPath={draft.startupPath || projects.find((p) => p.name === draft.group)?.path}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            change('startupPath', path);
            setBrowsing(false);
          }}
        />
      )}
    </>
  );
}
