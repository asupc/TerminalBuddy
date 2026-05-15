import { FC, useState, useRef, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { open } from '@tauri-apps/plugin-dialog';
import { createProfile, updateProfile, deleteProfile } from '../services/tauri';
import { PRESET_THEMES, TAB_COLORS, type Profile } from '../types';
import { COMMAND_TEMPLATES, getCommandHistory, addCommandToHistory } from '../data/commandTemplates';
import './ConfigEditDialog.css';

interface ConfigEditDialogProps {
  profile: Profile | null;
  onClose: () => void;
  onSave: () => void;
}

interface FormData {
  name: string;
  group: string;
  terminalType: 'powershell' | 'cmd';
  startupPath: string;
  colorTheme: string;
  tabColor: string;
}

export const ConfigEditDialog: FC<ConfigEditDialogProps> = ({
  profile,
  onClose,
  onSave,
}) => {
  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<FormData>({
    defaultValues: {
      name: profile?.name || '',
      group: profile?.group || '默认',
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
  const [dragEnabledIndex, setDragEnabledIndex] = useState<number | null>(null);
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>(
    profile?.environmentVariables
      ? Object.entries(profile.environmentVariables).map(([key, value]) => ({ key, value }))
      : []
  );
  const [envExpanded, setEnvExpanded] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [dialogOffset, setDialogOffset] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

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
    const allCommands = COMMAND_TEMPLATES.flatMap(cat => cat.commands);
    const builtIn = allCommands.filter(cmd =>
      cmd.command.toLowerCase().includes(query)
    );
    const history = getCommandHistory()
      .filter(cmd => cmd.toLowerCase().includes(query))
      .map(cmd => ({ name: cmd, command: cmd }));
    const seen = new Set(builtIn.map(c => c.command));
    const uniqueHistory = history.filter(c => !seen.has(c.command));
    setCmdSuggestions([...builtIn, ...uniqueHistory]);
    setActiveCmdIndex(index);
    setCmdSelectedIndex(-1);
  };

  const selectCmdSuggestion = (cmd: { name: string; command: string }, index: number) => {
    updateCommand(index, cmd.command);
    setCmdSuggestions([]);
    setCmdSelectedIndex(-1);
  };

  const handleDragHandleMouseDown = (index: number) => {
    setDragEnabledIndex(index);
  };

  const handleDragStart = (index: number) => {
    if (dragEnabledIndex !== index) return;
    setDragIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;
    const next = [...startupCommands];
    const [removed] = next.splice(dragIndex, 1);
    next.splice(index, 0, removed);
    setStartupCommands(next);
    setDragIndex(index);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragEnabledIndex(null);
  };

  const onSubmit = async (data: FormData) => {
    try {
      const commands = startupCommands.filter(c => c.trim() !== '');
      commands.forEach(cmd => addCommandToHistory(cmd));
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
        });
      }
      onSave();
    } catch (err) {
      console.error('Failed to save profile:', err);
    }
  };

  const handleDelete = async () => {
    if (profile && confirm('确定要删除此配置吗？')) {
      try {
        await deleteProfile(profile.id);
        onSave();
      } catch (err) {
        console.error('Failed to delete profile:', err);
      }
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

  const handleDialogMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.dialog-content')) return;
    isDragging.current = true;
    dragStartPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleDialogMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      const dx = e.clientX - dragStartPos.current.x;
      const dy = e.clientY - dragStartPos.current.y;
      setDialogOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      dragStartPos.current = { x: e.clientX, y: e.clientY };
    });
  }, []);

  const handleDialogMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return (
    <div className="dialog-overlay">
      <div
        ref={dialogRef}
        className="dialog dialog-large"
        style={{ transform: `translate(${dialogOffset.x}px, ${dialogOffset.y}px)` }}
        onMouseDown={handleDialogMouseDown}
        onMouseMove={handleDialogMouseMove}
        onMouseUp={handleDialogMouseUp}
      >
        <div className="dialog-header dialog-drag-handle">
          <h3>{profile ? '编辑配置' : '新建配置'}</h3>
          <button className="dialog-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="dialog-content">
          <div className="form-row">
            <div className="form-group">
              <label>名称</label>
              <input
                {...register('name', { required: '请输入配置名称' })}
                placeholder="配置名称"
              />
              {errors.name && <span className="error">{errors.name.message}</span>}
            </div>

            <div className="form-group">
              <label>分组</label>
              <input {...register('group')} placeholder="默认" />
            </div>
          </div>

          <div className="form-group">
            <label>启动命令</label>
            <div className="cmd-list">
              {startupCommands.map((cmd, index) => (
                <div
                  key={index}
                  className={`cmd-item ${dragIndex === index ? 'dragging' : ''}`}
                  draggable={dragEnabledIndex === index}
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragEnd={handleDragEnd}
                >
                  <span
                    className="cmd-drag-handle"
                    title="拖拽排序"
                    onMouseDown={() => handleDragHandleMouseDown(index)}
                  >⠿</span>
                  <span className="cmd-num">{index + 1}.</span>
                  <div className="cmd-input-wrapper">
                    <input
                      value={cmd}
                      onChange={(e) => handleCmdInputChange(index, e.target.value)}
                      onFocus={() => setActiveCmdIndex(index)}
                      onBlur={() => setTimeout(() => setCmdSuggestions([]), 200)}
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

          <div className="form-group">
            <label>终端类型</label>
            <div className="radio-group">
              <label>
                <input type="radio" value="powershell" {...register('terminalType')} />
                PowerShell
              </label>
              <label>
                <input type="radio" value="cmd" {...register('terminalType')} />
                CMD
              </label>
            </div>
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
    </div>
  );
};