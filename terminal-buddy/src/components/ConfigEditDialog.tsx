import { FC, useState, useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { open } from '@tauri-apps/plugin-dialog';
import { createProfile, updateProfile, deleteProfile } from '../services/tauri';
import { PRESET_THEMES, TAB_COLORS, type Profile } from '../types';
import { COMMAND_TEMPLATES } from '../data/commandTemplates';
import { useDraggable } from '../hooks/useDraggable';
import { GroupCascader } from './GroupCascader';
import './ConfigEditDialog.css';

interface ConfigEditDialogProps {
  profile: Profile | null;
  onClose: () => void;
  onSave: () => void;
  defaultGroup?: string;
  profiles: Profile[];
}

interface FormData {
  name: string;
  group: string;
  terminalType: 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'editor' | 'mstsc';
  startupPath: string;
  colorTheme: string;
  tabColor: string;
}

export const ConfigEditDialog: FC<ConfigEditDialogProps> = ({
  profile,
  onClose,
  onSave,
  defaultGroup,
  profiles,
}) => {
  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<FormData>({
    defaultValues: {
      name: profile?.name || '',
      group: defaultGroup || profile?.group || '默认',
      terminalType: profile?.terminalType || 'powershell',
      startupPath: profile?.startupPath || '',
      colorTheme: profile?.colorTheme || 'dark-default',
      tabColor: profile?.tabColor || '',
    },
  });

  const [startupCommands, setStartupCommands] = useState<string[]>(
    profile?.startupCommands?.length ? profile.startupCommands : ['']
  );
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [activeCmdIndex, setActiveCmdIndex] = useState<number | null>(null);
  const [cmdSuggestions, setCmdSuggestions] = useState<{ name: string; command: string }[]>([]);
  const [cmdSelectedIndex, setCmdSelectedIndex] = useState(-1);
  const cmdSuggestionsRef = useRef<HTMLDivElement>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragStateRef = useRef<{ startIndex: number; startY: number } | null>(null);
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>(
    profile?.environmentVariables
      ? Object.entries(profile.environmentVariables).map(([key, value]) => ({ key, value }))
      : []
  );
  const [envExpanded, setEnvExpanded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sshHost, setSshHost] = useState(profile?.sshHost || '');
  const [sshPort, setSshPort] = useState(profile?.sshPort || 22);
  const [sshUser, setSshUser] = useState(profile?.sshUser || '');
  const [sshAuthType, setSshAuthType] = useState(profile?.sshAuthType || 'key');
  const [sshKeyPath, setSshKeyPath] = useState(profile?.sshKeyPath || '');
  const [sshPassword, setSshPassword] = useState(profile?.sshPassword || '');
  const [dockerContainerName, setDockerContainerName] = useState(profile?.dockerContainerName || '');
  const [k8sNamespace, setK8sNamespace] = useState(profile?.k8sNamespace || '');
  const [k8sPodName, setK8sPodName] = useState(profile?.k8sPodName || '');
  const [k8sContainerName, setK8sContainerName] = useState(profile?.k8sContainerName || '');
  const [mstscHost, setMstscHost] = useState(profile?.mstscHost || '');
  const [mstscPort, setMstscPort] = useState(profile?.mstscPort || 3389);
  const [mstscUser, setMstscUser] = useState(profile?.mstscUser || '');
  const [mstscPassword, setMstscPassword] = useState(profile?.mstscPassword || '');
  const [mstscResolution, setMstscResolution] = useState(profile?.mstscResolution || '');
  const dialogRef = useRef<HTMLDivElement>(null);
  const { offset: dialogOffset, dragHandleProps } = useDraggable('.dialog-content');

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    };
  }, []);

  const addCommand = () => {
    setStartupCommands([...startupCommands, '']);
    setActiveCmdIndex(startupCommands.length);
  };

  const removeCommand = (index: number) => {
    setStartupCommands(startupCommands.filter((_, i) => i !== index));
  };

  const updateCommand = (index: number, value: string) => {
    const next = [...startupCommands];
    next[index] = value;
    setStartupCommands(next);
  };

  const handleCmdInputChange = (index: number, value: string) => {
    updateCommand(index, value);
    if (value.trim() === '') {
      setCmdSuggestions([]);
      return;
    }
    const query = value.toLowerCase();
    const queryChars = [...query];

    // Fuzzy match: substring first, then character sequence
    const fuzzyMatch = (text: string): boolean => {
      const lower = text.toLowerCase();
      if (lower.includes(query)) return true;
      let idx = 0;
      for (const ch of lower) {
        if (ch === queryChars[idx]) idx++;
        if (idx === queryChars.length) return true;
      }
      return false;
    };

    const allCommands = COMMAND_TEMPLATES.flatMap(cat => cat.commands);
    const builtIn = allCommands.filter(cmd =>
      fuzzyMatch(cmd.command) || fuzzyMatch(cmd.desc)
    );

    setCmdSuggestions(builtIn);
    setActiveCmdIndex(index);
    setCmdSelectedIndex(-1);
  };

  const selectCmdSuggestion = (cmd: { name: string; command: string }, index: number) => {
    updateCommand(index, cmd.command);
    setCmdSuggestions([]);
    setCmdSelectedIndex(-1);
  };

  const handleDragHandleMouseDown = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = { startIndex: index, startY: e.clientY };
    setDragIndex(index);

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragStateRef.current) return;
      const dy = ev.clientY - dragStateRef.current.startY;
      if (Math.abs(dy) > 5) {
        document.body.style.cursor = 'grabbing';
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      dragStateRef.current = null;
      setDragIndex(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseEnter = (index: number) => {
    if (dragIndex === null || dragIndex === index) return;
    const next = [...startupCommands];
    const [removed] = next.splice(dragIndex, 1);
    next.splice(index, 0, removed);
    setStartupCommands(next);
    setDragIndex(index);
  };

  const onSubmit = async (data: FormData) => {
    try {
      setSaveError(null);
      const commands = startupCommands.filter(c => c.trim() !== '');
      if (profile) {
        await updateProfile({
          ...profile,
          name: data.name,
          group: data.group,
          terminalType: data.terminalType,
          startupPath: data.startupPath,
          colorTheme: data.colorTheme,
          tabColor: data.tabColor || null,
          startupCommands: commands,
          environmentVariables: envVars.reduce((acc, { key, value }) => {
            if (key.trim()) acc[key.trim()] = value;
            return acc;
          }, {} as Record<string, string>),
          sshHost, sshPort, sshUser, sshAuthType, sshKeyPath, sshPassword,
          dockerContainerName,
          k8sNamespace, k8sPodName, k8sContainerName,
          mstscHost, mstscPort, mstscUser, mstscPassword, mstscResolution,
        });
      } else {
        const newProfile = await createProfile(data.name, data.group, data.terminalType);
        await updateProfile({
          ...newProfile,
          startupPath: data.startupPath,
          colorTheme: data.colorTheme,
          tabColor: data.tabColor || null,
          startupCommands: commands,
          environmentVariables: envVars.reduce((acc, { key, value }) => {
            if (key.trim()) acc[key.trim()] = value;
            return acc;
          }, {} as Record<string, string>),
          sshHost, sshPort, sshUser, sshAuthType, sshKeyPath, sshPassword,
          dockerContainerName,
          k8sNamespace, k8sPodName, k8sContainerName,
          mstscHost, mstscPort, mstscUser, mstscPassword, mstscResolution,
        });
      }
      onSave();
    } catch (err) {
      setSaveError(String(err));
    }
  };

  const handleDelete = () => {
    setConfirmDelete(true);
  };

  const confirmDeleteProfile = async () => {
    setConfirmDelete(false);
    if (!profile) return;
    try {
      await deleteProfile(profile.id);
      onSave();
    } catch (err) {
      console.error('Failed to delete profile:', err);
    }
  };

  const handleBrowsePath = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择起始路径',
      });
      if (typeof selected === 'string' && selected.length > 0) {
        setValue('startupPath', selected, { shouldDirty: true, shouldValidate: true });
      }
    } catch (err) {
      console.error('[DEBUG] dialog error:', err);
      alert('打开目录对话框失败: ' + String(err));
    }
  };

  return (
    <div className="dialog-overlay">
      <div
        ref={dialogRef}
        className="dialog dialog-large"
        style={{ transform: `translate(${dialogOffset.x}px, ${dialogOffset.y}px)` }}
        onMouseDown={dragHandleProps.onMouseDown}
      >
        <div className="dialog-header dialog-drag-handle">
          <h3>{profile ? '编辑连接' : '新建连接'}</h3>
          <button className="dialog-close" onClick={onClose}>×</button>
        </div>
        {saveError && (
          <div className="dialog-error">{saveError}</div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="dialog-content">
          <div className="form-row">
            <div className="form-group">
              <label>分组</label>
              <GroupCascader
                value={watch('group')}
                onChange={(val) => setValue('group', val)}
                profiles={profiles}
              />
            </div>
            <div className="form-group">
              <label>名称</label>
              <input
                {...register('name', { required: '请输入连接名称' })}
                placeholder="连接名称"
              />
              {errors.name && <span className="error">{errors.name.message}</span>}
            </div>
          </div>

          {['powershell', 'cmd'].includes(watch('terminalType')) && (
          <>
          <div className="form-group">
            <label>启动命令</label>
            <div className="cmd-list">
              {startupCommands.map((cmd, index) => (
                <div
                  key={index}
                  className={`cmd-item ${dragIndex === index ? 'dragging' : ''}`}
                  onMouseEnter={() => handleMouseEnter(index)}
                >
                  <span
                    className="cmd-drag-handle"
                    title="拖拽排序"
                    onMouseDown={(e) => handleDragHandleMouseDown(e, index)}
                  >⠿</span>
                  <span className="cmd-num">{index + 1}.</span>
                  <div className="cmd-input-wrapper">
                    <input
                      value={cmd}
                      onChange={(e) => handleCmdInputChange(index, e.target.value)}
                      onFocus={() => {
                        if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
                        setActiveCmdIndex(index);
                      }}
                      onBlur={() => {
                        blurTimerRef.current = setTimeout(() => setCmdSuggestions([]), 200);
                      }}
                      placeholder="输入命令..."
                      style={{ fontFamily: 'monospace' }}
                    />
                    {activeCmdIndex === index && cmdSuggestions.length > 0 && (
                      <div className="command-suggestions" ref={cmdSuggestionsRef}>
                        {cmdSuggestions.map((s, si) => (
                          <div
                            key={s.command}
                            className={`suggestion-item ${si === cmdSelectedIndex ? 'selected' : ''}`}
                            onMouseDown={() => selectCmdSuggestion(s, index)}
                          >
                            <span className="suggestion-name">{s.name}</span>
                            <span className="suggestion-command">{s.command}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {startupCommands.length > 1 && (
                    <button
                      type="button"
                      className="cmd-remove-btn"
                      onClick={() => removeCommand(index)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="cmd-add-btn" onClick={addCommand}>
                + 添加命令
              </button>
            </div>
          </div>

          <div className="form-group">
            <div
              className={`env-section-header ${envExpanded ? 'expanded' : ''}`}
              onClick={() => setEnvExpanded(!envExpanded)}
            >
              <span className="env-section-arrow">{envExpanded ? '▼' : '▶'}</span>
              <label style={{ marginBottom: 0, cursor: 'pointer' }}>环境变量</label>
              {envVars.length > 0 && <span className="env-count">{envVars.length} 项</span>}
            </div>
            {envExpanded && (
              <div className="env-section-body">
                {envVars.map((env, index) => (
                  <div key={index} className="env-row">
                    <input
                      className="env-key"
                      value={env.key}
                      onChange={(e) => {
                        const next = [...envVars];
                        next[index] = { ...next[index], key: e.target.value };
                        setEnvVars(next);
                      }}
                      placeholder="变量名"
                    />
                    <span className="env-eq">=</span>
                    <input
                      className="env-value"
                      value={env.value}
                      onChange={(e) => {
                        const next = [...envVars];
                        next[index] = { ...next[index], value: e.target.value };
                        setEnvVars(next);
                      }}
                      placeholder="值"
                    />
                    <button
                      type="button"
                      className="env-remove-btn"
                      onClick={() => setEnvVars(envVars.filter((_, i) => i !== index))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="env-add-btn"
                  onClick={() => setEnvVars([...envVars, { key: '', value: '' }])}
                >
                  + 添加变量
                </button>
              </div>
            )}
          </div>

          <div className="form-group">
            <label>起始路径</label>
            <div className="input-with-button">
              <input {...register('startupPath')} placeholder="C:\Projects" />
              <button type="button" className="browse-btn" onClick={handleBrowsePath}>
                浏览
              </button>
            </div>
          </div>
          </>
          )}

          <div className="form-row">
            <div className="form-group">
              <label>终端类型</label>
              <select {...register('terminalType')}>
                <option value="powershell">PowerShell</option>
                <option value="cmd">CMD</option>
                <option value="ssh">SSH</option>
                <option value="docker">Docker</option>
                <option value="k8s">Kubernetes</option>
                <option value="mstsc">远程桌面 (RDP)</option>
              </select>
            </div>
            <div className="form-group">
              <label>颜色主题</label>
              <select {...register('colorTheme')}>
                {PRESET_THEMES.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {watch('terminalType') === 'ssh' && (
            <>
              <div className="form-group">
                <label>主机地址</label>
                <input value={sshHost} onChange={e => setSshHost(e.target.value)} placeholder="192.168.1.100" />
              </div>
              <div className="form-group">
                <label>端口</label>
                <input type="number" value={sshPort} onChange={e => setSshPort(Number(e.target.value))} />
              </div>
              <div className="form-group">
                <label>用户名</label>
                <input value={sshUser} onChange={e => setSshUser(e.target.value)} placeholder="root" />
              </div>
              <div className="form-group">
                <label>认证方式</label>
                <select value={sshAuthType} onChange={e => setSshAuthType(e.target.value as 'password' | 'key')}>
                  <option value="key">密钥认证</option>
                  <option value="password">密码认证</option>
                </select>
              </div>
              {sshAuthType === 'key' && (
                <div className="form-group">
                  <label>密钥路径</label>
                  <input value={sshKeyPath} onChange={e => setSshKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" />
                </div>
              )}
              {sshAuthType === 'password' && (
                <div className="form-group">
                  <label>密码</label>
                  <input type="password" value={sshPassword} onChange={e => setSshPassword(e.target.value)} placeholder="输入 SSH 密码" />
                </div>
              )}
            </>
          )}

          {watch('terminalType') === 'docker' && (
            <div className="form-group">
              <label>容器名称 / ID</label>
              <input value={dockerContainerName} onChange={e => setDockerContainerName(e.target.value)} placeholder="my-container" />
            </div>
          )}

          {watch('terminalType') === 'k8s' && (
            <>
              <div className="form-group">
                <label>Namespace</label>
                <input value={k8sNamespace} onChange={e => setK8sNamespace(e.target.value)} placeholder="default" />
              </div>
              <div className="form-group">
                <label>Pod 名称</label>
                <input value={k8sPodName} onChange={e => setK8sPodName(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Container 名称</label>
                <input value={k8sContainerName} onChange={e => setK8sContainerName(e.target.value)} />
              </div>
            </>
          )}

          {watch('terminalType') === 'mstsc' && (
            <>
              <div className="form-group">
                <label>主机地址 *</label>
                <input value={mstscHost} onChange={e => setMstscHost(e.target.value)} placeholder="192.168.1.100 或 remote.example.com" required />
              </div>
              <div className="form-group">
                <label>端口</label>
                <input type="number" value={mstscPort} onChange={e => setMstscPort(Number(e.target.value))} placeholder="3389" />
              </div>
              <div className="form-group">
                <label>用户名</label>
                <input value={mstscUser} onChange={e => setMstscUser(e.target.value)} placeholder="Administrator" />
              </div>
              <div className="form-group">
                <label>密码</label>
                <input type="password" value={mstscPassword} onChange={e => setMstscPassword(e.target.value)} placeholder="将存储到 Windows 凭据管理器" />
              </div>
              <div className="form-group">
                <label>分辨率</label>
                <select value={mstscResolution} onChange={e => setMstscResolution(e.target.value)}>
                  <option value="">全屏</option>
                  <option value="1280x720">1280 x 720</option>
                  <option value="1366x768">1366 x 768</option>
                  <option value="1600x900">1600 x 900</option>
                  <option value="1920x1080">1920 x 1080</option>
                  <option value="2560x1440">2560 x 1440</option>
                  <option value="3840x2160">3840 x 2160</option>
                </select>
              </div>
            </>
          )}

          <div className="form-group">
            <label>Tab 颜色</label>
            <div className="tab-color-options">
              <label className={`tab-color-chip ${watch('tabColor') === '' ? 'active' : ''}`}>
                <input
                  type="radio"
                  value=""
                  {...register('tabColor')}
                />
                <span>跟随主题</span>
              </label>
              {TAB_COLORS.filter(Boolean).map((c) => c && (
                <label
                  key={c.id}
                  className={`tab-color-chip ${watch('tabColor') === c.color ? 'active' : ''}`}
                  style={{ color: c.color }}
                >
                  <input
                    type="radio"
                    value={c.color}
                    {...register('tabColor')}
                  />
                  <span>{c.name}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="dialog-footer">
            {profile && (
              <button type="button" className="btn-danger" onClick={handleDelete}>
                删除
              </button>
            )}
            <div className="spacer" />
            <button type="button" className="btn-secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn-primary">
              保存
            </button>
          </div>
        </form>
      </div>
      {confirmDelete && (
        <div className="confirm-dialog-overlay" onClick={() => setConfirmDelete(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">确认删除</div>
            <div className="confirm-dialog-message">确定要删除此连接吗？</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={() => setConfirmDelete(false)}>取消</button>
              <button className="btn-danger" onClick={confirmDeleteProfile}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};