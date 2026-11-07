import { useState } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import { ChatMarkdown } from './ChatMarkdown';

/** Skill 展开条目：标题为 skill:名称，默认展开、内容区独立滚动。 */
export function SkillEntry({ name, text }: { name: string; text: string }) {
  const [open, setOpen] = useState(true);
  const sizeKb = (new TextEncoder().encode(text).length / 1024).toFixed(1);
  return (
    <div className={`agent-skill-entry${open ? ' open' : ''}`}>
      <button className="agent-skill-header" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <ChevronDown className="agent-skill-chevron" aria-hidden="true" />
        <span className="agent-skill-badge">SKILL</span>
        <span className="agent-skill-name">skill:{name}</span>
        <span className="agent-skill-size">{sizeKb} KB</span>
      </button>
      {open && (
        <div className="agent-skill-body">
          <ChatMarkdown text={text} />
        </div>
      )}
    </div>
  );
}

/** 无具体内容的 skill 占位（例如 Skill 内容为空时仍保留条目）。 */
export function SkillPlaceholder({ name }: { name: string }) {
  return (
    <div className="agent-skill-entry">
      <div className="agent-skill-header">
        <Sparkles className="agent-skill-chevron" aria-hidden="true" />
        <span className="agent-skill-badge">SKILL</span>
        <span className="agent-skill-name">skill:{name}</span>
      </div>
    </div>
  );
}
