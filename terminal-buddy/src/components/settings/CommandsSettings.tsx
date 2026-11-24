import { FC, type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
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

const ALL_CATEGORIES_ID = '__all__';

export const CommandsSettings: FC<CommandsSettingsProps> = ({ askConfirm, dismissConfirm }) => {
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<string>(ALL_CATEGORIES_ID);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; cmd: CommandItem; category: string } | null>(null);
  const [overrides, setOverrides] = useState<Record<string, CmdOverride>>(getCmdOverrides);
  const [customCommands, setCustomCommands] = useState<CommandItem[]>(getCustomCommands);
  const [editingCommand, setEditingCommand] = useState<string | null>(null);
  const [editDescription, setEditDescription] = useState('');
  const [addingCustom, setAddingCustom] = useState(false);
  const [newCommand, setNewCommand] = useState({ command: '', desc: '' });
  const categoryButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const templates = useMemo(() => getEffectiveTemplates(), [customCommands, overrides]);

  // 写入侧已把 key 归一为 trim 后的命令；读取侧必须同样归一，否则 'ping '
  // 这类内置命令的「隐藏/改说明」会出现「写了但不生效、无法恢复」。
  const overrideFor = (command: string) => overrides[command.trim()];

  const trimmedSearch = search.trim();

  const categoriesWithMatches = useMemo(() => {
    const q = trimmedSearch.toLowerCase();
    return templates.map(category => {
      const commands = q
        ? category.commands.filter(command => {
            const desc = overrideFor(command.command)?.desc ?? command.desc;
            return (
              command.command.toLowerCase().includes(q)
              || desc.toLowerCase().includes(q)
              || category.category.toLowerCase().includes(q)
            );
          })
        : category.commands.filter(command => !overrideFor(command.command)?.hidden);
      return {
        category: category.category,
        commands,
      };
    });
  }, [overrides, templates, trimmedSearch]);

  const totalMatchedCount = useMemo(
    () => categoriesWithMatches.reduce((sum, item) => sum + item.commands.length, 0),
    [categoriesWithMatches],
  );

  const visibleRows = useMemo(() => {
    const source = activeTab === ALL_CATEGORIES_ID
      ? categoriesWithMatches
      : categoriesWithMatches.filter(item => item.category === activeTab);
    return source.flatMap(item => item.commands.map(command => ({ category: item.category, command })));
  }, [activeTab, categoriesWithMatches]);

  const navOrder = useMemo(
    () => [ALL_CATEGORIES_ID, ...templates.map(item => item.category)],
    [templates],
  );

  useEffect(() => {
    if (activeTab !== ALL_CATEGORIES_ID && !templates.some(item => item.category === activeTab)) {
      setActiveTab(ALL_CATEGORIES_ID);
    }
  }, [activeTab, templates]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const nextTrimmed = value.trim().toLowerCase();
    if (!nextTrimmed || activeTab === ALL_CATEGORIES_ID) return;
    const currentCategory = templates.find(item => item.category === activeTab);
    const hasMatchInCurrent = currentCategory?.commands.some(command => {
      const desc = overrideFor(command.command)?.desc ?? command.desc;
      return (
        command.command.toLowerCase().includes(nextTrimmed)
        || desc.toLowerCase().includes(nextTrimmed)
        || currentCategory.category.toLowerCase().includes(nextTrimmed)
      );
    });
    if (!hasMatchInCurrent) {
      const hasAnyMatch = templates.some(item =>
        item.commands.some(command => {
          const desc = overrideFor(command.command)?.desc ?? command.desc;
          return (
            command.command.toLowerCase().includes(nextTrimmed)
            || desc.toLowerCase().includes(nextTrimmed)
            || item.category.toLowerCase().includes(nextTrimmed)
          );
        }),
      );
      if (hasAnyMatch) setActiveTab(ALL_CATEGORIES_ID);
    }
  };

  const handleCategoryKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, currentId: string) => {
    const currentIndex = navOrder.indexOf(currentId);
    if (currentIndex === -1 || navOrder.length === 0) return;

    let targetIndex: number | null = null;
    if (event.key === 'ArrowDown') targetIndex = (currentIndex + 1) % navOrder.length;
    else if (event.key === 'ArrowUp') targetIndex = (currentIndex - 1 + navOrder.length) % navOrder.length;
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = navOrder.length - 1;
    if (targetIndex === null) return;

    event.preventDefault();
    const targetId = navOrder[targetIndex];
    setActiveTab(targetId);
    categoryButtonRefs.current[targetId]?.focus();
  };

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
    if (override?.hidden) {
      const { hidden: _, ...rest } = override;
      if (Object.keys(rest).length > 0) next[key] = rest;
      else delete next[key];
    } else {
      next[key] = { ...override, hidden: true };
    }
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

  const submitCustomCommand = () => {
    if (!newCommand.command.trim()) return;
    const command = newCommand.command.trim();
    const next = [...customCommands, { name: command, command, desc: newCommand.desc.trim() || '自定义命令' }];
    setCustomCommands(next);
    saveCustomCommands(next);
    setNewCommand({ command: '', desc: '' });
    setAddingCustom(false);
    setActiveTab('自定义');
  };

  const showCategoryTag = activeTab === ALL_CATEGORIES_ID || Boolean(trimmedSearch);

  return (
    <div className="commands-panel">
      <div className="commands-toolbar">
        <div className="commands-search-wrap">
          <Search size={13} aria-hidden="true" />
          <input
            className="tb-input commands-search"
            type="text"
            placeholder="搜索命令、分类或说明…"
            value={search}
            onChange={event => handleSearchChange(event.target.value)}
          />
          {search && (
            <button
              className="commands-search-clear"
              type="button"
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => setSearch('')}
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
        <button className="btn-primary" type="button" onClick={() => setAddingCustom(true)}>
          <Plus size={15} aria-hidden="true" />
          添加自定义命令
        </button>
      </div>

      {addingCustom && (
        <div className="cmd-add-form">
          <input
            className="tb-input mono"
            placeholder="命令（例如 docker ps -a）"
            value={newCommand.command}
            onChange={event => setNewCommand({ ...newCommand, command: event.target.value })}
            onKeyDown={event => {
              if (event.key === 'Enter') submitCustomCommand();
              else if (event.key === 'Escape') setAddingCustom(false);
            }}
            autoFocus
          />
          <input
            className="tb-input"
            placeholder="说明"
            value={newCommand.desc}
            onChange={event => setNewCommand({ ...newCommand, desc: event.target.value })}
            onKeyDown={event => {
              if (event.key === 'Enter') submitCustomCommand();
              else if (event.key === 'Escape') setAddingCustom(false);
            }}
          />
          <button className="btn-primary btn-sm" type="button" onClick={submitCustomCommand}>添加</button>
          <button className="btn-secondary btn-sm" type="button" onClick={() => setAddingCustom(false)}>取消</button>
        </div>
      )}

      <div className="settings-split-wrap">
        <div className="settings-card-group settings-list-card settings-split-card">
          <aside className="settings-split-sidebar" aria-label="命令模板分类">
            <div className="settings-split-sidebar-header">
              <span className="settings-split-sidebar-title">命令分类</span>
              <span className="settings-split-sidebar-extra">{templates.length} 类</span>
            </div>

            <div className="settings-split-nav" role="tablist" aria-label="命令分类" aria-orientation="vertical">
              <button
                ref={el => { categoryButtonRefs.current[ALL_CATEGORIES_ID] = el; }}
                className={`settings-split-nav-item ${activeTab === ALL_CATEGORIES_ID ? 'active' : ''}`}
                type="button"
                role="tab"
                aria-selected={activeTab === ALL_CATEGORIES_ID}
                tabIndex={activeTab === ALL_CATEGORIES_ID ? 0 : -1}
                onClick={() => setActiveTab(ALL_CATEGORIES_ID)}
                onKeyDown={event => handleCategoryKeyDown(event, ALL_CATEGORIES_ID)}
              >
                <span className="settings-split-nav-label">全部命令</span>
                <span className="cmd-tab-count">{totalMatchedCount}</span>
              </button>

              {categoriesWithMatches.length > 0 && <div className="settings-split-nav-divider" role="separator" />}

              {categoriesWithMatches.map(({ category, commands }) => {
                const isActive = activeTab === category;
                const isZero = Boolean(trimmedSearch) && commands.length === 0;
                return (
                  <button
                    key={category}
                    ref={el => { categoryButtonRefs.current[category] = el; }}
                    className={`settings-split-nav-item ${isActive ? 'active' : ''}${isZero ? ' is-zero' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    title={category}
                    onClick={() => setActiveTab(category)}
                    onKeyDown={event => handleCategoryKeyDown(event, category)}
                  >
                    <span className="settings-split-nav-label">{category}</span>
                    <span className="cmd-tab-count">{commands.length}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="settings-split-main">
            <div className="settings-split-main-header">
              <div className="settings-split-main-title-wrap">
                <span className="settings-split-main-title">
                  {activeTab === ALL_CATEGORIES_ID ? '全部命令' : activeTab}
                </span>
              </div>
              <div className="settings-split-main-meta">
                <span className="settings-split-count-text">共 {visibleRows.length} 条</span>
              </div>
            </div>

            <div className="commands-list">
              {visibleRows.map(({ category, command }) => {
                const override = overrideFor(command.command);
                const isCustom = category === '自定义';
                const isEditing = editingCommand === command.command;
                return (
                  <div
                    key={`${category}::${command.command}`}
                    className={`cmd-cat-item settings-list-row ${contextMenu?.cmd.command === command.command && contextMenu?.category === category ? 'selected' : ''}`}
                    onContextMenu={event => {
                      event.preventDefault();
                      setContextMenu({ x: event.clientX, y: event.clientY, cmd: command, category });
                    }}
                  >
                    <code className="rule-code cmd-cat-code" title={command.command}>{command.command}</code>
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
                      <span className="cmd-cat-desc" title={override?.desc ?? command.desc}>
                        {override?.desc ?? command.desc}
                      </span>
                    )}
                    {showCategoryTag && !isEditing && (
                      <span className="profile-group-tag" title={`分类：${category}`}>
                        {category}
                      </span>
                    )}
                    <div className="cmd-cat-actions visible-actions">
                      <button
                        className="btn-secondary btn-sm"
                        type="button"
                        title="编辑说明"
                        aria-label={`编辑命令 ${command.command}`}
                        onClick={() => startEditing(command)}
                      >
                        <Pencil size={13} aria-hidden="true" />
                        改说明
                      </button>
                      {isCustom ? (
                        <button
                          className="btn-danger-outline btn-sm"
                          type="button"
                          title="删除"
                          aria-label={`删除命令 ${command.command}`}
                          onClick={() => deleteCustomCommand(command)}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                          删除
                        </button>
                      ) : (
                        <button
                          className={`btn-ghost btn-sm ${override?.hidden ? 'restore' : ''}`}
                          type="button"
                          title={override?.hidden ? '恢复显示' : '隐藏'}
                          aria-label={`${override?.hidden ? '恢复显示' : '隐藏'}命令 ${command.command}`}
                          onClick={() => toggleHidden(command)}
                        >
                          {override?.hidden ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
                          {override?.hidden ? '恢复' : '隐藏'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {visibleRows.length === 0 && (
                <div className="settings-empty-state">
                  {trimmedSearch ? '没有找到匹配的命令' : '暂无命令模板'}
                </div>
              )}
            </div>
          </div>
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
