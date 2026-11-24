import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export interface DragDropTarget {
  index: number;
  position: 'before' | 'after';
}

export interface DragReorder {
  containerRef: RefObject<HTMLDivElement | null>;
  draggingIndex: number | null;
  dropTarget: DragDropTarget | null;
  /** 行容器需要带 data-drag-index，并绑定到拖拽手柄的 onPointerDown。 */
  startDrag: (event: ReactPointerEvent<HTMLElement>, index: number) => void;
  /** 行 className 的拖拽状态后缀。 */
  dragClass: (index: number) => string;
}

/** 移动超过该距离才进入拖拽，避免单击手柄误触。 */
const DRAG_THRESHOLD = 4;

/**
 * 指针拖拽排序：用 document 级 pointermove 命中 data-drag-index 行，
 * 松开时一次性提交 from→to。Pointer 事件同时覆盖鼠标、触屏与手写笔，
 * 不走 HTML5 DnD（WebView2 上会被 Tauri 原生 drag-drop 抢占 drop 事件）。
 */
export function useDragReorder(onReorder: (from: number, to: number) => void): DragReorder {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<DragDropTarget | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    cleanupRef.current?.();
  }, []);

  const startDrag = (event: ReactPointerEvent<HTMLElement>, index: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupRef.current?.();
    const startY = event.clientY;
    let active = false;
    let target: DragDropTarget | null = null;
    let cleaned = false;

    const removeListeners = () => {
      if (cleaned) return;
      cleaned = true;
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      document.body.style.cursor = '';
      if (cleanupRef.current === abortDrag) cleanupRef.current = null;
    };

    const abortDrag = () => {
      removeListeners();
      setDraggingIndex(null);
      setDropTarget(null);
    };

    const finish = () => {
      removeListeners();
      setDraggingIndex(null);
      setDropTarget(null);
      if (!active || !target) return;
      // target 是拖动前的行下标；先按插入点计算，再补偿移除造成的左移。
      let to = target.index + (target.position === 'after' ? 1 : 0);
      if (index < to) to -= 1;
      if (to !== index) onReorder(index, to);
    };

    const handleMove = (moveEvent: PointerEvent) => {
      if (!active) {
        if (Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD) return;
        active = true;
        setDraggingIndex(index);
        document.body.style.cursor = 'grabbing';
      }
      const rows = containerRef.current?.querySelectorAll<HTMLElement>('[data-drag-index]') ?? [];
      let next: DragDropTarget | null = null;
      let last: DragDropTarget | null = null;
      for (const row of rows) {
        const rowIndex = Number(row.dataset.dragIndex);
        if (!Number.isInteger(rowIndex) || rowIndex === index) continue;
        const rect = row.getBoundingClientRect();
        if (moveEvent.clientY < rect.bottom) {
          next = {
            index: rowIndex,
            position: moveEvent.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
          };
          break;
        }
        last = { index: rowIndex, position: 'after' };
      }
      target = next ?? last;
      setDropTarget(previous => (
        previous?.index === target?.index && previous?.position === target?.position ? previous : target
      ));
    };

    cleanupRef.current = abortDrag;
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  };

  const dragClass = (index: number) => {
    if (draggingIndex === index) return ' dragging';
    if (dropTarget?.index !== index) return '';
    return dropTarget.position === 'before' ? ' drop-before' : ' drop-after';
  };

  return { containerRef, draggingIndex, dropTarget, startDrag, dragClass };
}
