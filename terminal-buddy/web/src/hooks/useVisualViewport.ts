import { useEffect } from 'react';

/**
 * 补 index.html 内联 setVH 没覆盖的两块兜底：
 *  - orientationchange：少数 WebView 旋转时不触发 visualViewport.resize；
 *  - focusout：软键盘收起后部分 WebView 不重发 resize，延迟 50ms 强制重算一次。
 *
 * 常见 resize/scroll 已由 index.html 内联脚本处理，这里不再重复挂监听。
 */
export function useVisualViewport(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let lastPx = '';
    let focusoutTimer: number | null = null;

    const update = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      const px = Number.isFinite(height) && height > 0 ? `${Math.round(height)}px` : '100vh';
      if (px === lastPx) return;
      lastPx = px;
      document.documentElement.style.setProperty('--vh', px);
    };

    window.addEventListener('orientationchange', update);

    const onFocusOut = () => {
      if (focusoutTimer != null) window.clearTimeout(focusoutTimer);
      focusoutTimer = window.setTimeout(() => {
        focusoutTimer = null;
        update();
      }, 50);
    };
    document.addEventListener('focusout', onFocusOut);

    return () => {
      window.removeEventListener('orientationchange', update);
      if (focusoutTimer != null) {
        window.clearTimeout(focusoutTimer);
        focusoutTimer = null;
      }
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);
}
