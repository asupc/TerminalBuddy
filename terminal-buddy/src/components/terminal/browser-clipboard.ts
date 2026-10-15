import type { Terminal } from '@xterm/xterm';

interface BrowserClipboardOptions {
  canPaste: () => boolean;
  uploadFiles: (files: File[]) => Promise<string[]>;
  insertFiles: (paths: string[]) => void;
  onError: (error: unknown) => void;
}

export function isBrowserPasteShortcut(event: KeyboardEvent): boolean {
  if (event.altKey) return false;
  return (event.key.toLowerCase() === 'v' && (event.ctrlKey || event.metaKey))
    || (event.key === 'Insert' && event.shiftKey && !event.ctrlKey && !event.metaKey);
}

/** 使用用户触发的 paste 事件，在局域网 HTTP 下也能读取文本和图片。 */
export function installBrowserClipboard(terminal: Terminal, options: BrowserClipboardOptions): () => void {
  const element = terminal.element!;
  let disposed = false;
  element.setAttribute('data-native-context-menu', '');

  // xterm 会把 textarea 移到鼠标下供浏览器显示编辑菜单；菜单打开时保留这个位置。
  const openMenu = () => element.setAttribute('data-native-context-menu-open', '');
  const closeMenu = () => element.removeAttribute('data-native-context-menu-open');
  const onMouseDown = (event: MouseEvent) => {
    if (event.button === 2) openMenu();
    else closeMenu();
  };
  const onPaste = (event: ClipboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMenu();
    if (disposed || !options.canPaste() || !event.clipboardData) return;

    const files = Array.from(event.clipboardData.files);
    if (files.length) {
      void options.uploadFiles(files).then(paths => {
        if (disposed || !options.canPaste()) return;
        options.insertFiles(paths);
        terminal.focus();
      }).catch(error => {
        if (!disposed) options.onError(error);
      });
      return;
    }

    // 只交给 xterm 一次，沿用换行归一化、括号粘贴与终端 onData 路径。
    const text = event.clipboardData.getData('text/plain');
    if (text) terminal.paste(text);
    terminal.focus();
  };

  element.addEventListener('mousedown', onMouseDown, true);
  element.addEventListener('contextmenu', openMenu, true);
  element.addEventListener('paste', onPaste, true);
  element.ownerDocument.addEventListener('pointerdown', closeMenu, true);
  element.ownerDocument.addEventListener('keydown', closeMenu, true);
  return () => {
    disposed = true;
    closeMenu();
    element.removeAttribute('data-native-context-menu');
    element.removeEventListener('mousedown', onMouseDown, true);
    element.removeEventListener('contextmenu', openMenu, true);
    element.removeEventListener('paste', onPaste, true);
    element.ownerDocument.removeEventListener('pointerdown', closeMenu, true);
    element.ownerDocument.removeEventListener('keydown', closeMenu, true);
  };
}
