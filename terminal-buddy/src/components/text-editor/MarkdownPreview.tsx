import {
  MouseEvent,
  UIEvent,
  forwardRef,
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import MarkdownIt from 'markdown-it';
import { getFileName } from '../../utils/fileExtensions';
import { MarkdownScrollSync } from './markdownScrollSync';

interface MarkdownPreviewProps {
  content: string;
  filePath: string;
  onScrollSourceLine?: (line: number) => void;
}

export interface MarkdownPreviewHandle {
  scrollToSourceLine: (line: number) => void;
  getCurrentSourceLine: () => number | null;
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  };
  return value.replace(/[&<>"]/g, character => entities[character]);
}

function addSourceMapAttributes(md: MarkdownIt): void {
  md.core.ruler.push('source_map_data_attribute', (state) => {
    for (const token of state.tokens) {
      if (token.map && token.type !== 'inline') {
        token.attrSet('data-line', String(token.map[0]));
        token.attrJoin('class', 'code-line');
        token.attrJoin('dir', 'auto');
      }
    }
  });

  const originalHtmlBlockRenderer = md.renderer.rules.html_block;
  if (originalHtmlBlockRenderer) {
    md.renderer.rules.html_block = (tokens, index, options, env, self) => (
      `<div ${self.renderAttrs(tokens[index])}></div>\n`
      + originalHtmlBlockRenderer(tokens, index, options, env, self)
    );
  }
}

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  highlight(code, language) {
    if (language && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      } catch {
        // Fall back to escaped plain text for malformed or unsupported code blocks.
      }
    }
    return escapeHtml(code);
  },
}).use(addSourceMapAttributes);

function normalizeLocalPath(path: string, separator: '\\' | '/'): string {
  const isUnc = path.startsWith('\\\\');
  const isPosixRoot = !isUnc && path.startsWith('/');
  const parts = path.replace(/^[\\/]+/, '').split(/[\\/]+/);
  const normalized: string[] = [];
  const rootLength = isUnc ? 2 : /^[A-Za-z]:$/.test(parts[0] ?? '') ? 1 : 0;

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (normalized.length > rootLength) normalized.pop();
      continue;
    }
    normalized.push(part);
  }

  const prefix = isUnc ? '\\\\' : isPosixRoot ? '/' : '';
  return prefix + normalized.join(separator);
}

function resolveLocalResource(filePath: string, resource: string): string {
  const trimmed = resource.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return resource;

  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
  if (!isWindowsAbsolute && /^[A-Za-z][A-Za-z\d+.-]*:/.test(trimmed)) return resource;

  const suffixIndex = trimmed.search(/[?#]/);
  const resourcePath = suffixIndex >= 0 ? trimmed.slice(0, suffixIndex) : trimmed;
  const suffix = suffixIndex >= 0 ? trimmed.slice(suffixIndex) : '';
  let decodedPath = resourcePath;
  try {
    decodedPath = decodeURIComponent(resourcePath);
  } catch {
    // Keep the original path when the source contains incomplete URL escapes.
  }

  const separator: '\\' | '/' = filePath.includes('\\') ? '\\' : '/';
  const isAbsolute = isWindowsAbsolute || decodedPath.startsWith('/');
  const baseEnd = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const baseDirectory = baseEnd >= 0 ? filePath.slice(0, baseEnd) : '';
  const combined = isAbsolute
    ? decodedPath
    : baseDirectory
      ? `${baseDirectory}${separator}${decodedPath}`
      : decodedPath;
  const normalized = normalizeLocalPath(combined, separator);

  try {
    return convertFileSrc(normalized) + suffix;
  } catch {
    return normalized + suffix;
  }
}

function addHeadingAnchors(root: HTMLElement) {
  const slugCounts = new Map<string, number>();
  root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    if (heading.id) return;
    const baseSlug = (heading.textContent ?? '')
      .trim()
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-') || 'section';
    const count = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, count + 1);
    heading.id = count === 0 ? baseSlug : `${baseSlug}-${count}`;
  });
}

function renderMarkdown(content: string, filePath: string): string {
  const rendered = markdown.render(content);
  const sanitized = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  });
  const document = new DOMParser().parseFromString(`<body>${sanitized}</body>`, 'text/html');

  document.body.querySelectorAll<HTMLImageElement>('img[src]').forEach((image) => {
    const source = image.getAttribute('src');
    if (source) image.src = resolveLocalResource(filePath, source);
    image.decoding = 'async';
  });

  document.body.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? '';
    if (/^(https?:|mailto:)/i.test(href)) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
  });

  addHeadingAnchors(document.body);
  const endMarker = document.createElement('div');
  endMarker.className = 'code-line markdown-source-end';
  endMarker.dataset.line = String(content.split(/\r?\n/).length);
  endMarker.setAttribute('aria-hidden', 'true');
  document.body.append(endMarker);
  return document.body.innerHTML;
}

/** 单张图片 settle 的超时上限：超时只解除滚动同步阻塞，不取消浏览器继续加载。 */
const IMAGE_WAIT_TIMEOUT_MS = 3000;

/**
 * 等待容器内所有图片 settle（load / error / 超时三者竞速）。
 * 返回清理函数：settle 后成对移除 load/error 监听器并清理 timer，
 * 组件卸载或新滚动请求覆盖旧请求时调用，保证监听器与 timer 不累积。
 * 永久 pending 的图片在超时后放行回调，滚动同步不会卡死。
 */
function whenImagesSettled(
  root: HTMLElement,
  onSettled: () => void,
): () => void {
  const images = Array.from(root.getElementsByTagName('img'));
  if (images.length === 0) {
    const timer = setTimeout(onSettled, 0);
    return () => clearTimeout(timer);
  }

  let remaining = images.length + 1; // +1：底部无条件 settle 兜底「全部已 complete」的情况
  let settled = false;
  const cleanups: Array<() => void> = [];

  const settle = () => {
    if (settled) return;
    remaining -= 1;
    if (remaining > 0) return;
    settled = true;
    // 统一收尾：成对移除监听器、清理超时 timer，避免多次渲染后累积
    for (const cleanup of cleanups) cleanup();
    setTimeout(onSettled, 0);
  };

  for (const image of images) {
    if (image.complete) {
      remaining -= 1;
      continue;
    }
    const handleLoad = () => {
      cleanupForImage();
      settle();
    };
    const handleError = () => {
      cleanupForImage();
      settle();
    };
    const timeout = setTimeout(handleError, IMAGE_WAIT_TIMEOUT_MS);
    const cleanupForImage = () => {
      clearTimeout(timeout);
      image.removeEventListener('load', handleLoad);
      image.removeEventListener('error', handleError);
    };
    cleanups.push(cleanupForImage);
    image.addEventListener('load', handleLoad, { once: true });
    image.addEventListener('error', handleError, { once: true });
  }

  // 兜底：全部图片都 complete 时 remaining 已减到 1，这里触发唯一一次 settle
  settle();

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

function doAfterImagesLoaded(root: HTMLElement, callback: () => void): () => void {
  return whenImagesSettled(root, callback);
}

export const MarkdownPreview = forwardRef<MarkdownPreviewHandle, MarkdownPreviewProps>(({
  content,
  filePath,
  onScrollSourceLine,
}, ref) => {
  const deferredContent = useDeferredValue(content);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollSyncRef = useRef<MarkdownScrollSync | null>(null);
  const pendingSourceLineRef = useRef(0);
  const scrollDisabledUntilRef = useRef(0);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollSyncAtRef = useRef(0);
  const scrollRequestRef = useRef(0);
  const html = useMemo(
    () => renderMarkdown(deferredContent, filePath),
    [deferredContent, filePath],
  );

  const pendingImageWaitCleanupRef = useRef<(() => void) | null>(null);

  const scrollToSourceLine = useCallback((line: number) => {
    pendingSourceLineRef.current = line;
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;
    const request = ++scrollRequestRef.current;
    // 旧请求的监听器/timer 必须先回收：新请求覆盖旧请求后，旧回调不再执行，
    // 其挂着的图片监听器和超时 timer 也不能积累。
    pendingImageWaitCleanupRef.current?.();
    pendingImageWaitCleanupRef.current = doAfterImagesLoaded(scrollContainer, () => {
      if (request !== scrollRequestRef.current) return;
      pendingImageWaitCleanupRef.current = null;
      scrollDisabledUntilRef.current = performance.now() + 50;
      scrollSyncRef.current?.scrollToRevealSourceLine(line);
    });
  }, []);

  const getCurrentSourceLine = useCallback((): number | null => {
    const line = scrollSyncRef.current?.getEditorLineForScrollTop() ?? null;
    return line === null || !Number.isFinite(line) ? null : line;
  }, []);

  useImperativeHandle(ref, () => ({ scrollToSourceLine, getCurrentSourceLine }), [scrollToSourceLine, getCurrentSourceLine]);

  useLayoutEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;
    scrollSyncRef.current = new MarkdownScrollSync(scrollContainer);
    scrollToSourceLine(pendingSourceLineRef.current);
  });

  useEffect(() => () => {
    scrollRequestRef.current += 1;
    pendingImageWaitCleanupRef.current?.();
    pendingImageWaitCleanupRef.current = null;
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
  }, []);

  const handleScroll = (_event: UIEvent<HTMLDivElement>) => {
    if (performance.now() < scrollDisabledUntilRef.current) return;

    const syncEditor = () => {
      scrollTimerRef.current = null;
      lastScrollSyncAtRef.current = performance.now();
      const line = scrollSyncRef.current?.getEditorLineForScrollTop() ?? null;
      if (line === null || !Number.isFinite(line)) return;
      pendingSourceLineRef.current = line;
      onScrollSourceLine?.(line);
    };

    const remaining = 50 - (performance.now() - lastScrollSyncAtRef.current);
    if (remaining <= 0) {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      syncEditor();
    } else if (!scrollTimerRef.current) {
      scrollTimerRef.current = setTimeout(syncEditor, remaining);
    }
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;

    const href = anchor.getAttribute('href') ?? '';
    if (!href.startsWith('#')) {
      if (!/^(https?:|mailto:)/i.test(href)) event.preventDefault();
      return;
    }

    event.preventDefault();
    let headingId = href.slice(1);
    try {
      headingId = decodeURIComponent(headingId);
    } catch {
      // Use the undecoded fragment if it is not valid URI text.
    }
    event.currentTarget.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`)?.scrollIntoView({ block: 'start' });
  };

  return (
    <div
      ref={scrollRef}
      className="markdown-preview-scroll"
      onClick={handleClick}
      onScroll={handleScroll}
    >
      <article
        className="markdown-preview-body"
        aria-label={`Markdown 预览：${getFileName(filePath)}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
});

MarkdownPreview.displayName = 'MarkdownPreview';
