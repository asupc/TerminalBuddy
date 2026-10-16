import { FC, useEffect, useState } from 'react';
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
      <div className="settings-section">
        <label className="settings-label" htmlFor="web-auth-page-title">主页标题</label>
        <div className="data-path-row">
          <input
            id="web-auth-page-title"
            className="data-path-input"
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
            className="btn-secondary"
            onClick={() => { void handleSaveTitle(); }}
            disabled={titleBusy}
          >
            {titleBusy ? '保存中…' : '保存'}
          </button>
        </div>
        {titleError && <p className="settings-desc" role="alert" style={{ color: 'var(--danger, #f14c4c)' }}>{titleError}</p>}
        {titleSaved && <p className="settings-desc" role="status" style={{ color: '#3fb950' }}>已保存并生效</p>}
        <p className="settings-desc">同时作用于登录页大标题与浏览器标签页标题，留空保存恢复默认「终端伙伴」</p>
      </div>

      <div className="settings-section">
        <label className="settings-label">修改登录密码</label>
        <div className="data-path-row">
          <input
            className="data-path-input"
            type="password"
            autoComplete="current-password"
            placeholder="旧密码"
            value={oldPassword}
            onChange={e => { setOldPassword(e.target.value); setPasswordError(''); setPasswordSuccess(''); }}
          />
        </div>
        <div className="data-path-row" style={{ marginTop: 8 }}>
          <input
            className="data-path-input"
            type="password"
            autoComplete="new-password"
            placeholder="新密码（至少 8 个字符）"
            value={newPassword}
            onChange={e => { setNewPassword(e.target.value); setPasswordError(''); setPasswordSuccess(''); }}
          />
        </div>
        <div className="data-path-row" style={{ marginTop: 8 }}>
          <input
            className="data-path-input"
            type="password"
            autoComplete="new-password"
            placeholder="确认新密码"
            value={confirmPassword}
            onChange={e => { setConfirmPassword(e.target.value); setPasswordError(''); setPasswordSuccess(''); }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !passwordBusy) void handleChangePassword();
            }}
          />
          <button
            className="btn-secondary"
            onClick={() => { void handleChangePassword(); }}
            disabled={passwordBusy || !oldPassword || !newPassword || !confirmPassword}
          >
            {passwordBusy ? '提交中…' : '修改密码'}
          </button>
        </div>
        {passwordError && <p className="settings-desc" role="alert" style={{ color: 'var(--danger, #f14c4c)' }}>{passwordError}</p>}
        {passwordSuccess && <p className="settings-desc" role="status" style={{ color: '#3fb950' }}>{passwordSuccess}</p>}
        <p className="settings-desc">修改 Docker 网页登录的管理员密码，需先验证旧密码</p>
      </div>
    </div>
  );
};
