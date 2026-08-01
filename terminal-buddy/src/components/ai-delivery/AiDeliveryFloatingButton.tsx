import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Bot } from 'lucide-react';
import {
  getAppSettings,
  saveAppSettings,
  type AiDeliveryFloatingButtonPosition,
} from '../../utils/settings';
import './AiDeliveryFloatingButton.css';

const BUTTON_SIZE = 48;
const VIEWPORT_MARGIN = 12;
const TITLEBAR_SAFE_TOP = 44;

interface AiDeliveryFloatingButtonProps {
  active: boolean;
  onToggle: () => void;
}

const clampPosition = (position: AiDeliveryFloatingButtonPosition): AiDeliveryFloatingButtonPosition => ({
  x: Math.min(
    Math.max(VIEWPORT_MARGIN, position.x),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - BUTTON_SIZE - VIEWPORT_MARGIN),
  ),
  y: Math.min(
    Math.max(TITLEBAR_SAFE_TOP, position.y),
    Math.max(TITLEBAR_SAFE_TOP, window.innerHeight - BUTTON_SIZE - VIEWPORT_MARGIN),
  ),
});

export function AiDeliveryFloatingButton({ active, onToggle }: AiDeliveryFloatingButtonProps) {
  const [position, setPosition] = useState<AiDeliveryFloatingButtonPosition | null>(
    () => getAppSettings().aiDeliveryFloatingButtonPosition,
  );
  const positionRef = useRef(position);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: AiDeliveryFloatingButtonPosition;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  positionRef.current = position;

  const persistPosition = (next: AiDeliveryFloatingButtonPosition) => {
    setPosition(next);
    positionRef.current = next;
    saveAppSettings({ ...getAppSettings(), aiDeliveryFloatingButtonPosition: next });
  };

  useEffect(() => {
    const restorePosition = () => {
      if (positionRef.current) return;
      const saved = getAppSettings().aiDeliveryFloatingButtonPosition;
      if (!saved) return;
      const next = clampPosition(saved);
      positionRef.current = next;
      setPosition(next);
    };
    restorePosition();
    window.addEventListener('app-settings-changed', restorePosition);
    return () => window.removeEventListener('app-settings-changed', restorePosition);
  }, []);

  useEffect(() => {
    const keepInViewport = () => {
      const current = positionRef.current;
      if (!current) return;
      const next = clampPosition(current);
      if (next.x !== current.x || next.y !== current.y) persistPosition(next);
    };
    keepInViewport();
    window.addEventListener('resize', keepInViewport);
    return () => window.removeEventListener('resize', keepInViewport);
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: rect.left, y: rect.top },
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;

    drag.moved = true;
    const next = clampPosition({ x: drag.origin.x + deltaX, y: drag.origin.y + deltaY });
    setPosition(next);
    positionRef.current = next;
  };

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) return;
    suppressClickRef.current = true;
    persistPosition(positionRef.current ?? drag.origin);
  };

  const handleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onToggle();
  };

  const style: CSSProperties | undefined = position
    ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' }
    : undefined;

  return (
    <button
      type="button"
      className={`ai-delivery-floating-button${active ? ' active' : ''}`}
      style={style}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onClick={handleClick}
      title={active ? '关闭 AI 交付' : '打开 AI 交付'}
      aria-label={active ? '关闭 AI 交付' : '打开 AI 交付'}
      aria-pressed={active}
    >
      <Bot size={20} aria-hidden="true" />
    </button>
  );
}
