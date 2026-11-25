import { FC, useEffect } from 'react';
import { useAppStore } from '../../stores/appStore';
import { openTerminalInDir } from '../../utils/openTerminalInDir';
import { openNewAgentSession } from '../../utils/openAgentChat';
import { projectEnabledAgents, projectModelSources, type Project } from '../../types';
import { useAgentAvailability } from '../../hooks/useAgentAvailability';
import { AgentIcon } from '../agent-chat/AgentIcon';
import { ClaudeModelMenuSection } from './ClaudeModelMenuSection';

interface ProjectLaunchMenuItemsProps {
  /** 目标项目（须已配置路径）。 */
  project: Project;
  /** 任一启动项被点击后的回调，外层负责关闭菜单。 */
  onLaunched: () => void;
}

/**
 * 项目右键菜单的「启动」区：命令行 / Claude·Codex 模型 / Antigravity CLI。
 * 「项目与命令」面板的项目右键和会话标签栏「新建配置终端」的项目悬停菜单共用，
 * 保证两处的启动行为与菜单内容始终同步。
 * 已有的原生会话不在这里列出：聊天标签会持久化并归在项目的标签分组下。
 */
export const ProjectLaunchMenuItems: FC<ProjectLaunchMenuItemsProps> = ({ project, onLaunched }) => {
  const refreshClaudeLaunchTargets = useAppStore(s => s.refreshClaudeLaunchTargets);
  const refreshCodexLaunchTargets = useAppStore(s => s.refreshCodexLaunchTargets);
  // 环境检测结果：未安装的 Agent 不出现在项目右键菜单里（检测返回前视为可用）。
  const agentAvailability = useAgentAvailability();
  const showAntigravity = projectEnabledAgents(project).antigravity && (agentAvailability?.antigravity ?? true);

  // 模型菜单数据源：首次打开时加载，之后用缓存（与 HistoryPanel 一致）。
  useEffect(() => {
    const state = useAppStore.getState();
    if (!state.claudeLaunchTargetsLoaded) void refreshClaudeLaunchTargets();
    if (!state.codexProviderState) void refreshCodexLaunchTargets();
  }, [refreshClaudeLaunchTargets, refreshCodexLaunchTargets]);

  const gotoProvidersSettings = (source: 'claude' | 'codex') => {
    useAppStore.getState().setProviderSettingsTab(source);
    useAppStore.getState().openSettingsDialog('llm-providers');
    onLaunched();
  };

  return (
    <>
      <div className="context-menu-item" onClick={() => {
        // 启动后焦点转到新会话：状态栏不再跟随「项目与命令」面板的选中项。
        useAppStore.getState().setLastClickRegion('tab');
        onLaunched();
        void openTerminalInDir(project.path, { groupName: project.name }).catch(console.error);
      }}>命令行</div>
      {projectModelSources(project)
        .filter(source => agentAvailability?.[source] ?? true)
        .map(source => (
        <ClaudeModelMenuSection
          key={source}
          source={source}
          itemClassName="context-menu-item"
          separatorClassName="context-menu-separator"
          title={source === 'claude' ? 'Claude 模型' : 'Codex 模型'}
          onPickModel={(providerId, modelId) => {
            useAppStore.getState().setLastClickRegion('tab');
            onLaunched();
            // 新会话形态由设置决定：原生会话直接开聊天标签，终端接力（默认）沿用终端启动。
            // 创建失败必须提示（如供应商被删、服务端未就绪），否则点击后毫无反馈。
            void openNewAgentSession(project, source, providerId, modelId).catch(error => {
              useAppStore.getState().showToast(`创建 AI 会话失败：${String(error)}`, 'error');
            });
          }}
          onGotoProviders={() => gotoProvidersSettings(source)}
        />
      ))}
      {showAntigravity && (
        <>
          <div className="context-menu-separator" />
          <div
            className="context-menu-item"
            data-launch-agent="antigravity"
            title="启动 Antigravity CLI（agy）"
            onClick={() => {
              useAppStore.getState().setLastClickRegion('tab');
              onLaunched();
              void openNewAgentSession(project, 'antigravity', 'default:antigravity', '').catch(error => {
                useAppStore.getState().showToast(`创建 Antigravity 会话失败：${String(error)}`, 'error');
              });
            }}
          >
            <span className="claude-model-menu-icon">
              <AgentIcon provider="antigravity" />
            </span>
            <span>Antigravity (agy)</span>
          </div>
        </>
      )}
    </>
  );
};
