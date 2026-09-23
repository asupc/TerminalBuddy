import { useEffect, useState } from 'react';

/** 监听 CSS 媒体查询，返回当前是否匹配。初始 false（SSR 安全）。 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** 是否使用双栏布局（≥960px：平板横屏 / 桌面）。 */
export function useDualPane(): boolean {
  return useMediaQuery('(min-width: 960px)');
}

/** 是否为精确指针设备（有鼠标）：
 *  true → 双击启动 + 右键出菜单；false（触摸）→ 单击启动 + 长按出菜单。 */
export function useHasHover(): boolean {
  return useMediaQuery('(hover: hover) and (pointer: fine)');
}
