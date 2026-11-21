/**
 * 前台可见性监听：窗口/标签页不可见时跳过后台轮询，回到前台时立即补刷一次。
 */
export function onPageVisible(callback: () => void): () => void {
  const handleVisibility = () => {
    if (!document.hidden) callback();
  };
  document.addEventListener('visibilitychange', handleVisibility);
  return () => document.removeEventListener('visibilitychange', handleVisibility);
}
