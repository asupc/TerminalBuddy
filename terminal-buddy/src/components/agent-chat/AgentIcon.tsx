import antigravityLogo from '../../assets/agent-logo-antigravity.svg';
import claudeLogo from '../../assets/agent-logo-claude.png';
import codexLogo from '../../assets/agent-logo-codex.png';
import './AgentIcon.css';

/**
 * Agent 图标：Claude 星芒与 Codex 结用 CSS 遮罩跟随 `currentColor` 绘制；
 * Antigravity CLI 直接渲染从官网 antigravity.google 获取的四色矢量 Logo。
 */
export function AgentIcon({ provider, className }: {
  provider?: 'claude' | 'codex' | 'antigravity' | string | null;
  className?: string;
}) {
  if (provider === 'antigravity') {
    return (
      <img
        src={antigravityLogo}
        alt=""
        draggable={false}
        className={className ? `agent-logo agent-logo--color ${className}` : 'agent-logo agent-logo--color'}
        aria-hidden="true"
      />
    );
  }
  const logo = provider === 'codex' ? codexLogo : claudeLogo;
  return (
    <span
      className={className ? `agent-logo ${className}` : 'agent-logo'}
      style={{ WebkitMaskImage: `url("${logo}")`, maskImage: `url("${logo}")` }}
      aria-hidden="true"
    />
  );
}
