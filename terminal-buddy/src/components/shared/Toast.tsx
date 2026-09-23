import { FC, useEffect } from 'react';
import { useAppStore } from '../../stores/appStore';

/**
 * Transient toast notification (auto-dismiss ~2.5s).
 * Backed by the `toast` field in appStore; shown for split-screen "grid full"
 * and "exit split before editing" prompts.
 */
export const Toast: FC = () => {
  const toast = useAppStore(s => s.toast);
  const dismissToast = useAppStore(s => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => dismissToast(toast.id), 2500);
    return () => clearTimeout(t);
  }, [toast?.id, dismissToast]);

  if (!toast) return null;
  return (
    <div className={`tb-toast tb-toast-${toast.type}`}>{toast.message}</div>
  );
};
