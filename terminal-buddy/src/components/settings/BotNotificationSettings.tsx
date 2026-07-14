import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, QrCode, Save, Send, Trash2 } from 'lucide-react';
import {
  getBotSettings,
  getBotCallbackBaseUrl,
  saveBotSettings,
  testBotChannel,
  type BotChannelConfig,
  type BotSettings,
  type ScanCredentials,
} from '../../services/tauri';
import { BotScanDialog } from './BotScanDialog';

const PLATFORM_OPTIONS: ReadonlyArray<{ value: BotChannelConfig['platform']; label: string; bidirectional: boolean }> = [
  { value: 'feishu', label: '飞书应用机器人', bidirectional: true },
  { value: 'dingtalk', label: '钉钉应用机器人', bidirectional: false },
  { value: 'qq', label: 'QQ 机器人桥接', bidirectional: true },
  { value: 'bridge', label: '通用机器人桥接', bidirectional: true },
];

const EMPTY_SETTINGS: BotSettings = {
  enabled: false,
  sendDecisionNotifications: true,
  sendCompletionNotifications: true,
  attachScreenshot: true,
  decisionTtlMinutes: 30,
  appendEnter: true,
  channels: [],
};

function normalizeSettings(settings: BotSettings): BotSettings {
  return {
    ...EMPTY_SETTINGS,
    ...settings,
    channels: (settings.channels || []).map(channel => ({
      ...channel,
      secret: channel.secret || '',
      callbackToken: channel.callbackToken || '',
      allowedUserIds: channel.allowedUserIds || [],
    })),
  };
}

function createChannel(): BotChannelConfig {
  return {
    id: crypto.randomUUID(),
    name: '飞书通知',
    platform: 'feishu',
    enabled: true,
    targetId: '',
    receiveIdType: 'chat_id',
    webhookUrl: '',
    appId: '',
    secret: '',
    callbackToken: '',
    allowedUserIds: [],
    hasSecret: false,
    hasCallbackToken: false,
  };
}

export function BotNotificationSettings() {
  const [settings, setSettings] = useState<BotSettings>(EMPTY_SETTINGS);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [callbackBaseUrl, setCallbackBaseUrl] = useState('http://<电脑IP>:9600');
  const [scanChannelId, setScanChannelId] = useState<string | null>(null);

  useEffect(() => {
    void getBotCallbackBaseUrl().then(setCallbackBaseUrl).catch(() => {});
    getBotSettings()
      .then(value => setSettings(normalizeSettings(value)))
      .catch(error => setStatus({ type: 'error', text: `读取设置失败：${String(error)}` }))
      .finally(() => setLoading(false));
  }, []);

  const enabledCount = useMemo(
    () => settings.channels.filter(channel => channel.enabled).length,
    [settings.channels],
  );

  const updateGlobal = <K extends keyof BotSettings>(key: K, value: BotSettings[K]) => {
    setSettings(previous => ({ ...previous, [key]: value }));
    setStatus(null);
  };

  const updateChannel = <K extends keyof BotChannelConfig>(id: string, key: K, value: BotChannelConfig[K]) => {
    setSettings(previous => ({
      ...previous,
      channels: previous.channels.map(channel => channel.id === id ? { ...channel, [key]: value } : channel),
    }));
    setStatus(null);
  };

  const persist = async (): Promise<BotSettings> => {
    setSaving(true);
    try {
      const saved = normalizeSettings(await saveBotSettings(settings));
      setSettings(saved);
      setStatus({ type: 'success', text: '机器人通知设置已保存' });
      return saved;
    } catch (error) {
      setStatus({ type: 'error', text: `保存失败：${String(error)}` });
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (channelId: string) => {
    setTestingId(channelId);
    try {
      await persist();
      const result = await testBotChannel(channelId);
      setStatus(result.success
        ? { type: 'success', text: `测试消息已发送到「${result.channelName}」` }
        : { type: 'error', text: result.error || '测试消息发送失败' });
    } catch {
      // persist 已显示错误。
    } finally {
      setTestingId(null);
    }
  };

  // 扫码成功后回填凭证并自动保存；飞书自动用扫码人 open_id 作为接收目标。
  const handleScanSuccess = (channelId: string) => async (credentials: ScanCredentials) => {
    const next = normalizeSettings({
      ...settings,
      channels: settings.channels.map(channel => {
        if (channel.id !== channelId) return channel;
        const receiveIdType = channel.platform === 'feishu' && credentials.targetId ? 'open_id' : channel.receiveIdType;
        return {
          ...channel,
          appId: credentials.appId,
          secret: credentials.appSecret,
          hasSecret: true,
          targetId: credentials.targetId || channel.targetId,
          receiveIdType,
        };
      }),
    });
    setScanChannelId(null);
    setSaving(true);
    setStatus(null);
    try {
      const saved = await saveBotSettings(next);
      setSettings(saved);
      setStatus({ type: 'success', text: '扫码授权成功，凭证已自动保存。' });
    } catch (error) {
      setSettings(next);
      setStatus({ type: 'error', text: `凭证已填入但保存失败：${String(error)}` });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="settings-panel-loading">正在读取机器人设置...</div>;

  return (
    <div className="settings-general bot-settings">
      <div className="bot-settings-toolbar">
        <div>
          <div className="bot-settings-title">机器人通知</div>
          <div className="bot-settings-subtitle">已启用 {enabledCount} 个通道</div>
        </div>
        <button className="btn-primary bot-icon-text-btn" onClick={() => void persist()} disabled={saving}>
          <Save size={15} aria-hidden="true" />
          {saving ? '保存中' : '保存'}
        </button>
      </div>

      <div className="settings-section bot-global-options">
        <label className="settings-toggle">
          <input type="checkbox" checked={settings.enabled} onChange={event => updateGlobal('enabled', event.target.checked)} />
          <span>启用机器人通知</span>
        </label>
        <label className="settings-toggle">
          <input type="checkbox" checked={settings.sendDecisionNotifications} onChange={event => updateGlobal('sendDecisionNotifications', event.target.checked)} />
          <span>发送决策通知</span>
        </label>
        <label className="settings-toggle">
          <input type="checkbox" checked={settings.sendCompletionNotifications} onChange={event => updateGlobal('sendCompletionNotifications', event.target.checked)} />
          <span>发送完成通知</span>
        </label>
        <label className="settings-toggle">
          <input type="checkbox" checked={settings.attachScreenshot} onChange={event => updateGlobal('attachScreenshot', event.target.checked)} />
          <span>附带终端截图</span>
        </label>
        <label className="settings-toggle">
          <input type="checkbox" checked={settings.appendEnter} onChange={event => updateGlobal('appendEnter', event.target.checked)} />
          <span>将回复写入终端后发送回车</span>
        </label>
        <label className="bot-number-setting">
          <span>决策有效期</span>
          <input
            type="number"
            min={1}
            max={1440}
            value={settings.decisionTtlMinutes}
            onChange={event => updateGlobal('decisionTtlMinutes', Math.min(1440, Math.max(1, Number(event.target.value) || 1)))}
          />
          <span>分钟</span>
        </label>
        <p className="settings-desc bot-privacy-note">终端截图可能包含 Token、密钥或业务数据，请只向可信会话发送。</p>
      </div>

      <div className="bot-channel-heading">
        <span>通知通道</span>
        <button
          className="settings-add-btn bot-icon-text-btn"
          onClick={() => {
            const channel = createChannel();
            setSettings(previous => ({ ...previous, channels: [...previous.channels, channel] }));
            setExpandedId(channel.id);
          }}
        >
          <Plus size={15} aria-hidden="true" />新增通道
        </button>
      </div>

      <div className="bot-channel-list">
        {settings.channels.length === 0 && <div className="settings-empty-state">暂无机器人通道</div>}
        {settings.channels.map(channel => {
          const platform = PLATFORM_OPTIONS.find(option => option.value === channel.platform) || PLATFORM_OPTIONS[0];
          const expanded = expandedId === channel.id;
          const usesAppCredentials = channel.platform === 'feishu' || channel.platform === 'dingtalk';
          const usesWebhook = channel.platform !== 'feishu' && channel.platform !== 'dingtalk';
          const supportsInbound = platform.bidirectional;
          return (
            <div className="bot-channel-item" key={channel.id}>
              <div className="bot-channel-summary">
                <button
                  className="bot-expand-btn"
                  onClick={() => setExpandedId(expanded ? null : channel.id)}
                  title={expanded ? '收起配置' : '展开配置'}
                  aria-label={expanded ? '收起配置' : '展开配置'}
                >
                  {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <label className="bot-channel-toggle" title="启用通道">
                  <input type="checkbox" checked={channel.enabled} onChange={event => updateChannel(channel.id, 'enabled', event.target.checked)} />
                </label>
                <div className="bot-channel-identity">
                  <span>{channel.name || platform.label}</span>
                  <small>{platform.label}</small>
                </div>
                <span className={`bot-capability ${supportsInbound ? 'two-way' : ''}`}>{supportsInbound ? '双向' : '单向'}</span>
                <button className="bot-action-btn" onClick={() => void handleTest(channel.id)} disabled={testingId === channel.id} title="发送测试消息" aria-label="发送测试消息">
                  <Send size={15} />
                </button>
                <button
                  className="bot-action-btn danger"
                  onClick={() => setSettings(previous => ({ ...previous, channels: previous.channels.filter(item => item.id !== channel.id) }))}
                  title="删除通道"
                  aria-label="删除通道"
                >
                  <Trash2 size={15} />
                </button>
              </div>

              {expanded && (
                <div className="bot-channel-form">
                  <label><span>通道名称</span><input value={channel.name} onChange={event => updateChannel(channel.id, 'name', event.target.value)} /></label>
                  <label>
                    <span>平台</span>
                    <select value={channel.platform} onChange={event => updateChannel(channel.id, 'platform', event.target.value as BotChannelConfig['platform'])}>
                      {PLATFORM_OPTIONS.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  {usesAppCredentials && (
                    <>
                      <div className="bot-scan-trigger bot-form-wide">
                        <button type="button" className="settings-add-btn bot-icon-text-btn" onClick={() => setScanChannelId(channel.id)}>
                          <QrCode size={15} aria-hidden="true" />扫码配置
                        </button>
                        <span className="bot-form-hint">用 {platform.label} App 扫码自动获取凭证</span>
                      </div>
                      <label><span>App ID</span><input value={channel.appId} onChange={event => updateChannel(channel.id, 'appId', event.target.value)} /></label>
                      <label>
                        <span>App Secret</span>
                        <input type="password" value={channel.secret} onChange={event => updateChannel(channel.id, 'secret', event.target.value)} placeholder={channel.hasSecret ? '已配置，留空保持不变' : '请输入 App Secret'} />
                      </label>
                      {channel.platform === 'feishu' && (
                        <label>
                          <span>接收 ID 类型</span>
                          <select value={channel.receiveIdType} onChange={event => updateChannel(channel.id, 'receiveIdType', event.target.value)}>
                            <option value="chat_id">chat_id</option>
                            <option value="open_id">open_id</option>
                            <option value="user_id">user_id</option>
                            <option value="email">email</option>
                          </select>
                        </label>
                      )}
                    </>
                  )}
                  {usesWebhook && (
                    <label>
                      <span>{supportsInbound ? '桥接发送 URL' : 'Webhook URL'}</span>
                      <input value={channel.webhookUrl} onChange={event => updateChannel(channel.id, 'webhookUrl', event.target.value)} placeholder="https://" />
                    </label>
                  )}
                  {usesWebhook && supportsInbound && (
                    <label>
                      <span>发送鉴权 Token</span>
                      <input type="password" value={channel.secret} onChange={event => updateChannel(channel.id, 'secret', event.target.value)} placeholder={channel.hasSecret ? '已配置，留空保持不变' : '可选'} />
                    </label>
                  )}
                  <label>
                    <span>{channel.platform === 'dingtalk' ? '收件人 userId' : '目标会话 ID'}</span>
                    <input value={channel.targetId} onChange={event => updateChannel(channel.id, 'targetId', event.target.value)} placeholder={channel.platform === 'dingtalk' ? '在钉钉管理后台获取用户 userId' : ''} />
                  </label>
                  {supportsInbound && (
                    <>
                      <label>
                        <span>回调验证 Token</span>
                        <input type="password" value={channel.callbackToken} onChange={event => updateChannel(channel.id, 'callbackToken', event.target.value)} placeholder={channel.hasCallbackToken ? '已配置，留空保持不变' : '必填'} />
                      </label>
                      <label className="bot-form-wide">
                        <span>允许回复的用户 ID</span>
                        <textarea
                          rows={2}
                          value={channel.allowedUserIds.join(', ')}
                          onChange={event => updateChannel(channel.id, 'allowedUserIds', event.target.value.split(/[,\n]/).map(value => value.trim()).filter(Boolean))}
                          placeholder="多个 ID 使用逗号分隔"
                        />
                      </label>
                      <div className="bot-callback-path bot-form-wide">
                        回调地址：{callbackBaseUrl}{channel.platform === 'feishu' ? '/api/bot/feishu/events' : `/api/bot/inbound/${channel.id}`}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {status && <div className={`bot-settings-status ${status.type}`}>{status.text}</div>}

      {scanChannelId && (
        <BotScanDialog
          platform={(settings.channels.find(channel => channel.id === scanChannelId)?.platform ?? 'feishu') as 'feishu' | 'dingtalk'}
          onClose={() => setScanChannelId(null)}
          onSuccess={handleScanSuccess(scanChannelId)}
        />
      )}
    </div>
  );
}
