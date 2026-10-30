import { FC, useEffect } from 'react';
import { useAppStore } from '../../stores/appStore';
import { openProjectAgentTerminal, openTerminalInDir } from '../../utils/openTerminalInDir';
import { matchingProjectPresets } from '../../utils/startupPresets';
import { projectModelSources, type Project } from '../../types';
import { useAgentAvailability } from '../../hooks/useAgentAvailability';
import { ClaudeModelMenuSection } from './ClaudeModelMenuSection';

interface ProjectLaunchMenuItemsProps {
  /** 目标项目（须已配置路径）。 */
  project: Project;
  /** 任一启动项被点击后的回调，外层负责关闭菜单。 */
  onLaunched: () => void;
}

/**
 * 项目右键菜单的「启动」区：命令行 / 启动参数预设 / Claude·Codex·Pi 模型。
 * 「项目与命令」面板的项目右键和会话标签栏「新建配置终端」的项目悬停菜单共用，
 * 保证两处的启动行为与菜单内容始终同步。
 */
export const ProjectLaunchMenuItems: FC<ProjectLaunchMenuItemsProps> = ({ project, onLaunched }) => {
  const presets = useAppStore(s => s.extraParamPresets);
  const profiles = useAppStore(s => s.profiles);
  const refreshClaudeLaunchTargets = useAppStore(s => s.refreshClaudeLaunchTargets);
  const refreshCodexLaunchTargets = useAppStore(s => s.refreshCodexLaunchTargets);
  const refreshPiModels = useAppStore(s => s.refreshPiModels);
  // 环境检测结果：未安装的 Agent 不出现在项目右键菜单里（检测返回前视为可用）。
  const agentAvailability = useAgentAvailability();

  // 模型菜单数据源：首次打开时加载，之后用缓存（与 HistoryPanel 一致）。
  useEffect(() => {
    const state = useAppStore.getState();
    if (!state.claudeLaunchTargetsLoaded) void refreshClaudeLaunchTargets();
    if (!state.codexProviderState) void refreshCodexLaunchTargets();
    if (!state.piModelsLoaded) void refreshPiModels();
  }, [refreshClaudeLaunchTargets, refreshCodexLaunchTargets, refreshPiModels]);

  useEffect(() => {
    const onChange = () => { void refreshPiModels(true); };
    window.addEventListener('agent-cli-status-changed', onChange);
    return () => window.removeEventListener('agent-cli-status-changed', onChange);
  }, [refreshPiModels]);

  const gotoProvidersSettings = (source: 'claude' | 'codex' | 'pi') => {
    useAppStore.getState().setProviderSettingsTab(source);
    useAppStore.getState().openSettingsDialog('llm-providers');
    onLaunched();
  };

  return (
    <>
      <div className="context-menu-item" onClick={() => {
        onLaunched();
        void openTerminalInDir(project.path, { groupName: project.name }).catch(console.error);
      }}>命令行</div>
      {matchingProjectPresets(presets, profiles, project).map(preset => (
        <div key={preset.id} className="context-menu-item" onClick={() => {
          onLaunched();
          void openTerminalInDir(project.path, {
            command: preset.params,
            groupName: project.name,
            presetTag: preset.name,
            presetTagColor: preset.tagColor,
          }).catch(console.error);
        }}>
          命令行<span
            className="config-nav-preset-chip"
            style={preset.tagColor ? { backgroundColor: preset.tagColor } : undefined}
          >
            {preset.name}
          </span>
        </div>
      ))}
      {projectModelSources(project)
        .filter(source => agentAvailability?.[source] ?? true)
        .map(source => (
          <ClaudeModelMenuSection
            key={source}
            source={source}
            itemClassName="context-menu-item"
            separatorClassName="context-menu-separator"
            title={source === 'claude' ? 'Claude 模型' : source === 'codex' ? 'Codex 模型' : 'Pi 模型'}
            onPickModel={(providerId, modelId, thinking) => {
              onLaunched();
              void openProjectAgentTerminal(project, source, providerId, modelId, thinking);
            }}
            onGotoProviders={() => gotoProvidersSettings(source)}
          />
        ))}
    </>
  );
};
