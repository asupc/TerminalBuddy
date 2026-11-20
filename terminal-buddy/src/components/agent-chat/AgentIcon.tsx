import antigravityLogo from '../../assets/agent-logo-antigravity.svg';
import claudeLogo from '../../assets/agent-logo-claude.png';
import codexLogo from '../../assets/agent-logo-codex.png';
import './AgentIcon.css';

/**
 * Agent 图标：Claude 星芒、Codex 结与 Antigravity CLI 升空 A 标。
 * 资源仅作为 CSS 遮罩绘制，颜色跟随 `currentColor`，深浅主题下都能正确显示。
 */
export function AgentIcon({ provider, className }: {
  provider?: 'claude' | 'codex' | 'antigravity' | string | null;
  className?: string;
}) {
  const logo = provider === 'codex'
    ? codexLogo
    : provider === 'antigravity'
      ? antigravityLogo
      : claudeLogo;
  return (
    <span
      className={className ? `agent-logo ${className}` : 'agent-logo'}
      style={{ WebkitMaskImage: `url("${logo}")`, maskImage: `url("${logo}")` }}
      aria-hidden="true"
    />
  );
}
