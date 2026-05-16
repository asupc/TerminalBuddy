import { useState, useCallback, useRef, useEffect } from 'react';

interface UseResizablePanelOptions {
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  onResizeEnd?: (width: number) => void;
}

interface UseResizablePanelResult {
  width: number;
  setWidth: (width: number) => void;
  isResizing: boolean;
  resizeHandleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
  };
}

export function useResizablePanel({
  defaultWidth,
  minWidth = 150,
  maxWidth = 500,
  onResizeEnd,
}: UseResizablePanelOptions): UseResizablePanelResult {
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startXRef.current;
      const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + delta));
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, minWidth, maxWidth]);

  const onResizeEndRef = useRef(onResizeEnd);
  onResizeEndRef.current = onResizeEnd;

  const prevResizingRef = useRef(false);
  useEffect(() => {
    if (prevResizingRef.current && !isResizing) {
      onResizeEndRef.current?.(width);
    }
    prevResizingRef.current = isResizing;
  }, [isResizing, width]);

  return {
    width,
    setWidth,
    isResizing,
    resizeHandleProps: { onMouseDown: handleMouseDown },
  };
}
