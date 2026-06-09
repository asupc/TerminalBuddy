import { FC, useState } from 'react';
import type { AppSettings } from '../../utils/settings';

interface AiUsageSettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export const AiUsageSettings: FC<AiUsageSettingsProps> = ({ settings, updateSetting }) => {
  const [zhipuApiKeyVisible, setZhipuApiKeyVisible] = useState(false);
  const [qianfanCookieVisible, setQianfanCookieVisible] = useState(false);
  const [deepseekApiKeyVisible, setDeepseekApiKeyVisible] = useState(false);
  const [minimaxApiKeyVisible, setMinimaxApiKeyVisible] = useState(false);

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
          >{zhipuApiKeyVisible ? '隐藏' : '显示'}</button>
        </div>
        <p className="settings-desc">填入智谱 GLM 的 API Key 用于查询 AI 用量信息。可在 <a href="https://open.bigmodel.cn" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>open.bigmodel.cn</a> 获取</p>
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
          >{qianfanCookieVisible ? '隐藏' : '显示'}</button>
        </div>
        <p className="settings-desc">填入百度千帆控制台的 Cookie 用于查询 AI 用量。登录 <a href="https://console.bce.baidu.com/qianfan/resource/subscribe" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>百度千帆控制台</a> 后，从浏览器开发者工具中复制完整的 Cookie 值</p>
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
          >{deepseekApiKeyVisible ? '隐藏' : '显示'}</button>
        </div>
        <p className="settings-desc">填入 DeepSeek 的 认证Token 用于查询 AI 用量。可在 <a href="https://platform.deepseek.com/usage" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>platform.deepseek.com/usage</a> 登录后打开浏览器开发者工具，查看网络请求获取 Authorization Bearer 值</p>
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
          >{minimaxApiKeyVisible ? '隐藏' : '显示'}</button>
        </div>
        <p className="settings-desc">填入 MiniMax 的 API Key 用于查询 AI 用量。可在 <a href="https://platform.minimax.chat/api_keys" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>platform.minimax.chat</a> 获取</p>
      </div>
    </div>
  );
};
