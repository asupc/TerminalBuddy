import { useEffect, useRef, useState } from 'react';
import type { UnlistenFn } from '../../../services/remoteWorkspace/events';
import { useAppStore } from '../../../stores/appStore';
import { isBrowserClient, isRemoteWorkspace } from '../../../services/platform';
import { uploadFiles } from '../../../services/browser/connection';

export interface UseDragDropOptions {
  terminalRef: React.RefObject<HTMLDivElement | null>;
  isActiveRef: React.MutableRefObject<boolean | undefined>;
  readOnly?: boolean;
  /** 拖放路径落地后的处理（输出到 PTY 并聚焦）。 */
  onDrop: (text: string) => void;
}

/** Tauri 原生拖放 + FileTree 内部拖放两条路径的接收端。 */
export function useDragDrop(opts: UseDragDropOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [dragOver, setDragOver] = useState(false);
  const [internalDragOver, setInternalDragOver] = useState(false);

  // Tauri native drag-drop: listen for file drops into the window
  useEffect(() => {
    if (isBrowserClient()) {
      const element = opts.terminalRef.current;
      if (!element) return;
      const over = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); setDragOver(true); } };
      const leave = () => setDragOver(false);
      const drop = (event: DragEvent) => {
        event.preventDefault(); setDragOver(false);
        if (optsRef.current.readOnly || !optsRef.current.isActiveRef.current) return;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length) void uploadFiles(files).then(paths => {
          if (!optsRef.current.readOnly) optsRef.current.onDrop(paths.join(' '));
        })
          .catch(error => useAppStore.getState().showToast(error instanceof Error ? error.message : '文件上传失败', 'error'));
      };
      element.addEventListener('dragover', over); element.addEventListener('dragleave', leave); element.addEventListener('drop', drop);
      return () => { element.removeEventListener('dragover', over); element.removeEventListener('dragleave', leave); element.removeEventListener('drop', drop); };
    }
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void import('../../../services/remoteWorkspace/nativeWebview').then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      if (event.payload.type === 'enter') {
        if (optsRef.current.isActiveRef.current) setDragOver(true);
      } else if (event.payload.type === 'over') {
        // hovering — keep drag-over state
      } else if (event.payload.type === 'drop') {
        setDragOver(false);
        if (!optsRef.current.isActiveRef.current || optsRef.current.readOnly) return;
        const paths = event.payload.paths;
        if (paths && paths.length > 0) {
          if (isRemoteWorkspace()) {
            // 本机文件先经桌面代理上传到远程服务，再把服务器路径输入终端。
            void import('../../../services/remoteWorkspace/native').then(({ uploadRemoteWorkspaceFiles }) =>
              uploadRemoteWorkspaceFiles(paths),
            ).then(remotePaths => {
              optsRef.current.onDrop(remotePaths.join(' '));
            }).catch(error => useAppStore.getState().showToast(
              error instanceof Error ? error.message : String(error), 'error',
            ));
          } else {
            optsRef.current.onDrop(paths.join(' '));
          }
        }
      } else {
        // 'leave' / cancel
        setDragOver(false);
      }
    })).then(fn => {
      if (cancelled) { fn(); return; }
      unlisten = fn;
    }).catch(error => console.error('注册原生拖放失败:', error));

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
      if (!paths || !optsRef.current.isActiveRef.current || optsRef.current.readOnly) return;
      setInternalDragOver(false);
      optsRef.current.onDrop(paths.join(' '));
      useAppStore.getState().setDragPaths(null);
    };

    const handleMouseMove = (e: MouseEvent) => {
      const paths = useAppStore.getState().dragPaths;
      if (!paths || !optsRef.current.isActiveRef.current) {
        setInternalDragOver(false);
        return;
      }
      const rect = el.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right
                  && e.clientY >= rect.top && e.clientY <= rect.bottom;
      setInternalDragOver(inside);
    };

    const handleDocumentMouseUp = () => {
      setInternalDragOver(false);
    };

    el.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleDocumentMouseUp);
    return () => {
      el.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleDocumentMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { dragOver, internalDragOver };
}
