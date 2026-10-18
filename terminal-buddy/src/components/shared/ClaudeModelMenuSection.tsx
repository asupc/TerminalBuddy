import { FC, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Cpu, ServerCog } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { LlmLaunchTarget } from '../../services/tauri';
import { CONTEXT_MENU_MARGIN } from '../../utils/contextMenu';
import './ClaudeModelMenuSection.css';

/** 鼠标移出触发项后的收起延迟：子菜单已脱离父菜单的 DOM，需留出移过去的时间。 */
const SUB_CLOSE_DELAY = 120;

interface ClaudeModelMenuSectionProps {
  /** 启动与历史恢复菜单的数据源。 */
  source?: 'claude' | 'codex';
  /** 一级菜单项容器类名（两种右键菜单样式不同，调用方传入） */
  itemClassName: string;
  /** 分隔线类名 */
  separatorClassName: string;
  /** 模型区标题：'Claude 模型'（启动）/ '指定模型恢复'（历史） */
  title: string;
  /** 点击模型：(providerId, modelId) */
  onPickModel: (providerId: string, modelId: string) => void;
  /** 点击引导项：跳转供应商页 */
  onGotoProviders: () => void;
}

/**
 * 模型启动/恢复的右键菜单区（ConfigNav 与 HistoryPanel 共用）：
 * 默认供应商可用模型平铺，其他供应商二级子菜单；无供应商时显示引导项。
 * 数据源为 store 缓存（挂载＋供应商变更时刷新），右键打开时不 await。
 *
 * 子菜单用 portal 挂到 body 上浮在菜单右侧：父菜单是 overflow 滚动容器
 * （菜单过高时可滚），留在其内部会被裁掉，只留下横向滚动条。
 */
export const ClaudeModelMenuSection: FC<ClaudeModelMenuSectionProps> = ({
  source = 'claude',
  itemClassName,
  separatorClassName,
  title,
  onPickModel,
  onGotoProviders,
}) => {
  const claudeTargets = useAppStore(s => s.claudeLaunchTargets);
  const claudeLoaded = useAppStore(s => s.claudeLaunchTargetsLoaded);
  const codexState = useAppStore(s => s.codexProviderState);
  const targets = useMemo<LlmLaunchTarget[]>(() => source === 'claude' ? claudeTargets : (codexState?.providers ?? []).map(provider => ({
    providerId: provider.id, providerName: provider.name, isDefault: codexState?.activeProviderId === provider.id,
    models: (provider.models ?? [provider.model]).map(id => ({ id, effort: (provider.modelReasoningEfforts[id] ?? 'max') || '默认', contextWindow: provider.contextWindow })),
  })), [source, claudeTargets, codexState]);
  const loaded = source === 'claude' ? claudeLoaded : codexState !== null;
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<DOMRect | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpenSub(null), SUB_CLOSE_DELAY);
  };

  useEffect(() => cancelClose, []);

  /** 展开某个供应商的子菜单：先按触发项右侧定位，useLayoutEffect 再按实际尺寸修正。 */
  const openSubAt = (providerId: string, anchor: HTMLElement) => {
    cancelClose();
    const rect = anchor.getBoundingClientRect();
    anchorRef.current = rect;
    setSubPos({ left: rect.right + 2, top: rect.top - 4 });
    setOpenSub(providerId);
  };

  const toggleSub = (providerId: string, anchor: HTMLElement) => {
    if (openSub === providerId) setOpenSub(null);
    else openSubAt(providerId, anchor);
  };

  // 首帧已渲染在触发项右侧，量出真实尺寸后做越界钳制与左右翻转。
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = subRef.current;
    if (!openSub || !anchor || !menu) return;
    const { width, height } = menu.getBoundingClientRect();
    let left = anchor.right + 2;
    if (left + width + CONTEXT_MENU_MARGIN > window.innerWidth) {
      const flipped = anchor.left - width - 2;
      // 左侧也放不下时退化为贴视口右缘。
      left = flipped >= CONTEXT_MENU_MARGIN
        ? flipped
        : Math.max(CONTEXT_MENU_MARGIN, window.innerWidth - width - CONTEXT_MENU_MARGIN);
    }
    let top = anchor.top - 4;
    if (top + height + CONTEXT_MENU_MARGIN > window.innerHeight) top = window.innerHeight - height - CONTEXT_MENU_MARGIN;
    if (top < CONTEXT_MENU_MARGIN) top = CONTEXT_MENU_MARGIN;
    setSubPos({ left, top });
  }, [openSub]);

  // 锚点随窗口缩放或菜单滚动移动后坐标失效，直接收起。
  useEffect(() => {
    if (!openSub) return;
    const close = () => setOpenSub(null);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [openSub]);

  const defaultTarget = targets.find(target => target.isDefault);
  const otherTargets = targets.filter(target => !target.isDefault);
  const openTarget = openSub ? targets.find(target => target.providerId === openSub) : undefined;

  if (!loaded || targets.length === 0) {
    return (
      <>
        <div className={separatorClassName} />
        <div className={`${itemClassName} claude-model-menu-head`}>{title}</div>
        <div
          className={itemClassName}
          onClick={e => { e.stopPropagation(); onGotoProviders(); }}
        >
          <span className="claude-model-menu-icon"><ServerCog size={14} strokeWidth={1.6} /></span>
          <span>配置模型供应商…</span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className={separatorClassName} />
      <div className={`${itemClassName} claude-model-menu-head`}>
        {title}{defaultTarget ? ` · ${defaultTarget.providerName}（默认）` : ''}
      </div>
      {defaultTarget && <ModelItems
        target={defaultTarget}
        itemClassName={itemClassName}
        onPickModel={onPickModel}
      />}
      {otherTargets.map(target => (
        <div
          key={target.providerId}
          className={itemClassName}
          onMouseEnter={e => openSubAt(target.providerId, e.currentTarget)}
          onMouseLeave={scheduleClose}
          onClick={e => { e.stopPropagation(); toggleSub(target.providerId, e.currentTarget); }}
        >
          <span className="claude-model-menu-icon"><Cpu size={14} strokeWidth={1.6} /></span>
          <span className="claude-model-menu-label">{target.providerName}</span>
          <span className="claude-model-menu-arrow"><ChevronRight size={14} strokeWidth={1.6} /></span>
        </div>
      ))}
      {openTarget && subPos && createPortal(
        <div
          ref={subRef}
          className="claude-model-submenu"
          style={{ left: subPos.left, top: subPos.top }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          // portal 后不在父菜单的 stopPropagation 范围内，两种关闭监听都要拦。
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          <div className={`${itemClassName} claude-model-menu-head`}>
            {openTarget.providerName} · {openTarget.models.length} 个可用模型
          </div>
          <ModelItems target={openTarget} itemClassName={itemClassName} onPickModel={onPickModel} />
        </div>,
        document.body,
      )}
    </>
  );
};

function ModelItems({ target, itemClassName, onPickModel }: {
  target: LlmLaunchTarget;
  itemClassName: string;
  onPickModel: (providerId: string, modelId: string) => void;
}) {
  if (target.models.length === 0) {
    return <div className={`${itemClassName} claude-model-menu-disabled`}>该供应商暂无可用模型</div>;
  }
  return (
    <>
      {target.models.map(model => (
        <div
          key={model.id}
          className={itemClassName}
          title={`${model.id}（${model.effort}）`}
          onClick={e => { e.stopPropagation(); onPickModel(target.providerId, model.id); }}
        >
          <span className="claude-model-menu-play">▶</span>
          <span className="claude-model-menu-label mono">{model.id}</span>
          <span className={`claude-model-effort effort-${model.effort}`}>{model.effort}</span>
        </div>
      ))}
    </>
  );
}
