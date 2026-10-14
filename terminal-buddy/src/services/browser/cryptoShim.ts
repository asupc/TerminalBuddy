/**
 * HTTP 非安全上下文的 Web API 兼容垫片。
 *
 * 浏览器只在「安全上下文」（HTTPS，或 localhost / 127.0.0.1）暴露
 * crypto.randomUUID、crypto.subtle 与 navigator.clipboard。通过局域网 IP +
 * http:// 访问本服务时这些都缺失：
 *
 * - crypto.randomUUID() 抛 TypeError，异常被 launchTerminalSession 的
 *   try/catch 吞掉 → 表现为「点击启动终端没有任何反应」；
 * - navigator.clipboard.writeText 抛 TypeError → 复制按钮静默失效。
 *
 * 本模块在 import 时立即执行（作为入口的第一个 import，先于其它业务模块求值）。
 */

function uuidFromRandomValues(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // RFC 4122 version 4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/** 极端兜底：连 getRandomValues 都缺失时用 Math.random。 */
function uuidFromMathRandom(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function installRandomUuid(): void {
  if (typeof window.crypto === 'undefined' || window.crypto === null) {
    const minimal = {
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => array,
      randomUUID: uuidFromMathRandom,
    } as unknown as Crypto;
    Object.defineProperty(window, 'crypto', { value: minimal, configurable: true });
    return;
  }

  if (typeof window.crypto.randomUUID !== 'function') {
    const impl = typeof window.crypto.getRandomValues === 'function'
      ? uuidFromRandomValues
      : uuidFromMathRandom;
    Object.defineProperty(window.crypto, 'randomUUID', {
      value: impl,
      writable: false,
      configurable: true,
    });
  }
}

/**
 * 复制文本：优先用 Clipboard API（需要安全上下文），不可用时退回到
 * 隐藏 textarea + document.execCommand('copy')，保证 http:// 访问下按钮仍可用。
 */
function copyTextFallback(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function installClipboardShim(): void {
  const existing = navigator.clipboard as Clipboard | undefined;
  const hasWrite = typeof existing?.writeText === 'function';

  const writeText = async (text: string): Promise<void> => {
    if (hasWrite) {
      try {
        await existing!.writeText(text);
        return;
      } catch {
        // 落到下面的兼容路径
      }
    }
    if (!copyTextFallback(text)) throw new Error('复制失败：当前页面无法访问剪贴板，请手动复制');
  };

  if (!hasWrite) {
    const shim = {
      writeText,
      readText: async (): Promise<string> => {
        throw new Error('http:// 访问不支持读取剪贴板，请改用 HTTPS 或手动粘贴');
      },
      read: async (): Promise<ClipboardItem[]> => [],
    } as unknown as Clipboard;

    Object.defineProperty(navigator, 'clipboard', {
      value: shim,
      writable: false,
      configurable: true,
    });
  }
}

export function installWebApiShims(): void {
  if (typeof window === 'undefined') return;
  installRandomUuid();
  installClipboardShim();
}

// 模块被 import 时立即生效，确保早于其它业务模块的顶层代码。
installWebApiShims();