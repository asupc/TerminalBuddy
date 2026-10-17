interface TerminalElements {
  element: HTMLElement | undefined;
  textarea: HTMLTextAreaElement | undefined;
}

/** 触摸终端用于浏览；软键盘由下方输入框唤起，避免滚动后的合成鼠标事件重新弹出键盘。 */
export function installTouchKeyboardGuard(terminal: TerminalElements): () => void {
  const { element, textarea } = terminal;
  if (!element || !textarea) return () => {};

  const originalReadOnly = textarea.readOnly;
  const originalInputMode = textarea.inputMode;
  const suppressKeyboard = () => {
    textarea.readOnly = true;
    textarea.inputMode = 'none';
  };
  const restoreKeyboard = () => {
    textarea.readOnly = originalReadOnly;
    textarea.inputMode = originalInputMode;
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') suppressKeyboard();
    else if (event.pointerType === 'mouse') restoreKeyboard();
  };

  // 必须在 xterm 的 mousedown 聚焦之前生效；旧版 Safari 由 touchstart 兜底。
  element.addEventListener('pointerdown', onPointerDown, true);
  element.addEventListener('touchstart', suppressKeyboard, { capture: true, passive: true });

  return () => {
    element.removeEventListener('pointerdown', onPointerDown, true);
    element.removeEventListener('touchstart', suppressKeyboard, true);
    restoreKeyboard();
  };
}
