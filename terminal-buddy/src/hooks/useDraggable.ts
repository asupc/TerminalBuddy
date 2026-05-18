import { useState, useRef, useCallback, useEffect } from 'react';

interface UseDraggableResult {
  offset: { x: number; y: number };
  dragHandleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
  };
}

export function useDraggable(excludeSelector: string = '.dialog-content'): UseDraggableResult {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (isDragging.current) return;
    if ((e.target as HTMLElement).closest(excludeSelector)) return;
    if (e.button !== 0) return;

    isDragging.current = true;
    dragStartPos.current = { x: e.clientX, y: e.clientY };

    document.body.style.userSelect = 'none';

    const handleMouseMove = (ev: MouseEvent) => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const dx = ev.clientX - dragStartPos.current.x;
        const dy = ev.clientY - dragStartPos.current.y;
        dragStartPos.current = { x: ev.clientX, y: ev.clientY };
        setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      });
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      isDragging.current = false;
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [excludeSelector]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      document.body.style.userSelect = '';
    };
  }, []);

  return {
    offset,
    dragHandleProps: { onMouseDown },
  };
}
