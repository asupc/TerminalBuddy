import { FC, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Settings2, User } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { CONTEXT_MENU_MARGIN } from '../../utils/contextMenu';
import { AgentIcon } from '../agent-chat/AgentIcon';
import './ClaudeModelMenuSection.css';

const SUB_CLOSE_DELAY = 120;

interface AntigravityAccountMenuSectionProps {
  itemClassName: string;
  separatorClassName: string;
  submenuClassName?: string;
  /** 选择某个账号启动：`null` 表示系统当前默认登录态，否则为已录入账号 ID。 */
  onPickAccount: (accountId: string | null) => void;
  /** 跳转到设置页管理 Antigravity 多账号。 */
  onManageAccounts: () => void;
}

/**
 * 项目右键菜单的「Antigravity (agy)」启动项：
 * - 未录入多账号时直接点击以系统当前登录启动，悬停也可打开子菜单跳转账号管理；
 * - 已录入多账号时，悬停或点击展开账号列表，可任选账号并行隔离启动。
 */
export const AntigravityAccountMenuSection: FC<AntigravityAccountMenuSectionProps> = ({
  itemClassName,
  separatorClassName,
  submenuClassName,
  onPickAccount,
  onManageAccounts,
}) => {
  const accountState = useAppStore(s => s.antigravityAccountState);
  const accounts = accountState?.accounts ?? [];
  const [openSub, setOpenSub] = useState(false);
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
    closeTimerRef.current = window.setTimeout(() => setOpenSub(false), SUB_CLOSE_DELAY);
  };

  useEffect(() => cancelClose, []);

  const openSubAt = (anchor: HTMLElement) => {
    cancelClose();
    const rect = anchor.getBoundingClientRect();
    anchorRef.current = rect;
    setSubPos({ left: rect.right + 2, top: rect.top - 4 });
    setOpenSub(true);
  };

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = subRef.current;
    if (!openSub || !anchor || !menu) return;
    const { width, height } = menu.getBoundingClientRect();
    let left = anchor.right + 2;
    if (left + width + CONTEXT_MENU_MARGIN > window.innerWidth) {
      const flipped = anchor.left - width - 2;
      left = flipped >= CONTEXT_MENU_MARGIN
        ? flipped
        : Math.max(CONTEXT_MENU_MARGIN, window.innerWidth - width - CONTEXT_MENU_MARGIN);
    }
    let top = anchor.top - 4;
    if (top + height + CONTEXT_MENU_MARGIN > window.innerHeight) {
      top = window.innerHeight - height - CONTEXT_MENU_MARGIN;
    }
    if (top < CONTEXT_MENU_MARGIN) top = CONTEXT_MENU_MARGIN;
    setSubPos({ left, top });
  }, [openSub, accounts.length]);

  useEffect(() => {
    if (!openSub) return;
    const close = () => setOpenSub(false);
    const handleScroll = (event: Event) => {
      if (event.target instanceof Node && subRef.current?.contains(event.target)) return;
      setOpenSub(false);
    };
    window.addEventListener('resize', close);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [openSub]);

  return (
    <>
      <div className={separatorClassName} />
      <div
        className={`${itemClassName} claude-model-menu-trigger${openSub ? ' is-open' : ''}`}
        data-launch-agent="antigravity"
        title={accounts.length > 0 ? '选择 Antigravity 启动账号' : '启动 Antigravity CLI（agy）'}
        onMouseEnter={e => openSubAt(e.currentTarget)}
        onMouseLeave={scheduleClose}
        onClick={e => {
          if (accounts.length === 0) {
            onPickAccount(null);
          } else if (openSub) {
            setOpenSub(false);
          } else {
            openSubAt(e.currentTarget);
          }
        }}
      >
        <span className="claude-model-menu-icon">
          <AgentIcon provider="antigravity" />
        </span>
        <span className="claude-model-menu-label">Antigravity (agy)</span>
        <ChevronRight size={13} className="claude-model-menu-arrow" />
      </div>

      {openSub && subPos && createPortal(
        <div
          ref={subRef}
          className={`claude-model-submenu${submenuClassName ? ` ${submenuClassName}` : ''}`}
          style={{ left: subPos.left, top: subPos.top }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onMouseDown={e => e.stopPropagation()}
        >
          {accounts.map(account => (
            <div
              key={account.id}
              className={itemClassName}
              title={account.email || account.alias}
              onClick={() => {
                setOpenSub(false);
                onPickAccount(account.id);
              }}
            >
              <span className="claude-model-menu-icon">
                <User size={13} />
              </span>
              <span className="claude-model-menu-label">
                {account.alias}
                {account.email && account.email !== account.alias ? ` (${account.email})` : ''}
              </span>
              {account.isDefault && <span className="claude-model-menu-tag">默认</span>}
            </div>
          ))}
          {accounts.length > 0 && <div className={separatorClassName} />}
          <div
            className={itemClassName}
            title="使用本机系统当前登录的 agy 账号"
            onClick={() => {
              setOpenSub(false);
              onPickAccount(null);
            }}
          >
            <span className="claude-model-menu-icon">
              <AgentIcon provider="antigravity" />
            </span>
            <span className="claude-model-menu-label">系统默认登录</span>
          </div>
          <div className={separatorClassName} />
          <div
            className={itemClassName}
            onClick={() => {
              setOpenSub(false);
              onManageAccounts();
            }}
          >
            <span className="claude-model-menu-icon">
              <Settings2 size={13} />
            </span>
            <span className="claude-model-menu-label">管理 Antigravity 账号…</span>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};
