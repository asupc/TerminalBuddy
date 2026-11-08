import { memo, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import MarkdownIt from 'markdown-it';

/** 聊天消息专用的轻量 Markdown 渲染：无文件路径、无滚动同步，仅做安全 HTML。 */
const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code: string, language: string): string {
    if (language && hljs.getLanguage(language)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        // 高亮失败时退回纯文本块。
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
  },
});

// `.md` 是有效国家顶级域名：fuzzy link 会把 AGENTS.md 之类的文件名识别成网址并跳转。
// 只保留带协议（http://、https:// 等）的显式链接。
markdown.linkify.set({ fuzzyLink: false });

/** 单条消息正文的渲染上限：超长回复（巨型代码块/日志）整段渲染会带来海量 DOM 节点。 */
const MARKDOWN_RENDER_LIMIT = 24000;

/** 截断点回退到最近的空行（审查 V-12）：直接按字符数硬切可能切在代码围栏、
 * 表格或列表中间，渲染出残破的尾部；回退到段落边界可避免绝大多数残破。
 * 若截断后围栏仍未闭合（``` 计数为奇数），补一个闭合围栏保证渲染完整。 */
function truncateForRender(text: string): string {
  let cut = text.slice(0, MARKDOWN_RENDER_LIMIT);
  const lastBlank = cut.lastIndexOf('\n\n');
  if (lastBlank > MARKDOWN_RENDER_LIMIT / 2) {
    cut = cut.slice(0, lastBlank);
  }
  const fenceCount = (cut.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 === 1) {
    cut += '\n```\n';
  }
  return cut;
}

/** memo：流式期间只有正在增长的消息文本变化，历史消息按 text 引用直接跳过重渲染。 */
export const ChatMarkdown = memo(function ChatMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // 流式尾块豁免截断（审查 V-3）：正在增长的消息被截断时，贴底观看的正文
  // 会冻结、只剩字符计数在跳，等流结束再截断。
  const truncated = !expanded && !streaming && text.length > MARKDOWN_RENDER_LIMIT;
  const source = truncated ? truncateForRender(text) : text;
  const html = useMemo(
    () => DOMPurify.sanitize(markdown.render(source))
      // 聊天里的外链不在当前页面跳走（Tauri WebView 里尤其危险）：统一新窗口打开。
      .replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href='),
    [source],
  );
  return (
    <>
      <div className="agent-chat-markdown" dangerouslySetInnerHTML={{ __html: html }} />
      {truncated && (
        <button type="button" className="agent-btn small agent-expand-full" onClick={() => setExpanded(true)}>
          展开全部（{text.length} 字符）
        </button>
      )}
    </>
  );
});
