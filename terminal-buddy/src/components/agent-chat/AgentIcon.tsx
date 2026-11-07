import claudeLogo from '../../assets/agent-logo-claude.png';
import codexLogo from '../../assets/agent-logo-codex.png';
import './AgentIcon.css';

/**
 * Agent 图标：直接复用安卓 App 的 Claude / Codex 标志（claude.ai 星芒与 OpenAI 结）。
 * PNG 作为遮罩绘制，颜色跟随 `currentColor`，深浅主题下都能正确显示。
 */
export function AgentIcon({ provider, className }: {
  provider?: 'claude' | 'codex' | string | null;
  className?: string;
}) {
  const logo = provider === 'codex' ? codexLogo : claudeLogo;
  return (
    <span
      className={className ? `agent-logo ${className}` : 'agent-logo'}
      style={{ WebkitMaskImage: `url("${logo}")`, maskImage: `url("${logo}")` }}
      aria-hidden="true"
    />
  );
}
