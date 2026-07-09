// 右键菜单定位工具：保证菜单不超出视口边界（底部超出时改为向上展开）

export const CONTEXT_MENU_MARGIN = 8;

/**
 * 根据菜单尺寸把锚点坐标修正到视口内。
 * - 右侧超出：左移到视口内。
 * - 底部超出：以锚点为上沿向上展开（避免贴底被遮挡）。
 * - 最后整体 clamp 到 [margin, max]，保证至少留出 margin 边距且不出现负坐标。
 */
export function fitContextMenuToViewport(
  anchorX: number,
  anchorY: number,
  menuWidth: number,
  menuHeight: number
): { x: number; y: number } {
  let x = anchorX;
  let y = anchorY;

  if (x + menuWidth + CONTEXT_MENU_MARGIN > window.innerWidth) {
    x = window.innerWidth - menuWidth - CONTEXT_MENU_MARGIN;
  }

  if (y + menuHeight + CONTEXT_MENU_MARGIN > window.innerHeight) {
    y = anchorY - menuHeight;
  }

  const maxX = Math.max(CONTEXT_MENU_MARGIN, window.innerWidth - menuWidth - CONTEXT_MENU_MARGIN);
  const maxY = Math.max(CONTEXT_MENU_MARGIN, window.innerHeight - menuHeight - CONTEXT_MENU_MARGIN);

  return {
    x: Math.min(Math.max(CONTEXT_MENU_MARGIN, x), maxX),
    y: Math.min(Math.max(CONTEXT_MENU_MARGIN, y), maxY),
  };
}
