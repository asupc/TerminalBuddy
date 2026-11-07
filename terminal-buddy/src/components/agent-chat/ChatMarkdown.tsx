import { useMemo } from 'react';
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

export function ChatMarkdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(markdown.render(text))
      // 聊天里的外链不在当前页面跳走（Tauri WebView 里尤其危险）：统一新窗口打开。
      .replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href='),
    [text],
  );
  return <div className="agent-chat-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
