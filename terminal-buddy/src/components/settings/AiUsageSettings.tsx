import { FC, useState } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import type { AppSettings } from '../../utils/settings';
import { openUrl } from '../../services/tauri';

interface AiUsageSettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

type UsageCredentialKey =
  | 'zhipuApiKey'
  | 'deepseekApiKey'
  | 'qianfanCookie'
  | 'minimaxApiKey'
  | 'arkCookie';

interface UsageCredentialItem {
  key: UsageCredentialKey;
  title: string;
  placeholder: string;
  prefixDesc: string;
  linkLabel: string;
  linkUrl: string;
  suffixDesc: string;
}

const USAGE_CREDENTIALS: ReadonlyArray<UsageCredentialItem> = [
  {
    key: 'zhipuApiKey',
    title: '智谱 GLM API Key',
    placeholder: '请输入智谱 GLM API Key',
    prefixDesc: '可在 ',
    linkLabel: 'open.bigmodel.cn',
    linkUrl: 'https://open.bigmodel.cn',
    suffixDesc: ' 获取 API Key 用于查询套餐余量',
  },
  {
    key: 'deepseekApiKey',
    title: 'DeepSeek 认证 Token',
    placeholder: '请输入 DeepSeek 认证 Token',
    prefixDesc: '登录 ',
    linkLabel: 'platform.deepseek.com/usage',
    linkUrl: 'https://platform.deepseek.com/usage',
    suffixDesc: ' 后从开发者工具网络请求复制 Authorization Bearer 值',
  },
  {
    key: 'qianfanCookie',
    title: '百度千帆 Cookie',
    placeholder: '请输入百度千帆的 Cookie',
    prefixDesc: '登录 ',
    linkLabel: '百度千帆控制台',
    linkUrl: 'https://console.bce.baidu.com/qianfan/resource/subscribe',
    suffixDesc: ' 后从浏览器开发者工具复制完整 Cookie 值',
  },
  {
    key: 'minimaxApiKey',
    title: 'MiniMax API Key',
    placeholder: '请输入 MiniMax API Key',
    prefixDesc: '可在 ',
    linkLabel: 'platform.minimax.chat',
    linkUrl: 'https://platform.minimax.chat/api_keys',
    suffixDesc: ' 获取密钥用于查询 AI 用量信息',
  },
  {
    key: 'arkCookie',
    title: '火山方舟 Cookie',
    placeholder: '请输入火山方舟控制台的 Cookie',
    prefixDesc: '登录 ',
    linkLabel: '火山方舟控制台',
    linkUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe',
    suffixDesc: ' 后复制完整 Cookie 值（须包含 csrfToken）用于查询 Coding 套餐用量',
  },
];

export const AiUsageSettings: FC<AiUsageSettingsProps> = ({ settings, updateSetting }) => {
  const [visibleMap, setVisibleMap] = useState<Partial<Record<UsageCredentialKey, boolean>>>({});

  // Tauri WebView 里 target="_blank" 不会拉起系统浏览器，统一走 openUrl 触发 ShellExecuteW。
  const handleOpenLink = (url: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    void openUrl(url);
  };

  const configuredCount = USAGE_CREDENTIALS.filter(item => settings[item.key].trim().length > 0).length;

  return (
    <div className="settings-general">
      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">
            <KeyRound size={14} aria-hidden="true" />
            厂商用量查询凭据
          </span>
          <span className="card-group-extra">{configuredCount} / {USAGE_CREDENTIALS.length} 已配置</span>
        </div>

        {USAGE_CREDENTIALS.map(item => {
          const value = settings[item.key];
          const configured = value.trim().length > 0;
          const visible = Boolean(visibleMap[item.key]);
          return (
            <div key={item.key} className="settings-row settings-row--wrap-ctrl">
              <div className="settings-row-info">
                <div className="settings-row-title">
                  {item.title}
                  <span className={`s-status-chip ${configured ? 'ok' : 'muted'}`}>
                    {configured ? '已配置' : '未配置'}
                  </span>
                </div>
                <p className="settings-row-desc">
                  {item.prefixDesc}
                  <a href={item.linkUrl} onClick={handleOpenLink(item.linkUrl)} rel="noopener noreferrer">
                    {item.linkLabel}
                  </a>
                  {item.suffixDesc}
                </p>
              </div>
              <div className="settings-row-ctrl ai-usage-ctrl">
                <input
                  className={`tb-input${configured ? ' mono' : ''}`}
                  type={visible ? 'text' : 'password'}
                  value={value}
                  onChange={e => updateSetting(item.key, e.target.value)}
                  placeholder={item.placeholder}
                  aria-label={item.title}
                />
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => setVisibleMap(prev => ({ ...prev, [item.key]: !prev[item.key] }))}
                >
                  {visible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                  {visible ? '隐藏' : '显示'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
