import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEventHandler,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './Dialog.css';

const dialogStack: symbol[] = [];
let nextLayer = 10000;

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const DRAG_EXCLUDED_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a',
  '[role="button"]',
  '[data-dialog-no-drag]',
].join(',');

function joinClassNames(...names: Array<string | undefined | false>): string {
  return names.filter(Boolean).join(' ');
}

export interface DialogProps {
  title?: ReactNode;
  ariaLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
  overlayClassName?: string;
  headerClassName?: string;
  titleClassName?: string;
  closeButtonClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  positionerClassName?: string;
  style?: CSSProperties;
  role?: 'dialog' | 'alertdialog';
  closeLabel?: string;
  closeDisabled?: boolean;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  autoFocus?: boolean;
  modal?: boolean;
  /** 受控可见性。传入后由该 prop 控制渲染与离场动画；不传则维持原有行为。 */
  open?: boolean;
  /** 离场动画时长（毫秒），仅在传入 open 时生效 */
  leaveDurationMs?: number;
  /** 受控模式下，离场动画结束后调用一次。父级可借此销毁外层包装。 */
  onExit?: () => void;
}

export function Dialog({
  title,
  ariaLabel,
  children,
  footer,
  onClose,
  className,
  overlayClassName,
  headerClassName,
  titleClassName,
  closeButtonClassName,
  bodyClassName,
  footerClassName,
  positionerClassName,
  style,
  role = 'dialog',
  closeLabel = '关闭',
  closeDisabled = false,
  onSubmit,
  autoFocus = true,
  modal = true,
  open,
  leaveDurationMs = 160,
  onExit,
}: DialogProps) {
  const titleId = useId();
  const stackIdRef = useRef(Symbol('dialog'));
  const layerRef = useRef<number | null>(null);
  const positionerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const offsetRef = useRef({ x: 0, y: 0 });
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // 受控 open 模式下的内部状态：mounted 控制是否渲染，phase 控制动画阶段
  const isControlled = open !== undefined;
  const [mounted, setMounted] = useState(!isControlled || open !== false);
  const [phase, setPhase] = useState<'enter' | 'open' | 'leave'>(
    isControlled && open === false ? 'leave' : 'enter',
  );
  // 在 keydown 中读取最新 phase，避免 leave 阶段的关闭反复触发
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const leaveTimerRef = useRef<number | null>(null);
  if (layerRef.current === null) layerRef.current = nextLayer++;
  onCloseRef.current = onClose;
  closeDisabledRef.current = closeDisabled;

  // 受控模式：监听 open 切换进入/离开阶段
  useEffect(() => {
    if (!isControlled) return;
    if (open) {
      if (leaveTimerRef.current !== null) {
        window.clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      setMounted(true);
      setPhase('enter');
      // 下一帧切换到 open，让入场动画从头播
      const id = requestAnimationFrame(() => setPhase('open'));
      return () => cancelAnimationFrame(id);
    }
    // phase 只能用 ref 读：一旦进依赖数组，上面 rAF 的 enter→open 切换会让本 effect 重跑
    // 并把 phase 打回 enter，形成每帧往复的死循环，入场动画被反复重启 → 弹窗闪烁
    if (open === false && phaseRef.current !== 'leave') {
      setPhase('leave');
      leaveTimerRef.current = window.setTimeout(() => {
        setMounted(false);
        leaveTimerRef.current = null;
        onExitRef.current?.();
      }, leaveDurationMs);
    }
  }, [open, isControlled, leaveDurationMs]);

  // 非受控模式：mount 后下一帧切换到 open，触发入场动画
  useEffect(() => {
    if (isControlled) return;
    const id = requestAnimationFrame(() => setPhase('open'));
    return () => cancelAnimationFrame(id);
  }, [isControlled]);

  // 卸载时清掉未触发的 timer，避免在快速切换时残留
  useEffect(() => {
    return () => {
      if (leaveTimerRef.current !== null) {
        window.clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const stackId = stackIdRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogStack.push(stackId);

    const focusFrame = autoFocus
      ? requestAnimationFrame(() => {
          const surface = surfaceRef.current;
          const preferred = surface?.querySelector<HTMLElement>('[autofocus]');
          (preferred ?? closeButtonRef.current)?.focus();
        })
      : null;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== stackId) return;
      // 离场阶段忽略键盘，避免反复触发关闭
      if (phaseRef.current === 'leave') return;

      if (event.key === 'Escape' && !closeDisabledRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab' || !modal) return;
      const surface = surfaceRef.current;
      if (!surface) return;
      const focusable = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(element => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !surface.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !surface.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      const index = dialogStack.lastIndexOf(stackId);
      if (index >= 0) dialogStack.splice(index, 1);
      dragCleanupRef.current?.();
      if (autoFocus && previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [autoFocus, modal]);

  const handleDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    if ((event.target as HTMLElement).closest(DRAG_EXCLUDED_SELECTOR)) return;

    const positioner = positionerRef.current;
    if (!positioner) return;
    event.preventDefault();

    dragCleanupRef.current?.();
    const pointerId = event.pointerId;
    const startClient = { x: event.clientX, y: event.clientY };
    const startOffset = { ...offsetRef.current };
    const startRect = positioner.getBoundingClientRect();
    const previousUserSelect = document.body.style.userSelect;
    let latestClient = startClient;
    let frame: number | null = null;

    const applyPosition = () => {
      frame = null;
      const desiredX = startOffset.x + latestClient.x - startClient.x;
      const desiredY = startOffset.y + latestClient.y - startClient.y;
      const minX = startOffset.x + 8 - startRect.left;
      const maxX = startOffset.x + window.innerWidth - 8 - startRect.right;
      const minY = startOffset.y + 8 - startRect.top;
      const maxY = startOffset.y + window.innerHeight - 8 - startRect.bottom;
      const x = Math.min(Math.max(desiredX, minX), Math.max(minX, maxX));
      const y = Math.min(Math.max(desiredY, minY), Math.max(minY, maxY));
      offsetRef.current = { x, y };
      positioner.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latestClient = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (frame === null) frame = requestAnimationFrame(applyPosition);
    };

    const cleanup = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        applyPosition();
      }
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerEnd);
      document.removeEventListener('pointercancel', handlePointerEnd);
      window.removeEventListener('blur', cleanup);
      document.body.style.userSelect = previousUserSelect;
      positioner.classList.remove('dragging');
      dragCleanupRef.current = null;
    };

    const handlePointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      cleanup();
    };

    positioner.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerup', handlePointerEnd);
    document.addEventListener('pointercancel', handlePointerEnd);
    window.addEventListener('blur', cleanup);
    dragCleanupRef.current = cleanup;
  };

  const hasTitle = title !== undefined && title !== null && title !== '';
  const accessibleName = !hasTitle ? (ariaLabel ?? '弹窗') : ariaLabel;
  const surfaceContent = (
    <>
      <header className={joinClassNames('tb-dialog-header', headerClassName)} onPointerDown={handleDragStart}>
        <div
          id={hasTitle ? titleId : undefined}
          className={joinClassNames('tb-dialog-title', titleClassName)}
        >
          {title}
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          className={joinClassNames('tb-dialog-close', closeButtonClassName)}
          onClick={onClose}
          disabled={closeDisabled}
          title={closeLabel}
          aria-label={closeLabel}
          data-dialog-no-drag
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className={joinClassNames('tb-dialog-body', bodyClassName)}>{children}</div>
      {footer !== undefined && (
        <footer className={joinClassNames('tb-dialog-footer', footerClassName)}>{footer}</footer>
      )}
    </>
  );

  const sharedSurfaceProps = {
    className: joinClassNames('tb-dialog-surface', className),
    style,
    role,
    'aria-modal': modal,
    'aria-labelledby': hasTitle && !ariaLabel ? titleId : undefined,
    'aria-label': accessibleName,
  } as const;

  if (!mounted) return null;

  return createPortal(
    <div
      className={joinClassNames('tb-dialog-overlay', !modal && 'tb-dialog-overlay-nonmodal', overlayClassName)}
      style={{ zIndex: layerRef.current }}
      data-state={phase}
    >
      <div ref={positionerRef} className={joinClassNames('tb-dialog-positioner', positionerClassName)}>
        {onSubmit ? (
          <form
            {...sharedSurfaceProps}
            data-state={phase}
            ref={element => { surfaceRef.current = element; }}
            onSubmit={onSubmit}
          >
            {surfaceContent}
          </form>
        ) : (
          <section
            {...sharedSurfaceProps}
            data-state={phase}
            ref={element => { surfaceRef.current = element; }}
          >
            {surfaceContent}
          </section>
        )}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  title?: ReactNode;
  message: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: 'primary' | 'danger';
}

export function ConfirmDialog({
  title,
  message,
  onClose,
  onConfirm,
  confirmText = '确定',
  cancelText = '取消',
  confirmVariant = 'danger',
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(true);
  const requestClose = () => setOpen(false);
  return (
    <Dialog
      open={open}
      onClose={requestClose}
      onExit={onClose}
      title={title}
      role="alertdialog"
      className="tb-confirm-dialog"
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={requestClose}>{cancelText}</button>
          <button type="button" className={`btn-${confirmVariant}`} onClick={() => { onConfirm(); requestClose(); }}>{confirmText}</button>
        </>
      )}
    >
      <div className="tb-confirm-message">{message}</div>
    </Dialog>
  );
}
