// Agent 会话气泡的安全 Markdown 渲染（§5.5：抽一个不依赖 filePath 的组件，
// 不能直接复用 MarkdownPreview 的 props——那套携带源文件路径做本地资源解析与滚动同步）。
// 渲染策略与 MarkdownPreview 一致（markdown-it + DOMPurify），但：
// - html 输入关闭（转录内容不是可信 HTML）；
// - 不解析本地相对路径图片/链接，外链统一新标签页打开；
// - 不做行号映射与滚动同步。
import { useMemo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

// 仅作用于本实例：http(s) 链接新标签页打开，避免占用面板所在的 webview。
const defaultLinkOpen = markdown.renderer.rules.link_open
  ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const href = tokens[index].attrGet('href') ?? '';
  if (/^(https?:|mailto:)/i.test(href)) {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, index, options, env, self);
};

function renderAgentMarkdown(content: string): string {
  return DOMPurify.sanitize(markdown.render(content), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  });
}

export function AgentMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderAgentMarkdown(text), [text]);
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    // 非 http(s)/mailto 的链接（相对路径、锚点等）在这里没有可导航目标，直接拦截。
    const target = event.target as HTMLElement;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!/^(https?:|mailto:)/i.test(href)) event.preventDefault();
  };
  return <div className="ta-markdown" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
