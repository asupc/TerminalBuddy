import type { ITerminalOptions } from '@xterm/xterm';
import type { TerminalColors } from '../../utils/terminalTheme';

// 半透明皮肤只在外层绘制一次背景，避免画布叠加后变暗。
export function toXtermCanvasTheme(colors: TerminalColors) {
  const { lightOptimized: _lightOptimized, canvasBackground, ...theme } = colors;
  return colors.background.startsWith('rgba(')
    ? { ...theme, background: canvasBackground ?? 'rgba(0, 0, 0, 0)' }
    : theme;
}

/** 原生 PTY 与移动端消息终端共用外观，字号、配色和选中效果保持一致。 */
export function terminalAppearance(colors: TerminalColors, fontSize: number): ITerminalOptions {
  return {
    cursorBlink: false,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    cursorWidth: 1,
    fontSize,
    fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    lineHeight: 1,
    letterSpacing: 0,
    scrollback: 50000,
    theme: toXtermCanvasTheme(colors),
    allowTransparency: true,
    minimumContrastRatio: colors.lightOptimized ? 4.5 : 1,
    screenReaderMode: false,
  };
}
