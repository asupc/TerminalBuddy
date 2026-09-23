export const TERMINAL_RESIZE_EVENT = 'tb-split-resize';
export const TERMINAL_PANEL_RESIZE_EVENT = 'tb-panel-resize';
export const TERMINAL_SPLIT_LAYOUT_SETTLE_MS = 140;
export const TERMINAL_SPLIT_TRANSITION_GUARD_MS = 360;

export function notifyTerminalPanelResize(): void {
  window.dispatchEvent(new Event(TERMINAL_PANEL_RESIZE_EVENT));
}

export type TerminalSplitMode = 'off' | '2x1' | '2x2';
export type TerminalWindowMode = 'normal' | 'panels-hidden';

export interface TerminalResizeDetail {
  terminalIds: string[];
  layoutVersion: number;
  splitMode: TerminalSplitMode;
  windowMode: TerminalWindowMode;
  reason: 'split-layout' | 'window-resize';
}
