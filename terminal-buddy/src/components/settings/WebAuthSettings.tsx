import { FC, useEffect, useState } from 'react';
import { Globe2, ShieldCheck } from 'lucide-react';
import { changeWebAdminPassword, getWebApiStatus, saveWebPageTitle } from '../../services/tauri';

/** 主页标题长度上限（按字符数计），与后端 WEB_PAGE_TITLE_MAX_CHARS 保持一致。 */
const PAGE_TITLE_MAX_CHARS = 60;

/**
 * Docker 版专属：网页认证设置。
 * 仅在 isDockerClient() 为 true 时由 SettingsPage 渲染（见 SettingsPage.tsx 的分区过滤）。
 */
export const WebAuthSettings: FC = () => {
  // 主页标题
  const [pageTitleDraft, setPageTitleDraft] = useState('');
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleError, setTitleError] = useState('');
  const [titleSaved, setTitleSaved] = useState(false);

  // 修改登录密码
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  useEffect(() => {
    let cancelled = false;
    getWebApiStatus()
      .then(status => {
        if (!cancelled) setPageTitleDraft(status.pageTitle ?? '');
      })
      .catch(() => {
        /* 读取失败时保留空草稿，保存阶段会再次暴露错误 */
      });
    return () => { cancelled = true; };
  }, []);

  const handleSaveTitle = async () => {
    const trimmed = pageTitleDraft.trim();
    if (Array.from(trimmed).length > PAGE_TITLE_MAX_CHARS) {
      setTitleError(`主页标题最多 ${PAGE_TITLE_MAX_CHARS} 个字符`);
      return;
    }
    setTitleBusy(true);
    setTitleError('');
    try {
      await saveWebPageTitle(trimmed);
      setPageTitleDraft(trimmed);
      // 保存成功后立即生效于浏览器标签页，无需刷新
      document.title = trimmed || 'TerminalBuddy';
      setTitleSaved(true);
      setTimeout(() => setTitleSaved(false), 2000);
    } catch (reason) {
      setTitleError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTitleBusy(false);
    }
  };

  const handleChangePassword = async () => {
    setPasswordError('');
    setPasswordSuccess('');
    // 预校验对齐后端规则：≥8 字符、UTF-8 ≤72 字节、两次输入一致
    if (Array.from(newPassword).length < 8) {
      setPasswordError('新密码至少需要 8 个字符');
      return;
    }
    if (new TextEncoder().encode(newPassword).length > 72) {
      setPasswordError('新密码过长，请缩短后重试');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }
    setPasswordBusy(true);
    try {
      await changeWebAdminPassword(oldPassword, newPassword);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess('密码已更新，下次登录请使用新密码；其他已登录设备不会被强制下线');
    } catch (reason) {
      setPasswordError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <div className="settings-general">
      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">
            <Globe2 size={14} aria-hidden="true" />
            品牌展示
          </span>
          <span className="s-status-chip ok">Docker 服务端模式</span>
        </div>
        <div className="settings-row settings-row--wrap-ctrl">
          <div className="settings-row-info">
            <label className="settings-row-title" htmlFor="web-auth-page-title">网页主页标题</label>
            <p className="settings-row-desc">
              同时作用于登录页大标题与浏览器标签页标题，留空保存恢复默认「终端伙伴」
            </p>
            {titleError && <p className="settings-inline-alert" role="alert">{titleError}</p>}
            {titleSaved && <p className="settings-inline-success" role="status">已保存并生效</p>}
          </div>
          <div className="settings-row-ctrl" style={{ width: 'min(320px, 100%)' }}>
            <input
              id="web-auth-page-title"
              className="tb-input"
              type="text"
              value={pageTitleDraft}
              placeholder="终端伙伴"
              maxLength={PAGE_TITLE_MAX_CHARS}
              onChange={e => {
                setPageTitleDraft(e.target.value);
                if (titleError) setTitleError('');
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !titleBusy) void handleSaveTitle();
              }}
            />
            <button
              type="button"
              className="btn-primary"
              onClick={() => { void handleSaveTitle(); }}
              disabled={titleBusy}
            >
              {titleBusy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">
            <ShieldCheck size={14} aria-hidden="true" />
            修改管理员登录密码
          </span>
          <span className="card-group-extra">最短 8 字符</span>
        </div>
        <div className="settings-card-block">
          <div className="web-auth-password-grid">
            <input
              className="tb-input"
              type="password"
              autoComplete="current-password"
              placeholder="旧密码"
              value={oldPassword}
              onChange={e => { setOldPassword(e.target.value); setPasswordError(''); setPasswordSuccess(''); }}
            />
            <input
              className="tb-input"
              type="password"
              autoComplete="new-password"
              placeholder="新密码（≥ 8 字符）"
              value={newPassword}
              onChange={e => { setNewPassword(e.target.value); setPasswordError(''); setPasswordSuccess(''); }}
            />
            <input
              className="tb-input"
              type="password"
              autoComplete="new-password"
              placeholder="确认新密码"
              value={confirmPassword}
              onChange={e => { setConfirmPassword(e.target.value); setPasswordError(''); setPasswordSuccess(''); }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !passwordBusy) void handleChangePassword();
              }}
            />
          </div>
          {passwordError && <p className="settings-inline-alert" role="alert">{passwordError}</p>}
          {passwordSuccess && <p className="settings-inline-success" role="status">{passwordSuccess}</p>}
          <div className="settings-card-footer-inline">
            <span className="settings-row-desc">
              修改 Docker 网页登录的管理员密码，需先验证旧密码；已签发且未过期的 JWT 不受影响
            </span>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => { void handleChangePassword(); }}
              disabled={passwordBusy || !oldPassword || !newPassword || !confirmPassword}
            >
              {passwordBusy ? '提交中…' : '提交修改'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
