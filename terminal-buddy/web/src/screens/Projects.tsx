import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  Server,
  SlidersHorizontal,
  Zap,
} from 'lucide-react';
import { api, type CreateTerminalOptions } from '../api';
import { Dialog } from '../components/Dialog';
import { ExtraParamsDialog } from '../components/ExtraParamsDialog';
import { CodexProvidersPanel } from '../components/CodexProvidersPanel';
import { buildCodexRefCommand, isCodexCommand } from '../utils/codexLaunch';
import { LlmProvidersDialog } from '../components/LlmProvidersDialog';
import { ProfileEditorDialog } from '../components/ProfileEditorDialog';
import { ProjectContextMenu } from '../components/ProjectContextMenu';
import { ProjectEditorDialog } from '../components/ProjectEditorDialog';
import { useLongPressMenu } from '../hooks/useLongPressMenu';
import { useHasHover } from '../hooks/useMediaQuery';
import { useStore } from '../store';
import type { CodexProviderState, ExtraParamPreset, LlmLaunchTarget, Profile, Project, RuntimeInfo } from '../types';
import {
  createProfileFrom,
  effectiveProfilePath,
  isClaudeCommand,
  LOCAL_TYPES,
  matchingPresets,
  modelCommand,
  PINNED_GROUP,
} from '../utils/projects';
import './Projects.css';

type Target = { kind: 'profile'; id: string } | { kind: 'group'; name: string } | { kind: 'blank' };
type Menu = { target: Target; x: number; y: number };
const BADGES: Record<string, string> = {
  powershell: 'PS',
  pwsh: 'PS7',
  cmd: 'CMD',
  bash: 'BASH',
  sh: 'SH',
  zsh: 'ZSH',
  ssh: 'SSH',
  docker: 'DK',
  k8s: 'K8S',
};

function ProfileProperties({ profile, projects }: { profile: Profile; projects: Project[] }) {
  const rows: [string, string][] = [
    ['项目', profile.group || '默认'],
    ['终端类型', profile.terminalType],
  ];
  if (LOCAL_TYPES.includes(profile.terminalType)) {
    rows.push(
      ['起始路径', effectiveProfilePath(profile, projects)],
      ['启动命令', (profile.startupCommands || []).join('\n')],
    );
    const count = Object.keys(profile.environmentVariables || {}).length;
    if (count) rows.push(['环境变量', `${count} 项`]);
  }
  if (profile.terminalType === 'ssh')
    rows.push(
      ['主机地址', profile.sshHost || ''],
      ['端口', String(profile.sshPort || 22)],
      ['用户名', profile.sshUser || ''],
      ['认证方式', profile.sshAuthType === 'password' ? '密码认证' : '密钥认证'],
      ['密钥路径', profile.sshKeyPath || ''],
    );
  if (profile.terminalType === 'docker')
    rows.push(['容器名称', profile.dockerContainerName || profile.dockerContainerId || '']);
  if (profile.terminalType === 'k8s')
    rows.push(
      ['命名空间', profile.k8sNamespace || ''],
      ['Pod 名称', profile.k8sPodName || ''],
      ['容器名称', profile.k8sContainerName || ''],
    );
  return (
    <div className="profile-properties" role="group" aria-label="连接属性">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div className="profile-prop" key={label}>
            <span className="profile-prop-label">{label}</span>
            <span className="profile-prop-value">{value}</span>
          </div>
        ))}
    </div>
  );
}

export default function Projects({ onOpenFiles }: { onOpenFiles: (path: string) => void }) {
  const profiles = useStore((s) => s.profiles);
  const projects = useStore((s) => s.projects);
  const presets = useStore((s) => s.extraParamPresets);
  const hasHover = useHasHover();
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [query, setQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState(new Set([PINNED_GROUP, '服务器工作区']));
  const [expandedProfiles, setExpandedProfiles] = useState(new Set<string>());
  const [selected, setSelected] = useState('');
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editingProfile, setEditingProfile] = useState<{
    profile: Profile | null;
    group?: string;
  } | null>(null);
  const [editingProject, setEditingProject] = useState<{
    project: Project | null;
    name?: string;
  } | null>(null);
  const [renaming, setRenaming] = useState<Profile | null>(null);
  const [rename, setRename] = useState('');
  const [deleting, setDeleting] = useState<Target | null>(null);
  const [managePresets, setManagePresets] = useState(false);
  const [manageModels, setManageModels] = useState<'claude' | 'codex' | null>(null);
  const [codexState, setCodexState] = useState<CodexProviderState | null>(null);
  const [targets, setTargets] = useState<LlmLaunchTarget[]>([]);
  const [modelsError, setModelsError] = useState('');
  const [modelsLoading, setModelsLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [nextProfiles, nextProjects] = await Promise.all([api.getProfiles(), api.getProjects()]);
    useStore.setState({ profiles: nextProfiles, projects: nextProjects });
  }, []);
  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError('');
    try {
      const results = await Promise.allSettled([api.getLlmLaunchTargets(), api.getCodexProviderState()]);
      const [claude, codex] = results;
      if (claude.status === 'fulfilled') setTargets(claude.value);
      if (codex.status === 'fulfilled') setCodexState(codex.value);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    } catch (reason) {
      setModelsError(reason instanceof Error ? reason.message : '加载模型失败');
    } finally {
      setModelsLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh()
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoading(false));
    api
      .getRuntime()
      .then(setRuntime)
      .catch((reason) => setError('读取服务器环境失败：' + String(reason)));
    void refreshModels();
  }, [refresh, refreshModels]);

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setMenu(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const openTerminal = async (profileId: string, options?: CreateTerminalOptions) => {
    const info = await api.createTerminal(profileId, options);
    useStore.getState().setView({
      screen: 'terminal',
      terminalId: info.id,
      profileName: info.profileName,
      loadingMode: info.loadingMode,
      owner: 'web',
    });
  };
  const launchProfile = (profile: Profile, preset?: ExtraParamPreset) =>
    void run(() =>
      openTerminal(
        profile.id,
        preset
          ? {
              extraStartupParams: preset.params,
              extraStartupMode: preset.mode,
              extraParamTag: preset.name,
              extraParamTagColor: preset.tagColor,
            }
          : undefined,
      ),
    );
  const launchProject = (project: Project, preset?: ExtraParamPreset, shellOnly = false) =>
    void run(() =>
      openTerminal('', {
        displayName: project.name,
        startupPath: project.path,
        startupGroup: project.name,
        startupCommand: shellOnly
          ? ''
          : preset?.mode === 'independent'
            ? preset.params
            : [project.startupCommand?.trim(), preset?.params].filter(Boolean).join(' '),
        extraParamTag: preset?.name,
        extraParamTagColor: preset?.tagColor,
      }),
    );
  const openMenu = (target: Target, x: number, y: number) => {
    setMenu({ target, x, y });
    setSelected(target.kind === 'profile' ? target.id : target.kind === 'group' ? target.name : '');
  };
  const bindMenu = useLongPressMenu<Target>(openMenu);
  const toggleGroup = (name: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const addProfile = (group?: string) => {
    setMenu(null);
    setEditingProfile({ profile: null, group });
  };
  const editProject = (name?: string) => {
    setMenu(null);
    setEditingProject({
      project:
        projects.find((p) => p.name === name) ||
        (name ? { name, path: '', startupCommand: '' } : null),
      name,
    });
  };
  const copyPath = (path: string) =>
    void run(async () => {
      try {
        await navigator.clipboard.writeText(path);
      } catch {
        // HTTP 局域网访问也支持复制路径。
        const input = document.createElement('textarea');
        input.value = path;
        input.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.append(input);
        input.select();
        let copied = false;
        try {
          copied = document.execCommand('copy');
        } finally {
          input.remove();
        }
        if (!copied) throw new Error('复制失败，请在配置属性中手动复制路径');
      }
      setNotice('启动路径已复制');
    });

  const groups = useMemo(() => {
    const filtered = profiles.filter((p) => p.terminalType !== 'mstsc');
    const search = query.trim().toLowerCase();
    const matches = (p: Profile) =>
      !search ||
      p.name.toLowerCase().includes(search) ||
      (p.group || '默认').toLowerCase().includes(search) ||
      (p.startupCommands || []).some((c) => c.toLowerCase().includes(search));
    const grouped = new Map<string, Profile[]>();
    for (const project of projects)
      if (
        !search ||
        project.name.toLowerCase().includes(search) ||
        filtered.some((p) => p.group === project.name && matches(p))
      )
        grouped.set(project.name, []);
    for (const profile of filtered.filter((p) => !p.pinned && matches(p))) {
      const name = profile.group?.trim() || '默认';
      grouped.set(name, [...(grouped.get(name) || []), profile]);
    }
    const result = Array.from(grouped, ([name, items]) => ({ name, label: name, items })).sort(
      (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }),
    );
    const pinned = filtered.filter((p) => p.pinned && matches(p));
    if (pinned.length) result.unshift({ name: PINNED_GROUP, label: '置顶', items: pinned });
    return result;
  }, [profiles, projects, query]);
  const menuTarget = menu?.target;
  const menuProfile =
    menuTarget?.kind === 'profile' ? profiles.find((p) => p.id === menuTarget.id) : undefined;
  const menuGroup = menu?.target.kind === 'group' ? menu.target.name : undefined;
  const menuProject = projects.find((p) => p.name === menuGroup);
  const commands = menuProfile?.startupCommands || [menuProject?.startupCommand || ''];
  const availablePresets = matchingPresets(presets, commands);
  const path = menuProfile ? effectiveProfilePath(menuProfile, projects) : menuProject?.path || '';
  const showModels =
    (menuProfile ? LOCAL_TYPES.includes(menuProfile.terminalType) : !!menuProject?.path) &&
    commands.some(command => isClaudeCommand(command) || isCodexCommand(command));
  const modelSources: Array<'claude' | 'codex'> = !showModels ? []
    : commands.some(isClaudeCommand) ? ['claude', 'codex'] : ['codex', 'claude'];
  const codexTargets: LlmLaunchTarget[] = (codexState?.providers ?? []).map(provider => ({
    providerId: provider.id, providerName: provider.name, isDefault: codexState?.activeProviderId === provider.id,
    models: (provider.models ?? [provider.model]).map(id => ({ id, effort: (provider.modelReasoningEfforts[id] ?? 'max') || '默认', contextWindow: provider.contextWindow })),
  }));
  const item = (label: ReactNode, action: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={`context-menu-item${danger ? ' danger' : ''}`}
      disabled={busy}
      onClick={action}
    >
      {label}
    </button>
  );
  const presetItems = (launch: (preset: ExtraParamPreset) => void) =>
    availablePresets.map((p) => (
      <button
        key={p.id}
        role="menuitem"
        className="context-menu-item context-menu-item-preset"
        disabled={busy}
        onClick={() => launch(p)}
      >
        启动
        <span
          className="context-menu-tag-chip"
          style={p.tagColor ? { backgroundColor: p.tagColor } : undefined}
        >
          {p.name}
        </span>
      </button>
    ));
  const modelItems = modelSources.map(source => {
    const useCodex = source === 'codex';
    const menuTargets = useCodex ? codexTargets : targets;
    return (
      <Fragment key={source}>
        <div className="context-menu-separator" role="separator" />
        <div className="project-menu-heading">{useCodex ? 'Codex' : 'Claude'} 模型</div>
        {modelsLoading && <div className="project-menu-heading">加载中…</div>}
        {modelsError && (
          <>
            {item('重新加载模型', () => void refreshModels())}
            <div className="project-menu-error" role="alert">
              {modelsError}
            </div>
          </>
        )}
        {menuTargets.map((target) => (
          <div key={target.providerId}>
            <div className="project-menu-heading">
              {target.providerName}
              {target.isDefault && '（默认）'}
            </div>
            {target.models.map((model) => (
              <button
                type="button"
                role="menuitem"
                key={model.id}
                className="context-menu-item"
                disabled={busy}
                onClick={() =>
                  void run(() => {
                    const command = useCodex ? buildCodexRefCommand(target.providerId, model.id, commands) : modelCommand(target.providerId, model.id, commands);
                    return menuProfile
                      ? openTerminal(menuProfile.id, {
                          extraStartupParams: command,
                          extraStartupMode: 'independent',
                        })
                      : openTerminal('', {
                          displayName: menuProject!.name,
                          startupPath: menuProject!.path,
                          startupGroup: menuProject!.name,
                          startupCommand: command,
                        });
                  })
                }
              >
                <span className="project-menu-model">{model.id}</span>
                <small>{model.effort}</small>
              </button>
            ))}
          </div>
        ))}
        {item('配置模型供应商…', () => {
          setMenu(null);
          setManageModels(source);
        })}
      </Fragment>
    );
  });
  const blankBind = bindMenu({ kind: 'blank' });
  const hasGroupProfiles =
    menuGroup !== undefined && profiles.some((p) => (p.group?.trim() || '默认') === menuGroup);

  return (
    <div className="projects-screen">
      <div className="projects-toolbar">
        <label className="projects-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索项目与命令"
            placeholder="搜索项目、配置或命令"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          className="icon-button"
          title="添加项目或配置"
          aria-label="添加项目或配置"
          onClick={(e) =>
            openMenu(
              { kind: 'blank' },
              e.currentTarget.getBoundingClientRect().left,
              e.currentTarget.getBoundingClientRect().bottom,
            )
          }
        >
          <Plus size={18} />
        </button>
        <button
          className="icon-button"
          title="启动参数管理"
          aria-label="启动参数管理"
          onClick={() => setManagePresets(true)}
        >
          <SlidersHorizontal size={18} />
        </button>
      </div>
      {error && (
        <div className="nav-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="project-notice" role="status">
          {notice}
        </div>
      )}
      {busy && (
        <div className="project-notice" role="status">
          处理中…
        </div>
      )}
      <div
        className="profile-tree projects-tree"
        aria-label="项目与命令列表"
        {...blankBind}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) blankBind.onPointerDown(e);
        }}
      >
        {loading ? (
          <div className="session-empty-state">加载中…</div>
        ) : !groups.length ? (
          <div className="session-empty-state">
            <Server aria-hidden="true" />
            <strong>{query ? '没有匹配的项目或配置' : '暂无项目与配置'}</strong>
            {!query && (
              <button className="btn primary" onClick={() => editProject()}>
                添加项目
              </button>
            )}
          </div>
        ) : (
          groups.map((group) => {
            const expanded = !!query.trim() || expandedGroups.has(group.name);
            const project = projects.find((p) => p.name === group.name && p.path);
            return (
              <div className="tree-node" key={group.name}>
                <div
                  className={`tree-item${selected === group.name ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  style={{ paddingLeft: 8 }}
                  {...(group.name === PINNED_GROUP
                    ? {}
                    : bindMenu({ kind: 'group', name: group.name }))}
                  onClick={() => {
                    toggleGroup(group.name);
                    setSelected(group.name);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleGroup(group.name);
                    }
                    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      if (group.name !== PINNED_GROUP)
                        openMenu({ kind: 'group', name: group.name }, rect.left, rect.bottom);
                    }
                  }}
                >
                  <span className={`tree-arrow${expanded ? ' expanded' : ''}`}>
                    <ChevronRight size={12} aria-hidden="true" />
                  </span>
                  {group.name === PINNED_GROUP && <Pin size={13} aria-hidden="true" />}
                  <span className="tree-name">{group.label}</span>
                  <span className="tree-item-end">
                    <span className="tree-item-count">{group.items.length}</span>
                    {project && (
                      <button
                        className="tree-item-launch"
                        aria-label={`启动项目 ${project.name}`}
                        title={`启动项目 ${project.name}`}
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          openMenu({ kind: 'group', name: group.name }, e.clientX, e.clientY);
                        }}
                      >
                        <Zap size={15} />
                      </button>
                    )}
                    {group.name !== PINNED_GROUP && (
                      <button
                        className="project-more"
                        aria-label={`项目操作 ${group.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          openMenu({ kind: 'group', name: group.name }, rect.left, rect.bottom);
                        }}
                      >
                        <MoreHorizontal size={17} />
                      </button>
                    )}
                  </span>
                </div>
                {expanded && (
                  <div className="tree-children">
                    {group.items.map((profile) => (
                      <div className="tree-node" key={profile.id}>
                        <div
                          className={`tree-item${selected === profile.id ? ' selected' : ''}`}
                          role="button"
                          tabIndex={0}
                          style={{ paddingLeft: 20 }}
                          aria-label={profile.name}
                          aria-busy={busy || undefined}
                          {...bindMenu({ kind: 'profile', id: profile.id })}
                          onClick={() => {
                            setSelected(profile.id);
                            if (!hasHover) launchProfile(profile);
                          }}
                          onDoubleClick={() => {
                            if (hasHover) launchProfile(profile);
                          }}
                          onKeyDown={(e) => {
                            if (e.target !== e.currentTarget) return;
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              launchProfile(profile);
                            }
                            if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                              e.preventDefault();
                              const rect = e.currentTarget.getBoundingClientRect();
                              openMenu({ kind: 'profile', id: profile.id }, rect.left, rect.bottom);
                            }
                          }}
                        >
                          <button
                            className={`tree-arrow${expandedProfiles.has(profile.id) ? ' expanded' : ''}`}
                            aria-label={`${expandedProfiles.has(profile.id) ? '收起' : '展开'}属性 ${profile.name}`}
                            aria-expanded={expandedProfiles.has(profile.id)}
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedProfiles((prev) => {
                                const next = new Set(prev);
                                if (next.has(profile.id)) next.delete(profile.id);
                                else next.add(profile.id);
                                return next;
                              });
                            }}
                          >
                            <ChevronRight size={12} />
                          </button>
                          <span
                            className="config-nav-icon-type"
                            style={profile.tabColor ? { color: profile.tabColor } : undefined}
                          >
                            {BADGES[profile.terminalType] || profile.terminalType.toUpperCase()}
                          </span>
                          <span className="tree-name">{profile.name}</span>
                          <span className="tree-item-end">
                            <button
                              className="project-more"
                              aria-label={`配置操作 ${profile.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                const rect = e.currentTarget.getBoundingClientRect();
                                openMenu(
                                  { kind: 'profile', id: profile.id },
                                  rect.left,
                                  rect.bottom,
                                );
                              }}
                            >
                              <MoreHorizontal size={17} />
                            </button>
                          </span>
                        </div>
                        {expandedProfiles.has(profile.id) && (
                          <ProfileProperties profile={profile} projects={projects} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      {menu && (
        <ProjectContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menuProfile ? (
            <>
              {item('启动', () => launchProfile(menuProfile))}
              {presetItems((p) => launchProfile(menuProfile, p))}
              {item(
                '命令行',
                () => void run(() => openTerminal('', { startupPath: path || undefined })),
              )}
              {modelItems}
              {item('添加配置', () => addProfile(menuProfile.group || '默认'))}
              {LOCAL_TYPES.includes(menuProfile.terminalType) && path && (
                <>
                  {item('打开目录', () => {
                    setMenu(null);
                    onOpenFiles(path);
                  })}
                  {item('复制启动路径', () => copyPath(path))}
                </>
              )}
              {item('编辑', () => {
                setMenu(null);
                setEditingProfile({ profile: menuProfile });
              })}
              {item(
                menuProfile.pinned ? '取消置顶' : '置顶',
                () =>
                  void run(async () => {
                    await api.updateProfile({ ...menuProfile, pinned: !menuProfile.pinned });
                    await refresh();
                  }),
              )}
              {item(
                '复制',
                () =>
                  void run(async () => {
                    await createProfileFrom({
                      ...menuProfile,
                      name: `${menuProfile.name} (副本)`,
                      pinned: false,
                    });
                    await refresh();
                  }),
              )}
              {item('重命名', () => {
                setMenu(null);
                setRenaming(menuProfile);
                setRename(menuProfile.name);
              })}
              {item(
                '删除',
                () => {
                  setMenu(null);
                  setDeleting({ kind: 'profile', id: menuProfile.id });
                },
                true,
              )}
            </>
          ) : menuGroup !== undefined ? (
            <>
              {menuProject?.path && (
                <>
                  {item('启动项目', () => launchProject(menuProject))}
                  {presetItems((p) => launchProject(menuProject, p))}
                  {item('命令行', () => launchProject(menuProject, undefined, true))}
                  {modelItems}
                  <div className="context-menu-separator" role="separator" />
                  {item('打开目录', () => {
                    setMenu(null);
                    onOpenFiles(menuProject.path);
                  })}
                  {item('复制启动路径', () => copyPath(menuProject.path))}
                </>
              )}
              {item('添加配置', () => addProfile(menuGroup))}
              {item('编辑项目', () => editProject(menuGroup))}
              {!hasGroupProfiles &&
                menuProject &&
                item(
                  '删除项目',
                  () => {
                    setMenu(null);
                    setDeleting({ kind: 'group', name: menuGroup });
                  },
                  true,
                )}
            </>
          ) : (
            <>
              {item('添加配置', () => addProfile(projects.find((p) => p.path)?.name))}
              {item('添加项目', () => editProject())}
              {item('启动参数管理', () => {
                setMenu(null);
                setManagePresets(true);
              })}
              {item('模型供应商', () => {
                setMenu(null);
                setManageModels('claude');
              })}
            </>
          )}
        </ProjectContextMenu>
      )}
      {editingProfile && (
        <ProfileEditorDialog
          profile={editingProfile.profile}
          defaultGroup={editingProfile.group}
          projects={projects}
          defaultShell={runtime?.defaultTerminalType || 'bash'}
          windows={runtime?.platform === 'windows'}
          onSaved={refresh}
          onClose={() => setEditingProfile(null)}
        />
      )}
      {editingProject && (
        <ProjectEditorDialog
          original={editingProject.project}
          defaultName={editingProject.name}
          projects={projects}
          profiles={profiles}
          windows={runtime?.platform === 'windows'}
          onSaved={refresh}
          onClose={() => setEditingProject(null)}
        />
      )}
      {renaming && (
        <Dialog
          title="重命名配置"
          onClose={() => {
            if (!busy) setRenaming(null);
          }}
          footer={
            <>
              <button className="btn" disabled={busy} onClick={() => setRenaming(null)}>
                取消
              </button>
              <button
                className="btn primary"
                disabled={busy || !rename.trim()}
                type="submit"
                form="mobile-profile-rename"
              >
                保存
              </button>
            </>
          }
        >
          <form
            id="mobile-profile-rename"
            className="project-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.updateProfile({ ...renaming, name: rename.trim() });
                await refresh();
                setRenaming(null);
              });
            }}
          >
            <label>
              配置名称
              <input
                required
                value={rename}
                disabled={busy}
                onChange={(e) => setRename(e.target.value)}
              />
            </label>
            {error && (
              <div className="nav-error" role="alert">
                {error}
              </div>
            )}
          </form>
        </Dialog>
      )}
      {deleting && (
        <Dialog
          title={deleting.kind === 'profile' ? '删除配置' : '删除项目'}
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
          footer={
            <>
              <button className="btn" disabled={busy} onClick={() => setDeleting(null)}>
                取消
              </button>
              <button
                className="btn danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (deleting.kind === 'profile') await api.deleteProfile(deleting.id);
                    else if (deleting.kind === 'group') {
                      const [latestProfiles, latestProjects] = await Promise.all([
                        api.getProfiles(),
                        api.getProjects(),
                      ]);
                      if (latestProfiles.some((p) => (p.group?.trim() || '默认') === deleting.name))
                        throw new Error('项目下仍有配置，请先移动或删除配置');
                      await api.saveProjects(
                        latestProjects.filter((p) => p.name !== deleting.name && p.path.trim()),
                      );
                    }
                    await refresh();
                    setDeleting(null);
                  })
                }
              >
                删除
              </button>
            </>
          }
        >
          <p>
            确定删除“
            {deleting.kind === 'profile'
              ? profiles.find((p) => p.id === deleting.id)?.name
              : deleting.kind === 'group'
                ? deleting.name
                : ''}
            ”？{deleting.kind === 'group' && '项目目录中的文件会保留。'}
          </p>
          {error && (
            <div className="nav-error" role="alert">
              {error}
            </div>
          )}
        </Dialog>
      )}
      {managePresets && <ExtraParamsDialog onClose={() => setManagePresets(false)} />}
      {manageModels === 'claude' && (
        <LlmProvidersDialog onClose={() => setManageModels(null)} onChanged={refreshModels} />
      )}
      {manageModels === 'codex' && <CodexProvidersPanel active onClose={() => { setManageModels(null); void refreshModels(); }} />}
    </div>
  );
}
