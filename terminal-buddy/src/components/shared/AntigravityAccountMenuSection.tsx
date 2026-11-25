import { FC } from 'react';
import { Settings2 } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { AgentIcon } from '../agent-chat/AgentIcon';
import './ClaudeModelMenuSection.css';

interface AntigravityAccountMenuSectionProps {
  itemClassName: string;
  separatorClassName: string;
  /** 选择某个账号启动：`null` 表示系统当前默认登录态，否则为已录入账号 ID。 */
  onPickAccount: (accountId: string | null) => void;
  /** 跳转到设置页管理 Antigravity 多账号。 */
  onManageAccounts: () => void;
}

/**
 * 项目右键菜单的「Antigravity (agy)」启动区：
 * 直接平铺已录入账号（不再使用二级子菜单），点击即按所选账号隔离并行启动。
 */
export const AntigravityAccountMenuSection: FC<AntigravityAccountMenuSectionProps> = ({
  itemClassName,
  separatorClassName,
  onPickAccount,
  onManageAccounts,
}) => {
  const accountState = useAppStore(s => s.antigravityAccountState);
  const accounts = accountState?.accounts ?? [];

  return (
    <>
      <div className={separatorClassName} />
      <div className={`${itemClassName} claude-model-menu-head`}>
        Antigravity (agy)
      </div>
      {accounts.map(account => (
        <div
          key={account.id}
          className={itemClassName}
          data-launch-agent="antigravity"
          title={account.email ? `${account.alias} (${account.email})` : account.alias}
          onClick={() => onPickAccount(account.id)}
        >
          <span className="claude-model-menu-icon">
            <AgentIcon provider="antigravity" />
          </span>
          <span className="claude-model-menu-label">{account.alias}</span>
          {account.isDefault && <span className="claude-model-menu-tag">默认</span>}
        </div>
      ))}
      <div
        className={itemClassName}
        data-launch-agent="antigravity"
        title="使用本机系统当前登录的 agy 账号"
        onClick={() => onPickAccount(null)}
      >
        <span className="claude-model-menu-icon">
          <AgentIcon provider="antigravity" />
        </span>
        <span className="claude-model-menu-label">
          {accounts.length > 0 ? '系统默认登录' : '默认账号启动'}
        </span>
      </div>
      {accounts.length === 0 && (
        <div
          className={itemClassName}
          onClick={e => {
            e.stopPropagation();
            onManageAccounts();
          }}
        >
          <span className="claude-model-menu-icon">
            <Settings2 size={14} strokeWidth={1.6} />
          </span>
          <span>配置 Antigravity 账号…</span>
        </div>
      )}
    </>
  );
};
