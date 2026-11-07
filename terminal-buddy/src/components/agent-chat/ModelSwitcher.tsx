import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { aiCatalog, type AiCatalog } from '../../services/tauri';

interface ModelSwitcherProps {
  /** 当前会话的供应商与模型（用于高亮与显示名称）。 */
  providerId?: string | null;
  providerName?: string | null;
  model?: string | null;
  /** 只列出该 Agent 的供应商；原生会话按 Claude / Codex 过滤。 */
  agent: 'claude' | 'codex';
  /** 运行中或有排队消息时禁用，避免与正在执行的回合冲突。 */
  disabled: boolean;
  disabledReason?: string;
  onPick: (providerId: string, model: string) => void;
}

const MENU_WIDTH = 280;

/**
 * 原生会话头部的供应商 / 模型下拉。数据源是服务端 `ai_catalog`（不含密钥），
 * 与手机首页的模型选择保持一致。头部副标题有 overflow: hidden，菜单经 portal
 * 挂到 body 上、按触发器定位，避免被裁剪。
 */
export function ModelSwitcher({ providerId, providerName, model, agent, disabled, disabledReason, onPick }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [catalog, setCatalog] = useState<AiCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || catalog) return;
    let disposed = false;
    aiCatalog()
      .then(value => { if (!disposed) setCatalog(value); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [open, catalog]);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      let top = rect.bottom + 6;
      // 预估高度 360：下方放不下时翻到触发器上方。
      if (top + 360 > window.innerHeight - 8) top = Math.max(8, rect.top - 366);
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - MENU_WIDTH - 8));
      setMenuPos({ left, top });
    }
    setOpen(true);
  };

  // 点击触发器与菜单之外的位置关闭；窗口缩放后坐标失效直接收起。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const providers = useMemo(
    () => (catalog?.providers ?? []).filter(item => item.agent === agent && item.id !== `default:${agent}`),
    [catalog, agent],
  );

  const label = model
    ? `${model}${providerName ? ` · ${providerName}` : ''}`
    : '服务端默认模型';

  return (
    <div className="agent-model-switcher">
      <button
        type="button"
        ref={triggerRef}
        className="agent-model-trigger"
        disabled={disabled}
        title={disabled ? disabledReason : '切换供应商与模型'}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span className="agent-chat-meta">{label}</span>
        <ChevronDown className="agent-model-caret" aria-hidden="true" />
      </button>
      {open && menuPos && createPortal(
        <div className="agent-model-menu" ref={menuRef} role="listbox" style={{ left: menuPos.left, top: menuPos.top, width: MENU_WIDTH }}>
          {error && <div className="agent-model-empty">{error}</div>}
          {!error && !catalog && <div className="agent-model-empty">正在读取供应商…</div>}
          {catalog && providers.length === 0 && <div className="agent-model-empty">暂无可用供应商，请先在服务端配置。</div>}
          {providers.map(provider => (
            <div key={provider.id} className="agent-model-group">
              <div className="agent-model-group-title">{provider.name}{provider.isDefault ? '（默认）' : ''}</div>
              {provider.models.filter(item => item.id).map(item => {
                const active = provider.id === providerId && item.id === model;
                return (
                  <button
                    key={`${provider.id}:${item.id}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`agent-model-option${active ? ' active' : ''}`}
                    onClick={() => {
                      setOpen(false);
                      if (!active) onPick(provider.id, item.id);
                    }}
                  >
                    <span className="mono">{item.label || item.id}</span>
                    {item.effort && <span className="agent-model-effort">{item.effort}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
