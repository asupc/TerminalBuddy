import { FC, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { AppSettings } from '../../utils/settings';
import { openUrl } from '../../services/tauri';

interface AiUsageSettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export const AiUsageSettings: FC<AiUsageSettingsProps> = ({ settings, updateSetting }) => {
  const [zhipuApiKeyVisible, setZhipuApiKeyVisible] = useState(false);
  const [qianfanCookieVisible, setQianfanCookieVisible] = useState(false);
  const [deepseekApiKeyVisible, setDeepseekApiKeyVisible] = useState(false);
  const [minimaxApiKeyVisible, setMinimaxApiKeyVisible] = useState(false);
  const [arkCookieVisible, setArkCookieVisible] = useState(false);

  // Tauri WebView 里 target="_blank" 不会拉起系统浏览器，统一走 openUrl 触发 ShellExecuteW。
  const handleOpenLink = (url: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    void openUrl(url);
  };

  return (
    <div className="settings-general">
      <div className="settings-section">
        <label className="settings-label">智谱 GLM API Key</label>
        <div className="data-path-row">
          <input
            className="data-path-input"
            type={zhipuApiKeyVisible ? 'text' : 'password'}
            value={settings.zhipuApiKey}
            onChange={(e) => updateSetting('zhipuApiKey', e.target.value)}
            placeholder="请输入智谱 GLM API Key"
            style={{ flex: 1 }}
          />
          <button
            className="btn-secondary"
            onClick={() => setZhipuApiKeyVisible(!zhipuApiKeyVisible)}
          >
            {zhipuApiKeyVisible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
            {zhipuApiKeyVisible ? '隐藏' : '显示'}
          </button>
        </div>
        <p className="settings-desc">填入智谱 GLM 的 API Key 用于查询 AI 用量信息。可在 <a href="https://open.bigmodel.cn" onClick={handleOpenLink('https://open.bigmodel.cn')} rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>open.bigmodel.cn</a> 获取</p>
      </div>

      <div className="settings-section">
        <label className="settings-label">百度千帆 Cookie</label>
        <div className="data-path-row">
          <input
            className="data-path-input"
            type={qianfanCookieVisible ? 'text' : 'password'}
            value={settings.qianfanCookie}
            onChange={(e) => updateSetting('qianfanCookie', e.target.value)}
            placeholder="请输入百度千帆的 Cookie"
            style={{ flex: 1 }}
          />
          <button
            className="btn-secondary"
            onClick={() => setQianfanCookieVisible(!qianfanCookieVisible)}
          >
            {qianfanCookieVisible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
            {qianfanCookieVisible ? '隐藏' : '显示'}
          </button>
        </div>
        <p className="settings-desc">填入百度千帆控制台的 Cookie 用于查询 AI 用量。登录 <a href="https://console.bce.baidu.com/qianfan/resource/subscribe" onClick={handleOpenLink('https://console.bce.baidu.com/qianfan/resource/subscribe')} rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>百度千帆控制台</a> 后，从浏览器开发者工具中复制完整的 Cookie 值</p>
      </div>

      <div className="settings-section">
        <label className="settings-label">DeepSeek 认证 Token</label>
        <div className="data-path-row">
          <input
            className="data-path-input"
            type={deepseekApiKeyVisible ? 'text' : 'password'}
            value={settings.deepseekApiKey}
            onChange={(e) => updateSetting('deepseekApiKey', e.target.value)}
            placeholder="请输入 DeepSeek 认证Token"
            style={{ flex: 1 }}
          />
          <button
            className="btn-secondary"
            onClick={() => setDeepseekApiKeyVisible(!deepseekApiKeyVisible)}
          >
            {deepseekApiKeyVisible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
            {deepseekApiKeyVisible ? '隐藏' : '显示'}
          </button>
        </div>
        <p className="settings-desc">填入 DeepSeek 的 认证Token 用于查询 AI 用量。可在 <a href="https://platform.deepseek.com/usage" onClick={handleOpenLink('https://platform.deepseek.com/usage')} rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>platform.deepseek.com/usage</a> 登录后打开浏览器开发者工具，查看网络请求获取 Authorization Bearer 值</p>
      </div>

      <div className="settings-section">
        <label className="settings-label">MiniMax API Key</label>
        <div className="data-path-row">
          <input
            className="data-path-input"
            type={minimaxApiKeyVisible ? 'text' : 'password'}
            value={settings.minimaxApiKey}
            onChange={(e) => updateSetting('minimaxApiKey', e.target.value)}
            placeholder="请输入 MiniMax API Key"
            style={{ flex: 1 }} />
          <button
            className="btn-secondary"
            onClick={() => setMinimaxApiKeyVisible(!minimaxApiKeyVisible)}
          >
            {minimaxApiKeyVisible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
            {minimaxApiKeyVisible ? '隐藏' : '显示'}
          </button>
        </div>
        <p className="settings-desc">填入 MiniMax 的 API Key 用于查询 AI 用量。可在 <a href="https://platform.minimax.chat/api_keys" onClick={handleOpenLink('https://platform.minimax.chat/api_keys')} rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>platform.minimax.chat</a> 获取</p>
      </div>

      <div className="settings-section">
        <label className="settings-label">火山方舟 Cookie</label>
        <div className="data-path-row">
          <input
            className="data-path-input"
            type={arkCookieVisible ? 'text' : 'password'}
            value={settings.arkCookie}
            onChange={(e) => updateSetting('arkCookie', e.target.value)}
            placeholder="请输入火山方舟控制台的 Cookie"
            style={{ flex: 1 }}
          />
          <button
            className="btn-secondary"
            onClick={() => setArkCookieVisible(!arkCookieVisible)}
          >
            {arkCookieVisible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
            {arkCookieVisible ? '隐藏' : '显示'}
          </button>
        </div>
        <p className="settings-desc">填入火山方舟控制台的 Cookie 用于查询 Coding 套餐用量。登录 <a href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe" onClick={handleOpenLink('https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe')} rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>火山方舟控制台</a> 后，从浏览器开发者工具中复制完整的 Cookie 值（须包含 csrfToken）</p>
      </div>
    </div>
  );
};
