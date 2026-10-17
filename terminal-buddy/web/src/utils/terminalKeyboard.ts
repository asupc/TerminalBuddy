interface TerminalElements {
  element: HTMLElement | undefined;
  textarea: HTMLTextAreaElement | undefined;
}

/** 触屏只用底部输入框输入；禁用隐藏 textarea 的原生聚焦，不影响 PTY 输入和终端协议。 */
export function installTouchKeyboardGuard(terminal: TerminalElements): () => void {
  const { element, textarea } = terminal;
  if (!element || !textarea) return () => {};

  const doc = element.ownerDocument;
  const originalReadOnly = textarea.readOnly;
  const originalInputMode = textarea.inputMode;
  const originalDisabled = textarea.disabled;
  const suppressKeyboard = () => {
    textarea.readOnly = true;
    textarea.inputMode = 'none';
    // 只读属性不阻止聚焦；disabled 避免隐藏输入框被合成鼠标事件聚焦。
    textarea.disabled = true;
    textarea.blur();
  };
  const restoreKeyboard = () => {
    textarea.readOnly = originalReadOnly;
    textarea.inputMode = originalInputMode;
    textarea.disabled = originalDisabled;
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') suppressKeyboard();
    else if (event.pointerType === 'mouse' && element.contains(event.target as Node)) {
      const source = (event as PointerEvent & { sourceCapabilities?: { firesTouchEvents: boolean } }).sourceCapabilities;
      if (!source?.firesTouchEvents) restoreKeyboard();
    }
  };

  if ((doc.defaultView?.navigator.maxTouchPoints ?? 0) > 0) suppressKeyboard();
  // 捕获整个页面的触摸，覆盖 xterm 在 document 上处理的手势和延迟合成鼠标事件。
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('touchstart', suppressKeyboard, { capture: true, passive: true });

  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('touchstart', suppressKeyboard, true);
    restoreKeyboard();
  };
}

/** 安卓返回键收起软键盘后往往仍保留焦点，需主动释放，避免下次滑动再次拉起键盘。 */
export function installInputKeyboardGuard(input: HTMLTextAreaElement): () => void {
  const doc = input.ownerDocument;
  const view = doc.defaultView;
  if (!view) return () => {};
  const controls = input.closest('.input-bar') ?? input;
  const viewport = view.visualViewport;
  let fullHeight = viewport?.height ?? view.innerHeight;
  let lastWidth = view.innerWidth;
  let keyboardWasOpen = false;
  let touchStart: { x: number; y: number } | null = null;
  const blur = () => {
    if (doc.activeElement === input) input.blur();
  };
  const blurOutsideControls = (target: EventTarget | null) => {
    if (!controls.contains(target as Node | null)) blur();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') blurOutsideControls(event.target);
  };
  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches.item(0) : null;
    touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
    blurOutsideControls(event.target);
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!touchStart || event.target === input) return;
    const touch = event.touches.item(0);
    if (touch && Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) >= 8) blur();
  };
  const onTouchEnd = () => { touchStart = null; };
  const onResize = () => {
    const height = viewport?.height ?? view.innerHeight;
    // 旋转和缩放改变可视区域，不能当作键盘收起。
    if (view.innerWidth !== lastWidth || (viewport && viewport.scale !== 1)) {
      lastWidth = view.innerWidth;
      fullHeight = height;
      keyboardWasOpen = false;
      return;
    }
    fullHeight = Math.max(fullHeight, height);
    if (fullHeight - height > Math.max(120, fullHeight * 0.2)) {
      keyboardWasOpen = true;
    } else if (keyboardWasOpen && fullHeight - height < 60) {
      keyboardWasOpen = false;
      blur();
    }
  };

  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  doc.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
  doc.addEventListener('touchend', onTouchEnd, true);
  doc.addEventListener('touchcancel', onTouchEnd, true);
  viewport?.addEventListener('resize', onResize);
  view.addEventListener('resize', onResize);

  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('touchstart', onTouchStart, true);
    doc.removeEventListener('touchmove', onTouchMove, true);
    doc.removeEventListener('touchend', onTouchEnd, true);
    doc.removeEventListener('touchcancel', onTouchEnd, true);
    viewport?.removeEventListener('resize', onResize);
    view.removeEventListener('resize', onResize);
  };
}
