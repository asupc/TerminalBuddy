import type { Terminal } from '@xterm/xterm';

export const FLOATING_MENU_MARGIN = 8;
export const RIGHT_CLICK_PASTE_DEDUPE_MS = 750;
export const RIGHT_CLICK_NATIVE_PASTE_SUPPRESS_MS = 1200;
export const CODEX_INPUT_BACKGROUND_LIGHT = '48;2;244;244;244';
export const CODEX_INPUT_BACKGROUND_DARK = '48;2;57;57;57';
export const CODEX_INPUT_BACKGROUND_FALLBACK_DARK = '48;2;41;41;41';

export const SPLIT_FONT_SIZE_FALLBACK: Record<'off' | '2x1' | '2x2', number> = {
  off: 14,
  '2x1': 12,
  '2x2': 11,
};

export function clampFontSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(8, Math.min(32, Math.round(value)));
}

export function resolveSplitFontSize(
  splitMode: 'off' | '2x1' | '2x2',
  settings: { terminalFontSizeOff: number; terminalFontSize2x1: number; terminalFontSize2x2: number },
): number {
  const fallback = SPLIT_FONT_SIZE_FALLBACK[splitMode];
  if (splitMode === 'off') return clampFontSize(settings.terminalFontSizeOff, fallback);
  if (splitMode === '2x1') return clampFontSize(settings.terminalFontSize2x1, fallback);
  return clampFontSize(settings.terminalFontSize2x2, fallback);
}

export function adaptCodexInputBackground(data: string, lightBackground: boolean): string {
  if (lightBackground) {
    return data
      .split(CODEX_INPUT_BACKGROUND_DARK).join(CODEX_INPUT_BACKGROUND_LIGHT)
      .split(CODEX_INPUT_BACKGROUND_FALLBACK_DARK).join(CODEX_INPUT_BACKGROUND_LIGHT);
  }
  return data.split(CODEX_INPUT_BACKGROUND_LIGHT).join(CODEX_INPUT_BACKGROUND_DARK);
}

export function recolorCodexInputBuffer(term: Terminal, lightBackground: boolean): void {
  const light = 0xf4f4f4;
  const dark = 0x393939;
  const fallbackDark = 0x292929;
  const buffer = term.buffer.active;
  const reusableCell = buffer.getNullCell();
  let changed = false;

  // xterm's public buffer API intentionally exposes cells as read-only. The returned
  // cell and line view still wrap mutable xterm data, so update only exact Codex input
  // background matches and leave all characters and other attributes untouched.
  for (let y = buffer.viewportY; y < Math.min(buffer.length, buffer.viewportY + term.rows); y++) {
    const line = buffer.getLine(y);
    const mutableLine = (line as unknown as {
      _line?: { setCell: (index: number, cell: unknown) => void };
    } | undefined)?._line;
    if (!line || !mutableLine) continue;

    for (let x = 0; x < Math.min(line.length, term.cols); x++) {
      const cell = line.getCell(x, reusableCell);
      if (!cell?.isBgRGB()) continue;

      const current = cell.getBgColor();
      const replacement = lightBackground
        ? (current === dark || current === fallbackDark ? light : null)
        : (current === light ? dark : null);
      if (replacement === null) continue;

      const mutableCell = cell as unknown as { bg: number };
      mutableCell.bg = (mutableCell.bg & ~0xffffff) | replacement;
      mutableLine.setCell(x, mutableCell);
      changed = true;
    }
  }

  if (changed && term.rows > 0) term.refresh(0, term.rows - 1);
}

