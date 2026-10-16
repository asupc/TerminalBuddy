import { FC, useState } from 'react';
import { ChevronRight, Cpu, ServerCog } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { LlmLaunchTarget } from '../../services/tauri';
import './ClaudeModelMenuSection.css';

interface ClaudeModelMenuSectionProps {
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
 */
export const ClaudeModelMenuSection: FC<ClaudeModelMenuSectionProps> = ({
  itemClassName,
  separatorClassName,
  title,
  onPickModel,
  onGotoProviders,
}) => {
  const targets = useAppStore(s => s.claudeLaunchTargets);
  const loaded = useAppStore(s => s.claudeLaunchTargetsLoaded);
  const [openSub, setOpenSub] = useState<string | null>(null);

  const defaultTarget = targets.find(target => target.isDefault);
  const otherTargets = targets.filter(target => !target.isDefault);

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
          className={`claude-model-subwrap${openSub === target.providerId ? ' open' : ''}`}
          onMouseEnter={() => setOpenSub(target.providerId)}
          onMouseLeave={() => setOpenSub(current => (current === target.providerId ? null : current))}
        >
          <div
            className={itemClassName}
            onClick={e => {
              e.stopPropagation();
              setOpenSub(current => (current === target.providerId ? null : target.providerId));
            }}
          >
            <span className="claude-model-menu-icon"><Cpu size={14} strokeWidth={1.6} /></span>
            <span className="claude-model-menu-label">{target.providerName}</span>
            <span className="claude-model-menu-arrow"><ChevronRight size={14} strokeWidth={1.6} /></span>
          </div>
          <div className="claude-model-submenu" onClick={e => e.stopPropagation()}>
            <div className={`${itemClassName} claude-model-menu-head`}>
              {target.providerName} · {target.models.length} 个可用模型
            </div>
            <ModelItems target={target} itemClassName={itemClassName} onPickModel={onPickModel} />
          </div>
        </div>
      ))}
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
