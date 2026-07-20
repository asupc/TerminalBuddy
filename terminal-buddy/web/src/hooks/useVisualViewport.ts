import { useEffect } from 'react';

/**
 * 移动 WebView 上软键盘弹起/收起时，`window.innerHeight` 与 `100vh` 的值不可靠：
 *  - iOS Safari 的 `100vh` 始终包含地址栏（"largest viewport"），不反映当前可见高度。
 *  - 部分 Android WebView 在键盘收起后 `innerHeight` 不立刻恢复，遗留一个"压缩"高度。
 *
 * 该 hook 通过 `window.visualViewport`（Chromium / Safari / 现代 WebView 均支持）把
 * 当前可见高度同步到 `--vh` CSS 变量（单位 px，避免 vh 的语义陷阱），让 `height: var(--vh)`
 * 跟随软键盘实时收紧；并在兜底 `resize`/`orientationchange` 上重算，应对某些 WebView
 * visualViewport 不刷新的边缘情况。
 */
export function useVisualViewport(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const root = document.documentElement;

    const update = () => {
      const vv = window.visualViewport;
      // 优先用 visualViewport.height（受软键盘影响），否则退回 innerHeight
      const height = vv?.height ?? window.innerHeight;
      // px 单位，避免 vh 语义陷阱；NaN/0 兜底
      const px = Number.isFinite(height) && height > 0 ? `${Math.round(height)}px` : '100vh';
      root.style.setProperty('--vh', px);
    };

    update();

    const vv = window.visualViewport;
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);

    // 兜底：键盘收起依赖 input 失焦，部分 WebView 此时不触发 visualViewport.resize，
    // focusout 后强制重算一次，确保高度恢复。
    const onFocusOut = () => window.setTimeout(update, 50);
    document.addEventListener('focusout', onFocusOut);

    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);
}
