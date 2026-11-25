import { useEffect, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { aiSessionDelete, aiSessionGet, type AiSession } from '../../services/tauri';
import { useAppStore, type NativeAgentTab } from '../../stores/appStore';
import { describeAgentLaunchConfig, launchTerminalFromAgentTab } from '../../utils/agentTabTerminalLaunch';
import './AgentTabContextMenu.css';

interface AgentTabContextMenuProps {
  x: number;
  y: number;
  tab: NativeAgentTab;
  onClose: () => void;
}

/**
 * 原生会话标签的右键菜单：与终端标签的「以此配置新建终端」对齐。
 * 菜单挂在标签栏 / 会话树上，关闭会话、定位标签等操作仍走各自的入口。
 */
export const AgentTabContextMenu: FC<AgentTabContextMenuProps> = ({ x, y, tab, onClose }) => {
  const closeAgentTab = useAppStore(state => state.closeAgentTab);
  const setActiveAgentTab = useAppStore(state => state.setActiveAgentTab);
  const showToast = useAppStore(state => state.showToast);
  // 供应商与模型只用于说明「以此配置新建终端」会沿用哪套配置。
  const [session, setSession] = useState<AiSession | null>(null);
  useEffect(() => {
    let disposed = false;
    aiSessionGet(tab.sessionId)
      .then(value => { if (!disposed) setSession(value); })
      .catch(() => {});
    return () => { disposed = true; };
  }, [tab.sessionId]);

  const providerLabel = tab.provider === 'codex' ? 'Codex' : tab.provider === 'antigravity' ? 'Antigravity' : 'Claude Code';
  const configLabel = session?.providerName || session?.model || tab.model || '服务端默认配置';
  const launchHint = describeAgentLaunchConfig(session);

  const removeSession = () => {
    onClose();
    aiSessionDelete(tab.sessionId)
      .then(() => closeAgentTab(tab.key))
      .catch(reason => showToast('删除会话失败：' + String(reason), 'error'));
  };

  // 标签栏与会话树都带 overflow 滚动容器，菜单必须挂到 body 才不会被裁切。
  return createPortal(
    <>
      <div
        className="context-menu-overlay"
        onClick={onClose}
        onContextMenu={event => { event.preventDefault(); onClose(); }}
      />
      <div className="context-menu" style={{ left: x, top: y }}>
        <div className="agent-tab-menu-head" title={`${providerLabel} · ${tab.projectPath}`}>{configLabel}</div>
        <div className="context-menu-item" onClick={() => { setActiveAgentTab(tab.key); onClose(); }}>
          打开会话
        </div>
        <div className="context-menu-item" title={launchHint.hint} onClick={() => {
          onClose();
          void launchTerminalFromAgentTab(tab);
        }}>
          以此配置新建终端
          {!launchHint.exact && <span className="agent-tab-menu-note">基础命令</span>}
        </div>
        <div className="context-menu-item" onClick={() => {
          navigator.clipboard.writeText(tab.projectPath).catch(() => {});
          onClose();
        }}>复制项目路径</div>
        <div className="context-menu-separator" />
        <div className="context-menu-item" onClick={() => { closeAgentTab(tab.key); onClose(); }}>
          关闭标签
        </div>
        <div className="context-menu-item danger" onClick={removeSession}>
          删除会话
        </div>
      </div>
    </>,
    document.body,
  );
};
