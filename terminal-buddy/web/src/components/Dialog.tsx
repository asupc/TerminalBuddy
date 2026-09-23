import {
  useEffect,
  useId,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const dialogStack: symbol[] = [];
const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  title?: ReactNode;
  ariaLabel?: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}

export function Dialog({ title, ariaLabel, className, bodyClassName, children, footer, onClose }: DialogProps) {
  const titleId = useId();
  const stackIdRef = useRef(Symbol('web-dialog'));
  const positionerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const offsetRef = useRef({ x: 0, y: 0 });
  const dragCleanupRef = useRef<(() => void) | null>(null);
  onCloseRef.current = onClose;

  useEffect(() => {
    const stackId = stackIdRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogStack.push(stackId);
    const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== stackId) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !surfaceRef.current) return;
      const surface = surfaceRef.current;
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
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      const index = dialogStack.lastIndexOf(stackId);
      if (index >= 0) dialogStack.splice(index, 1);
      dragCleanupRef.current?.();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const handleDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
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
      if (endEvent.pointerId === pointerId) cleanup();
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

  return createPortal(
    <div className="web-dialog-overlay">
      <div ref={positionerRef} className="web-dialog-positioner">
        <section
          ref={surfaceRef}
          className={"web-dialog-surface" + (className ? " " + className : "")}
          role="dialog"
          aria-modal="true"
          aria-labelledby={hasTitle && !ariaLabel ? titleId : undefined}
          aria-label={!hasTitle ? (ariaLabel ?? '弹窗') : ariaLabel}
        >
          <header className="web-dialog-header" onPointerDown={handleDragStart}>
            <div id={hasTitle ? titleId : undefined} className="web-dialog-title">{title}</div>
            <button
              ref={closeButtonRef}
              type="button"
              className="web-dialog-close"
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div className={"web-dialog-body" + (bodyClassName ? " " + bodyClassName : "")}>{children}</div>
          {footer !== undefined && <footer className="web-dialog-footer">{footer}</footer>}
        </section>
      </div>
    </div>,
    document.body,
  );
}
