import { FC, useEffect } from 'react';
import { ServerCog } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { resolveAntigravityEffort } from '../../utils/antigravityLaunch';
import './ClaudeModelMenuSection.css';

const EFFORT_SUFFIX_RE = /^(.*?)\s*\((low|medium|high|xhigh|max|minimal|none)\)$/i;

export function splitAntigravityModelDisplay(name: string): { label: string; effort: string | null } {
  const trimmed = name.trim();
  const match = trimmed.match(EFFORT_SUFFIX_RE);
  if (!match) return { label: trimmed, effort: null };
  return {
    label: match[1].trim() || trimmed,
    effort: match[2].toLowerCase(),
  };
}

interface AntigravityModelMenuSectionProps {
  /** 一级菜单项容器类名 */
  itemClassName: string;
  /** 分隔线类名 */
  separatorClassName: string;
  /** 区标题：默认 'Antigravity CLI'，历史菜单传 '指定模型恢复' */
  title?: string;
  /** 'launch' 在未启用模型时显示「默认模型启动」；'resume' 仅显示模型/配置项 */
  mode?: 'launch' | 'resume';
  /** 点击模型或默认启动时传入 modelId（可空）与解析后的 effort（可空） */
  onPickModel: (modelId?: string, effort?: string) => void;
  /** 跳转到「设置 → 模型供应商 → Antigravity」 */
  onGotoProviders: () => void;
}

/**
 * Antigravity CLI 模型菜单区（项目右键启动 & 历史会话右键指定模型恢复共用）：
 * 按用户在「设置 → 模型供应商 → Antigravity」勾选的模型平铺渲染并同步推理等级；
 * 尚未启用任何模型时，启动模式提供「默认模型启动」及配置入口。
 */
export const AntigravityModelMenuSection: FC<AntigravityModelMenuSectionProps> = ({
  itemClassName,
  separatorClassName,
  title = 'Antigravity CLI',
  mode = 'launch',
  onPickModel,
  onGotoProviders,
}) => {
  const config = useAppStore(s => s.antigravityProviderConfig);
  const loaded = useAppStore(s => s.antigravityProviderConfigLoaded);
  const refreshConfig = useAppStore(s => s.refreshAntigravityProviderConfig);

  useEffect(() => {
    if (!loaded && refreshConfig) {
      void refreshConfig();
    }
  }, [loaded, refreshConfig]);

  const enabledModels = config?.enabledModels ?? [];
  const defaultEffort = resolveAntigravityEffort(undefined, config?.defaultEffortLevel);

  if (enabledModels.length === 0) {
    return (
      <>
        <div className={separatorClassName} />
        <div className={`${itemClassName} claude-model-menu-head`}>{title}</div>
        {mode === 'launch' && (
          <div
            className={itemClassName}
            title={defaultEffort ? `使用默认模型并附加 --effort ${defaultEffort} 启动` : '使用默认模型直接启动 Antigravity CLI'}
            onClick={e => { e.stopPropagation(); onPickModel(undefined, defaultEffort); }}
          >
            <span className="claude-model-menu-play">▶</span>
            <span className="claude-model-menu-label">默认模型启动</span>
            {defaultEffort && (
              <span className={`claude-model-effort effort-${defaultEffort}`}>{defaultEffort}</span>
            )}
          </div>
        )}
        <div
          className={itemClassName}
          onClick={e => { e.stopPropagation(); onGotoProviders(); }}
        >
          <span className="claude-model-menu-icon"><ServerCog size={14} strokeWidth={1.6} /></span>
          <span>配置 Antigravity 模型…</span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className={separatorClassName} />
      <div className={`${itemClassName} claude-model-menu-head`}>{title}</div>
      {enabledModels.map(entry => {
        const resolvedEffort = resolveAntigravityEffort(entry.effortLevel, config?.defaultEffortLevel);
        const { label, effort: nameEffort } = splitAntigravityModelDisplay(entry.name || entry.id);
        const badgeEffort = resolvedEffort ?? nameEffort;
        return (
          <div
            key={entry.id}
            className={itemClassName}
            title={`${entry.name || entry.id} (${entry.id})${resolvedEffort ? ` · effort: ${resolvedEffort}` : ''}`}
            onClick={e => { e.stopPropagation(); onPickModel(entry.id, resolvedEffort); }}
          >
            <span className="claude-model-menu-play">▶</span>
            <span className="claude-model-menu-label">{label}</span>
            {badgeEffort && (
              <span className={`claude-model-effort effort-${badgeEffort}`}>{badgeEffort}</span>
            )}
          </div>
        );
      })}
    </>
  );
};
