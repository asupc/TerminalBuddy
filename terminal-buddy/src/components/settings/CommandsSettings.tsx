import { FC, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Pencil, Plus, Search, Trash2 } from 'lucide-react';
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

  // 写入侧已把 key 归一为 trim 后的命令；读取侧必须同样归一，否则 'ping '
  // 这类内置命令的「隐藏/改说明」会出现「写了但不生效、无法恢复」。
  const overrideFor = (command: string) => overrides[command.trim()];

  useEffect(() => {
    if (!activeTab && templates.length > 0) setActiveTab(templates[0].category);
  }, [activeTab, templates]);

  const updateOverrides = (next: Record<string, CmdOverride>) => {
    // key 归一 trim（审查 M-26）：内置命令如 'ping ' 带尾随空格，而读取侧
    // 全部按 trim 匹配，写入不 trim 会让「隐藏/改说明」对这批内置命令失效。
    const normalized: Record<string, CmdOverride> = {};
    for (const [key, value] of Object.entries(next)) {
      normalized[key.trim()] = value;
    }
    setOverrides(normalized);
    saveCmdOverrides(normalized);
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
    const key = command.command.trim();
    const override = overrideFor(key);
    const next = { ...overrides };
    if (override?.hidden) delete next[key];
    else next[key] = { ...override, hidden: true };
    updateOverrides(next);
  };

  const startEditing = (command: CommandItem) => {
    setEditingCommand(command.command);
    setEditDescription(overrideFor(command.command)?.desc ?? command.desc);
  };

  const saveDescription = (command: CommandItem) => {
    updateOverrides({
      ...overrides,
      [command.command.trim()]: { ...overrideFor(command.command), desc: editDescription },
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
        <div className="commands-search-wrap">
          <Search size={13} aria-hidden="true" />
          <input
            className="tb-input commands-search"
            type="text"
            placeholder="搜索命令或说明…"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </div>
        <button className="btn-primary" type="button" onClick={() => setAddingCustom(true)}>
          <Plus size={15} aria-hidden="true" />
          添加自定义命令
        </button>
      </div>

      {addingCustom && (
        <div className="cmd-add-form">
          <input className="tb-input mono" placeholder="命令（例如 docker ps -a）" value={newCommand.command} onChange={event => setNewCommand({ ...newCommand, command: event.target.value })} />
          <input className="tb-input" placeholder="说明" value={newCommand.desc} onChange={event => setNewCommand({ ...newCommand, desc: event.target.value })} />
          <button className="btn-primary btn-sm" type="button" onClick={() => {
            if (!newCommand.command.trim()) return;
            const command = newCommand.command.trim();
            const next = [...customCommands, { name: command, command, desc: newCommand.desc.trim() || '自定义命令' }];
            setCustomCommands(next);
            saveCustomCommands(next);
            setNewCommand({ command: '', desc: '' });
            setAddingCustom(false);
          }}>添加</button>
          <button className="btn-secondary btn-sm" type="button" onClick={() => setAddingCustom(false)}>取消</button>
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
              <span className="cmd-tab-count">{category.commands.filter(command => !overrideFor(command.command)?.hidden).length}</span>
            </button>
          ))}
        </div>
      )}

      <div className="settings-card-group settings-list-card">
        <div className="commands-list">
          {visibleCategories.map(category => (
            <div key={category.category} className="cmd-cat-items">
              {category.commands.map(command => {
                const override = overrideFor(command.command);
                if (!search && override?.hidden) return null;
                const isCustom = category.category === '自定义';
                const isEditing = editingCommand === command.command;
                return (
                  <div
                    key={command.command}
                    className={`cmd-cat-item settings-list-row ${contextMenu?.cmd.command === command.command ? 'selected' : ''}`}
                    onContextMenu={event => {
                      event.preventDefault();
                      setContextMenu({ x: event.clientX, y: event.clientY, cmd: command, category: category.category });
                    }}
                  >
                    <code className="rule-code cmd-cat-code">{command.command}</code>
                    {isEditing ? (
                      <input
                        className="tb-input cmd-edit-input"
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
                    <div className="cmd-cat-actions visible-actions">
                      <button className="btn-secondary btn-sm" type="button" title="编辑说明" aria-label={`编辑命令 ${command.command}`} onClick={() => startEditing(command)}>
                        <Pencil size={13} aria-hidden="true" />
                        改说明
                      </button>
                      {isCustom ? (
                        <button className="btn-danger-outline btn-sm" type="button" title="删除" aria-label={`删除命令 ${command.command}`} onClick={() => deleteCustomCommand(command)}>
                          <Trash2 size={13} aria-hidden="true" />
                          删除
                        </button>
                      ) : (
                        <button className={`btn-ghost btn-sm ${override?.hidden ? 'restore' : ''}`} type="button" title={override?.hidden ? '恢复显示' : '隐藏'} aria-label={`${override?.hidden ? '恢复显示' : '隐藏'}命令 ${command.command}`} onClick={() => toggleHidden(command)}>
                          {override?.hidden ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
                          {override?.hidden ? '恢复' : '隐藏'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
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
            }}>{overrideFor(contextMenu.cmd.command)?.hidden ? '恢复显示' : '隐藏'}</div>
          )}
        </div>
      )}
    </div>
  );
};
