import { useId, useMemo, useState } from 'react';
import {
  Box,
  ChevronDown,
  ChevronRight,
  Command,
  KeyRound,
  Monitor,
  Network,
  Search,
  Server,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { Profile, TerminalType } from '../types';
import { Dialog } from './Dialog';

interface Props {
  profiles: Profile[];
  loading: boolean;
  error: string;
  busyId: string | null;
  onClose: () => void;
  onSelect: (profile: Profile) => void;
}

const TYPE_INFO: Record<TerminalType, { icon: LucideIcon; label: string }> = {
  powershell: { icon: SquareTerminal, label: 'PowerShell' },
  cmd: { icon: Command, label: 'CMD' },
  ssh: { icon: KeyRound, label: 'SSH' },
  docker: { icon: Box, label: 'Docker' },
  k8s: { icon: Network, label: 'Kubernetes' },
  mstsc: { icon: Monitor, label: '远程桌面' },
};

export function ConnectionPickerDialog({
  profiles,
  loading,
  error,
  busyId,
  onClose,
  onSelect,
}: Props) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    const filtered = keyword
      ? profiles.filter((profile) => {
          const type = TYPE_INFO[profile.terminalType].label;
          return [profile.name, profile.group || '默认', type]
            .some((value) => value.toLocaleLowerCase().includes(keyword));
        })
      : profiles;

    const grouped = new Map<string, Profile[]>();
    for (const profile of filtered) {
      const group = profile.group?.trim() || '默认';
      const items = grouped.get(group);
      if (items) items.push(profile);
      else grouped.set(group, [profile]);
    }

    return Array.from(grouped, ([name, items]) => ({
      name,
      items: items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    })).sort((a, b) => {
      if (a.name === '默认') return -1;
      if (b.name === '默认') return 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [profiles, query]);

  const toggleGroup = (name: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <Dialog title="新建连接" onClose={onClose}>
      <div className="connection-picker">
        <div className="connection-picker-search">
          <Search aria-hidden="true" />
          <label className="sr-only" htmlFor={`${id}-search`}>搜索连接配置</label>
          <input
            id={`${id}-search`}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、分组或类型"
            autoComplete="off"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} title="清除搜索" aria-label="清除搜索">
              <X aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="connection-picker-content">
          {loading ? (
            <div className="connection-picker-state" role="status">正在加载连接配置…</div>
          ) : error ? (
            <div className="connection-picker-state error-state" role="alert">{error}</div>
          ) : profiles.length === 0 ? (
            <div className="connection-picker-state">
              <Server aria-hidden="true" />
              <span>桌面端尚未配置连接</span>
            </div>
          ) : groups.length === 0 ? (
            <div className="connection-picker-state">没有找到匹配的连接</div>
          ) : (
            <div className="connection-picker-groups">
              {groups.map((group, index) => {
                const isCollapsed = collapsed.has(group.name);
                const listId = `${id}-group-${index}`;
                return (
                  <section className="connection-picker-group" key={group.name}>
                    <button
                      type="button"
                      className="connection-picker-group-toggle"
                      onClick={() => toggleGroup(group.name)}
                      aria-expanded={!isCollapsed}
                      aria-controls={listId}
                    >
                      {isCollapsed
                        ? <ChevronRight aria-hidden="true" />
                        : <ChevronDown aria-hidden="true" />}
                      <span>{group.name}</span>
                      <small>{group.items.length}</small>
                    </button>

                    {!isCollapsed && (
                      <div id={listId} className="connection-picker-list">
                        {group.items.map((profile) => {
                          const type = TYPE_INFO[profile.terminalType];
                          const TypeIcon = type.icon;
                          const desktopOnly = profile.terminalType === 'mstsc';
                          const isBusy = busyId === profile.id;
                          return (
                            <button
                              type="button"
                              key={profile.id}
                              className="connection-picker-row"
                              disabled={busyId !== null || desktopOnly}
                              onClick={() => onSelect(profile)}
                              aria-busy={isBusy || undefined}
                            >
                              <span className="connection-picker-type" aria-hidden="true">
                                <TypeIcon />
                              </span>
                              <span className="connection-picker-copy">
                                <strong>{profile.name}</strong>
                                <small>{type.label}</small>
                              </span>
                              <span className={desktopOnly ? 'desktop-only' : ''}>
                                {isBusy ? '连接中…' : desktopOnly ? '仅桌面端' : '连接'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
