import type { SlashCatalog } from '../../services/tauri';

export interface SlashCommandItem {
  name: string;
  group: 'skill' | 'builtin';
}

/**
 * `/` 补全候选：`slash_commands` 排除纯 TUI 命令，`skills` 集合内的归入 Skills 组。
 * CLI 每次启动都会刷新清单，前端不硬编码任何命令。
 */
export function filterSlashCommands(catalog: SlashCatalog | null | undefined, query: string): SlashCommandItem[] {
  if (!catalog) return [];
  const terminal = new Set(catalog.terminalSlashCommands);
  const skills = new Set(catalog.skills);
  const normalized = query.trim().toLowerCase();
  return catalog.slashCommands
    .filter(command => !terminal.has(command))
    .filter(command => !normalized || command.toLowerCase().startsWith(normalized))
    .map(command => ({ name: command, group: skills.has(command) ? 'skill' as const : 'builtin' as const }));
}

export function SlashCompletions({
  items,
  activeIndex,
  onPick,
}: {
  items: SlashCommandItem[];
  activeIndex: number;
  onPick: (command: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="agent-slash-menu" role="listbox" aria-label="斜杠命令">
      {items.map((item, index) => (
        <button
          key={item.name}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`agent-slash-item${index === activeIndex ? ' active' : ''}`}
          onMouseDown={event => { event.preventDefault(); onPick(item.name); }}
        >
          <span className="agent-slash-group">{item.group === 'skill' ? 'Skill' : '命令'}</span>
          <span className="agent-slash-name">/{item.name}</span>
        </button>
      ))}
    </div>
  );
}
