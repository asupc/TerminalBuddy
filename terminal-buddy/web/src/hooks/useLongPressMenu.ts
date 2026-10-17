import { useEffect, useRef, type PointerEvent, type MouseEvent } from 'react';

/** 同时支持长按和右键；滚动、多指和取消手势不会启动条目。 */
export function useLongPressMenu<T>(open: (target: T, x: number, y: number) => void) {
  const callback = useRef(open);
  callback.current = open;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    target: T;
    cancelled: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const clear = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => clear, []);

  return (target: T) => ({
    onPointerDown(event: PointerEvent<HTMLElement>) {
      clear();
      if (!event.isPrimary) {
        gesture.current = null;
        suppressClick.current = true;
        return;
      }
      suppressClick.current = false;
      if (
        event.pointerType === 'mouse' ||
        (event.target as HTMLElement).closest('button, input, select, textarea')
      )
        return;
      gesture.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        target,
        cancelled: false,
      };
      timer.current = setTimeout(() => {
        const current = gesture.current;
        if (!current || current.cancelled) return;
        suppressClick.current = true;
        callback.current(current.target, current.x, current.y);
      }, 500);
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) {
        clear();
        current.cancelled = true;
        suppressClick.current = true;
      }
    },
    onPointerUp() {
      clear();
      gesture.current = null;
    },
    onPointerCancel() {
      clear();
      gesture.current = null;
      suppressClick.current = true;
    },
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (suppressClick.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onContextMenu(event: MouseEvent<HTMLElement>) {
      event.preventDefault();
      event.stopPropagation();
      clear();
      suppressClick.current = true;
      callback.current(target, event.clientX, event.clientY);
    },
  });
}
