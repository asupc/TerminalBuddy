import { memo, useCallback, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';

/**
 * 图片预览弹窗：点击消息里的图片在应用内放大查看。
 *
 * 以前图片是 `<a target="_blank">` 直接指向本地文件 URL——在 Tauri WebView 里
 * 会新开一个浏览器标签页（甚至落到系统浏览器），既打断对话，也可能因为文件协议的
 * 跨源限制根本打不开。这里改为应用内轻量弹窗：遮罩点击或 Esc 关闭，
 * 多图之间可用左右箭头/方向键切换。
 */

interface Props {
  /** 待预览的图片（已解析成可直接渲染的 URL）。 */
  images: { url: string; name: string }[];
  /** 当前下标；由父组件持有，便于同一组图片之间切换。 */
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export const ImageLightbox = memo(function ImageLightbox({ images, index, onIndexChange, onClose }: Props) {
  const current = images[index];
  const dialogRef = useRef<HTMLDivElement>(null);
  // 打开前的焦点元素：关闭后还回去，键盘用户不会掉到页面顶部。
  const restoreRef = useRef<HTMLElement | null>(null);

  const step = useCallback((delta: number) => {
    if (images.length < 2) return;
    onIndexChange((index + delta + images.length) % images.length);
  }, [images.length, index, onIndexChange]);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => restoreRef.current?.focus?.();
  }, []);

  // 键盘操作：Esc 关闭，左右方向键切图。挂在 document 上，焦点落在任何位置都生效。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
      if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); return; }
      if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, step]);

  if (!current) return null;

  return (
    <div
      className="agent-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={current.name || '图片预览'}
      tabIndex={-1}
      ref={dialogRef}
      // 只有点在遮罩本身才关闭：点在图片或按钮上不触发。
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="agent-lightbox-bar">
        <span className="agent-lightbox-name" title={current.name}>{current.name}</span>
        <div className="agent-lightbox-actions">
          {images.length > 1 && (
            <span className="agent-lightbox-counter">{index + 1} / {images.length}</span>
          )}
          <a className="agent-lightbox-action" href={current.url} download={current.name || undefined} title="下载到本机">
            <Download aria-hidden="true" />
          </a>
          <button type="button" className="agent-lightbox-action" onClick={onClose} title="关闭（Esc）" aria-label="关闭预览">
            <X aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="agent-lightbox-stage">
        {images.length > 1 && (
          <button type="button" className="agent-lightbox-nav prev" title="上一张（←）" aria-label="上一张"
            onClick={() => step(-1)}>
            <ChevronLeft aria-hidden="true" />
          </button>
        )}
        <img className="agent-lightbox-image" src={current.url} alt={current.name || '图片预览'} />
        {images.length > 1 && (
          <button type="button" className="agent-lightbox-nav next" title="下一张（→）" aria-label="下一张"
            onClick={() => step(1)}>
            <ChevronRight aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
});
