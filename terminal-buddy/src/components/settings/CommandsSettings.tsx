import { FC, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  getCmdOverrides,
  getCustomCommands,
  getEffectiveTemplates,
  saveCmdOverrides,
  saveCustomCommands,
  type CmdOverride,
  type CommandItem,
} from '../../data/commandTemplates';

interface CommandsSettingsProps {
  askConfirm: (message: string, onConfirm: () => void) => void;
  dismissConfirm: () => void;
}

export const CommandsSettings: FC<CommandsSettingsProps> = ({ askConfirm, dismissConfirm }) => {
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; cmd: CommandItem; category: string } | null>(null);
  const [overrides, setOverrides] = useState<Record<string, CmdOverride>>(getCmdOverrides);
  const [customCommands, setCustomCommands] = useState<CommandItem[]>(getCustomCommands);
  const [editingCommand, setEditingCommand] = useState<string | null>(null);
  const [editDescription, setEditDescription] = useState('');
  const [addingCustom, setAddingCustom] = useState(false);
  const [newCommand, setNewCommand] = useState({ command: '', desc: '' });

  const templates = useMemo(() => getEffectiveTemplates(), [customCommands, overrides]);

  useEffect(() => {
    if (!activeTab && templates.length > 0) setActiveTab(templates[0].category);
  }, [activeTab, templates]);

  const updateOverrides = (next: Record<string, CmdOverride>) => {
    setOverrides(next);
    saveCmdOverrides(next);
  };

  const deleteCustomCommand = (command: CommandItem) => {
    askConfirm(`确定删除自定义命令「${command.command}」？`, () => {
      dismissConfirm();
      const next = customCommands.filter(item => item.command !== command.command);
      setCustomCommands(next);
      saveCustomCommands(next);
    });
  };

  const toggleHidden = (command: CommandItem) => {
    const override = overrides[command.command];
    const next = { ...overrides };
    if (override?.hidden) delete next[command.command];
    else next[command.command] = { ...override, hidden: true };
    updateOverrides(next);
  };

  const startEditing = (command: CommandItem) => {
    setEditingCommand(command.command);
    setEditDescription(overrides[command.command]?.desc ?? command.desc);
  };

  const saveDescription = (command: CommandItem) => {
    updateOverrides({
      ...overrides,
      [command.command]: { ...overrides[command.command], desc: editDescription },
    });
    setEditingCommand(null);
  };

  const visibleCategories = search
    ? templates.map(category => ({
        ...category,
        commands: category.commands.filter(command =>
          command.command.toLowerCase().includes(search.toLowerCase()) ||
          command.desc.toLowerCase().includes(search.toLowerCase())
        ),
      })).filter(category => category.commands.length > 0)
    : templates.filter(category => category.category === activeTab);

  return (
    <div className="commands-panel">
      <div className="commands-toolbar">
        <input
          className="commands-search"
          type="text"
          placeholder="搜索命令..."
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <button className="settings-add-btn" type="button" onClick={() => setAddingCustom(true)}>
          <Plus size={15} aria-hidden="true" />
          自定义
        </button>
      </div>

      {addingCustom && (
        <div className="cmd-add-form">
          <input placeholder="命令" value={newCommand.command} onChange={event => setNewCommand({ ...newCommand, command: event.target.value })} />
          <input placeholder="说明" value={newCommand.desc} onChange={event => setNewCommand({ ...newCommand, desc: event.target.value })} />
          <button className="btn-primary" type="button" onClick={() => {
            if (!newCommand.command.trim()) return;
            const command = newCommand.command.trim();
            const next = [...customCommands, { name: command, command, desc: newCommand.desc.trim() || '自定义命令' }];
            setCustomCommands(next);
            saveCustomCommands(next);
            setNewCommand({ command: '', desc: '' });
            setAddingCustom(false);
          }}>添加</button>
          <button className="btn-secondary" type="button" onClick={() => setAddingCustom(false)}>取消</button>
        </div>
      )}

      {!search && (
        <div className="cmd-tabs">
          {templates.map(category => (
            <button
              key={category.category}
              className={`cmd-tab ${activeTab === category.category ? 'active' : ''}`}
              type="button"
              onClick={() => setActiveTab(category.category)}
            >
              {category.category}
              <span className="cmd-tab-count">{category.commands.filter(command => !overrides[command.command]?.hidden).length}</span>
            </button>
          ))}
        </div>
      )}

      <div className="commands-list">
        {visibleCategories.map(category => (
          <div key={category.category} className="cmd-cat-items">
            {category.commands.map(command => {
              const override = overrides[command.command];
              if (!search && override?.hidden) return null;
              const isCustom = category.category === '自定义';
              const isEditing = editingCommand === command.command;
              return (
                <div
                  key={command.command}
                  className={`cmd-cat-item ${contextMenu?.cmd.command === command.command ? 'selected' : ''}`}
                  onContextMenu={event => {
                    event.preventDefault();
                    setContextMenu({ x: event.clientX, y: event.clientY, cmd: command, category: category.category });
                  }}
                >
                  <code className="cmd-cat-cmd">{command.command}</code>
                  {isEditing ? (
                    <input
                      className="cmd-edit-input"
                      value={editDescription}
                      onChange={event => setEditDescription(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') saveDescription(command);
                        else if (event.key === 'Escape') setEditingCommand(null);
                      }}
                      onBlur={() => saveDescription(command)}
                      autoFocus
                    />
                  ) : (
                    <span className="cmd-cat-desc">{override?.desc ?? command.desc}</span>
                  )}
                  <div className="cmd-cat-actions">
                    <button className="cmd-action-btn" type="button" title="编辑说明" aria-label={`编辑命令 ${command.command}`} onClick={() => startEditing(command)}>
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                    {isCustom ? (
                      <button className="cmd-action-btn danger" type="button" title="删除" aria-label={`删除命令 ${command.command}`} onClick={() => deleteCustomCommand(command)}>
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    ) : (
                      <button className={`cmd-action-btn ${override?.hidden ? 'restore' : ''}`} type="button" title={override?.hidden ? '恢复显示' : '隐藏'} aria-label={`${override?.hidden ? '恢复显示' : '隐藏'}命令 ${command.command}`} onClick={() => toggleHidden(command)}>
                        {override?.hidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {contextMenu && <div className="context-menu-overlay" onClick={() => setContextMenu(null)} />}
      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <div className="context-menu-item" onClick={() => {
            const command = contextMenu.cmd;
            setContextMenu(null);
            startEditing(command);
          }}>编辑</div>
          {contextMenu.category === '自定义' ? (
            <div className="context-menu-item danger" onClick={() => {
              const command = contextMenu.cmd;
              setContextMenu(null);
              deleteCustomCommand(command);
            }}>删除</div>
          ) : (
            <div className="context-menu-item" onClick={() => {
              const command = contextMenu.cmd;
              setContextMenu(null);
              toggleHidden(command);
            }}>{overrides[contextMenu.cmd.command]?.hidden ? '恢复显示' : '隐藏'}</div>
          )}
        </div>
      )}
    </div>
  );
};
