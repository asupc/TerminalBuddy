import { useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { useAppStore } from '../../../stores/appStore';

export interface UseDragDropOptions {
  terminalRef: React.RefObject<HTMLDivElement | null>;
  isActiveRef: React.MutableRefObject<boolean | undefined>;
  readOnly?: boolean;
  /** 拖放路径落地后的处理（输出到 PTY 并聚焦）。 */
  onDrop: (text: string) => void;
}

/** Tauri 原生拖放 + FileTree 内部拖放两条路径的接收端。 */
export function useDragDrop(opts: UseDragDropOptions) {
  const [dragOver, setDragOver] = useState(false);
  const [internalDragOver, setInternalDragOver] = useState(false);

  // Tauri native drag-drop: listen for file drops into the window
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      if (event.payload.type === 'enter') {
        if (opts.isActiveRef.current) setDragOver(true);
      } else if (event.payload.type === 'over') {
        // hovering — keep drag-over state
      } else if (event.payload.type === 'drop') {
        setDragOver(false);
        if (!opts.isActiveRef.current || opts.readOnly) return;
        const paths = event.payload.paths;
        if (paths && paths.length > 0) {
          opts.onDrop(paths.join(' '));
        }
      } else {
        // 'leave' / cancel
        setDragOver(false);
      }
    }).then(fn => {
      if (cancelled) { fn(); return; }
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Internal drag from FileTree: detect mouseup to receive dropped paths
  useEffect(() => {
    const el = opts.terminalRef.current;
    if (!el) return;

    const handleMouseUp = () => {
      const paths = useAppStore.getState().dragPaths;
      if (!paths || !opts.isActiveRef.current || opts.readOnly) return;
      setInternalDragOver(false);
      opts.onDrop(paths.join(' '));
      useAppStore.getState().setDragPaths(null);
    };

    const handleMouseMove = (e: MouseEvent) => {
      const paths = useAppStore.getState().dragPaths;
      if (!paths || !opts.isActiveRef.current) return;
      const rect = el.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right
                  && e.clientY >= rect.top && e.clientY <= rect.bottom;
      setInternalDragOver(inside);
    };

    el.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousemove', handleMouseMove);
    return () => {
      el.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousemove', handleMouseMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { dragOver, internalDragOver };
}
