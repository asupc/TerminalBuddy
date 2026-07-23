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
import { getFileName } from '../utils/fileExtensions';
import { MarkdownScrollSync } from './markdownScrollSync';

interface MarkdownPreviewProps {
  content: string;
  filePath: string;
  onScrollSourceLine?: (line: number) => void;
}

export interface MarkdownPreviewHandle {
  scrollToSourceLine: (line: number) => void;
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

function doAfterImagesLoaded(root: HTMLElement, callback: () => void): void {
  const images = Array.from(root.getElementsByTagName('img'));
  if (images.length === 0) {
    setTimeout(callback, 0);
    return;
  }

  void Promise.all(images.map(image => {
    if (image.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    });
  })).then(() => setTimeout(callback, 0));
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

  const scrollToSourceLine = useCallback((line: number) => {
    pendingSourceLineRef.current = line;
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;
    const request = ++scrollRequestRef.current;
    doAfterImagesLoaded(scrollContainer, () => {
      if (request !== scrollRequestRef.current) return;
      scrollDisabledUntilRef.current = performance.now() + 50;
      scrollSyncRef.current?.scrollToRevealSourceLine(line);
    });
  }, []);

  useImperativeHandle(ref, () => ({ scrollToSourceLine }), [scrollToSourceLine]);

  useLayoutEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;
    scrollSyncRef.current = new MarkdownScrollSync(scrollContainer);
    scrollToSourceLine(pendingSourceLineRef.current);
  });

  useEffect(() => () => {
    scrollRequestRef.current += 1;
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
