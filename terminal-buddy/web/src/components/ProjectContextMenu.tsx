import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ProjectContextMenu({
  x,
  y,
  children,
  onClose,
}: {
  x: number;
  y: number;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const closeRef = useRef(onClose);
  const pressedInside = useRef(false);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    menu.style.maxHeight = `${height - 16}px`;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(left + 8, Math.min(x, left + width - rect.width - 8)),
      top: Math.max(top + 8, Math.min(y, top + height - rect.height - 8)),
    });
  }, [x, y, children]);
  useEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      closeRef.current();
    };
    const resize = () => closeRef.current();
    const menuElement = ref.current;
    const previouslyFocused = document.activeElement;
    ref.current
      ?.querySelector<HTMLElement>('button:not(:disabled)')
      ?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', outside, true);
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      if (
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected &&
        (document.activeElement === document.body ||
          (document.activeElement && menuElement?.contains(document.activeElement)))
      )
        previouslyFocused.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div
      ref={ref}
      className="profile-context-menu project-context-menu"
      style={position}
      role="menu"
      aria-label="项目与命令操作"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDownCapture={() => {
        pressedInside.current = true;
      }}
      onClickCapture={(event) => {
        // 触屏长按松手的兼容 click 可能重定向到新菜单，必须再次按下才执行。
        if (!pressedInside.current && event.detail !== 0) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          onClose();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(
          ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
