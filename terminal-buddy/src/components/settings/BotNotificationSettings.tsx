import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ListChecks, Plus, QrCode, Send, Trash2 } from 'lucide-react';
import {
  getBotSettings,
  getBotLongConnectionStatus,
  getBotCallbackBaseUrl,
  saveBotSettings,
  testBotChannel,
  testBotDecisionChannel,
  type BotChannelConfig,
  type BotSettings,
  type BotLongConnectionStatus,
  type ScanCredentials,
} from '../../services/tauri';
import { BOT_PLATFORM_OPTIONS, BotChannelDialog } from './BotChannelDialog';
import { BotScanDialog } from './BotScanDialog';

const EMPTY_SETTINGS: BotSettings = {
  enabled: false,
  sendDecisionNotifications: true,
  sendCompletionNotifications: true,
  decisionTtlMinutes: 30,
  appendEnter: true,
  channels: [],
};

const AUTOSAVE_DELAY_MS = 500;

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

export function BotNotificationSettings() {
  const [settings, setSettings] = useState<BotSettings>(EMPTY_SETTINGS);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingDecisionId, setTestingDecisionId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [callbackBaseUrl, setCallbackBaseUrl] = useState('http://<电脑IP>:9600');
  const [longConnectionStatuses, setLongConnectionStatuses] = useState<Record<string, BotLongConnectionStatus>>({});
  const [scanChannelId, setScanChannelId] = useState<string | null>(null);
  const [showChannelDialog, setShowChannelDialog] = useState(false);

  const settingsRef = useRef(settings);
  const latestSavedSettingsRef = useRef(settings);
  const lastSavedStateSignatureRef = useRef('');
  const lastSubmittedSignatureRef = useRef('');
  const autosaveReadyRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const saveQueueRef = useRef<Promise<BotSettings>>(Promise.resolve(settings));

  settingsRef.current = settings;

  const persist = (
    snapshot: BotSettings,
    successText = '机器人通知设置已自动保存',
    applySnapshot = false,
  ): Promise<BotSettings> => {
    const snapshotSignature = JSON.stringify(snapshot);
    const request = saveQueueRef.current
      .catch(() => latestSavedSettingsRef.current)
      .then(async () => {
        if (snapshotSignature === lastSubmittedSignatureRef.current) {
          return latestSavedSettingsRef.current;
        }

        if (mountedRef.current) setSaving(true);
        try {
          const saved = normalizeSettings(await saveBotSettings(snapshot));
          latestSavedSettingsRef.current = saved;
          lastSubmittedSignatureRef.current = snapshotSignature;
          lastSavedStateSignatureRef.current = JSON.stringify(saved);

          if (mountedRef.current && (applySnapshot || JSON.stringify(settingsRef.current) === snapshotSignature)) {
            settingsRef.current = saved;
            setSettings(saved);
            setStatus({ type: 'success', text: successText });
          }
          return saved;
        } catch (error) {
          if (mountedRef.current && JSON.stringify(settingsRef.current) === snapshotSignature) {
            setStatus({ type: 'error', text: `自动保存失败：${String(error)}` });
          }
          throw error;
        } finally {
          if (mountedRef.current) setSaving(false);
        }
      });

    saveQueueRef.current = request.catch(() => latestSavedSettingsRef.current);
    return request;
  };

  useEffect(() => {
    void getBotCallbackBaseUrl().then(setCallbackBaseUrl).catch(() => {});
    getBotSettings()
      .then(value => {
        const loaded = normalizeSettings(value);
        const signature = JSON.stringify(loaded);
        settingsRef.current = loaded;
        latestSavedSettingsRef.current = loaded;
        lastSavedStateSignatureRef.current = signature;
        lastSubmittedSignatureRef.current = signature;
        autosaveReadyRef.current = true;
        setSettings(loaded);
      })
      .catch(error => setStatus({ type: 'error', text: `读取设置失败：${String(error)}` }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const refresh = () => {
      void getBotLongConnectionStatus()
        .then(items => setLongConnectionStatuses(Object.fromEntries(items.map(item => [item.channelId, item]))))
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!autosaveReadyRef.current) return;
    const signature = JSON.stringify(settings);
    if (signature === lastSavedStateSignatureRef.current) return;

    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void persist(settings).catch(() => {});
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [settings]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      const pending = settingsRef.current;
      const signature = JSON.stringify(pending);
      if (autosaveReadyRef.current
        && signature !== lastSavedStateSignatureRef.current
        && signature !== lastSubmittedSignatureRef.current) {
        void persist(pending).catch(() => {});
      }
    };
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

  const handleAddChannel = async (channel: BotChannelConfig) => {
    const next = normalizeSettings({
      ...settingsRef.current,
      channels: [...settingsRef.current.channels, channel],
    });
    await persist(next, `通知通道「${channel.name}」已添加。`, true);
    setShowChannelDialog(false);
  };

  const handleTest = async (channelId: string) => {
    setTestingId(channelId);
    setStatus(null);
    try {
      try {
        await persist(settings);
      } catch {
        return;
      }
      const result = await testBotChannel(channelId);
      setStatus(result.success
        ? { type: 'success', text: `测试消息已发送到「${result.channelName}」` }
        : { type: 'error', text: result.error || '测试消息发送失败' });
    } catch (error) {
      setStatus({ type: 'error', text: `测试消息发送失败：${String(error)}` });
    } finally {
      setTestingId(null);
    }
  };

  const handleTestDecision = async (channelId: string) => {
    setTestingDecisionId(channelId);
    setStatus(null);
    try {
      try {
        await persist(settings);
      } catch {
        return;
      }
      const result = await testBotDecisionChannel(channelId);
      const channel = settings.channels.find(item => item.id === channelId);
      const successText = channel?.platform === 'weixin'
        ? `测试决策已发送到「${result.channelName}」，请在微信中引用消息回复选项编号`
        : `测试决策已发送到「${result.channelName}」，请在飞书中点击选项`;
      setStatus(result.success
        ? { type: 'success', text: successText }
        : { type: 'error', text: result.error || '测试决策发送失败' });
    } catch (error) {
      setStatus({ type: 'error', text: `测试决策发送失败：${String(error)}` });
    } finally {
      setTestingDecisionId(null);
    }
  };

  // 扫码成功后回填凭证并自动保存；飞书自动用扫码人 open_id 作为接收目标。
  const handleScanSuccess = (channelId: string) => async (credentials: ScanCredentials) => {
    const next = normalizeSettings({
      ...settings,
      channels: settings.channels.map(channel => {
        if (channel.id !== channelId) return channel;
        const isWeixin = channel.platform === 'weixin';
        const receiveIdType = channel.platform === 'feishu' && credentials.targetId
          ? 'open_id'
          : (isWeixin ? 'chat_id' : channel.receiveIdType);
        const allowedUserIds = isWeixin && credentials.targetId
          ? Array.from(new Set([...channel.allowedUserIds, credentials.targetId]))
          : channel.allowedUserIds;
        return {
          ...channel,
          appId: credentials.appId,
          secret: credentials.appSecret,
          hasSecret: true,
          targetId: credentials.targetId || channel.targetId,
          receiveIdType,
          webhookUrl: credentials.baseUrl || channel.webhookUrl,
          allowedUserIds,
        };
      }),
    });
    setScanChannelId(null);
    settingsRef.current = next;
    setSettings(next);
    setStatus(null);
    try {
      await persist(next, '扫码授权成功，凭证已自动保存。');
    } catch (error) {
      setStatus({ type: 'error', text: `凭证已填入但保存失败：${String(error)}` });
    }
  };

  if (loading) return <div className="settings-panel-loading">正在读取机器人设置...</div>;

  return (
    <div className="settings-general bot-settings">
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
      </div>

      <div className="bot-channel-heading">
        <span>通知通道（已启用 {enabledCount} 个）</span>
        <button
          className="settings-add-btn bot-icon-text-btn"
          onClick={() => setShowChannelDialog(true)}
        >
          <Plus size={15} aria-hidden="true" />新增通道
        </button>
      </div>

      <div className="bot-channel-list">
        {settings.channels.length === 0 && <div className="settings-empty-state">暂无机器人通道</div>}
        {settings.channels.map(channel => {
          const platform = BOT_PLATFORM_OPTIONS.find(option => option.value === channel.platform) || BOT_PLATFORM_OPTIONS[0];
          const expanded = expandedId === channel.id;
          const usesAppCredentials = channel.platform === 'feishu'
            || channel.platform === 'weixin'
            || channel.platform === 'dingtalk';
          const usesWebhook = channel.platform === 'qq' || channel.platform === 'bridge';
          const supportsInbound = platform.bidirectional;
          const longConnectionStatus = channel.platform === 'feishu' || channel.platform === 'weixin'
            ? longConnectionStatuses[channel.id]
            : undefined;
          const capabilityLabel = channel.platform === 'feishu' || channel.platform === 'weixin'
            ? ({
                connecting: '连接中',
                connected: '长连接',
                disconnected: '未连接',
                error: '连接异常',
              }[longConnectionStatus?.state || 'disconnected'])
            : (supportsInbound ? '双向' : '单向');
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
                <span
                  className={`bot-capability ${supportsInbound ? 'two-way' : ''}${longConnectionStatus?.state === 'error' ? ' error' : ''}`}
                  title={longConnectionStatus?.error}
                >
                  {capabilityLabel}
                </span>
                <button className="bot-action-btn" onClick={() => void handleTest(channel.id)} disabled={testingId === channel.id || testingDecisionId === channel.id} title="发送测试消息" aria-label="发送测试消息">
                  <Send size={15} />
                </button>
                {(channel.platform === 'feishu' || channel.platform === 'weixin') && (
                  <button
                    className="bot-action-btn"
                    onClick={() => void handleTestDecision(channel.id)}
                    disabled={testingId === channel.id || testingDecisionId === channel.id}
                    title="发送测试决策"
                    aria-label="发送测试决策"
                  >
                    <ListChecks size={15} />
                  </button>
                )}
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
                      {BOT_PLATFORM_OPTIONS.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  {usesAppCredentials && (
                    <>
                      <div className="bot-scan-trigger bot-form-wide">
                        <button type="button" className="settings-add-btn bot-icon-text-btn" onClick={() => setScanChannelId(channel.id)}>
                          <QrCode size={15} aria-hidden="true" />扫码配置
                        </button>
                        <span className="bot-form-hint">
                          {channel.platform === 'weixin'
                            ? '用微信扫码创建独立的个人微信 iLink Bot 身份'
                            : `用 ${platform.label} App 扫码自动获取凭证`}
                        </span>
                      </div>
                      <label>
                        <span>{channel.platform === 'weixin' ? 'Bot ID' : 'App ID'}</span>
                        <input value={channel.appId} onChange={event => updateChannel(channel.id, 'appId', event.target.value)} />
                      </label>
                      <label>
                        <span>{channel.platform === 'weixin' ? 'Bot Token' : 'App Secret'}</span>
                        <input type="password" value={channel.secret} onChange={event => updateChannel(channel.id, 'secret', event.target.value)} placeholder={channel.hasSecret ? '已配置，留空保持不变' : (channel.platform === 'weixin' ? '请扫码获取 Bot Token' : '请输入 App Secret')} />
                      </label>
                      {channel.platform === 'weixin' && (
                        <label className="bot-form-wide">
                          <span>iLink API 地址</span>
                          <input value={channel.webhookUrl} onChange={event => updateChannel(channel.id, 'webhookUrl', event.target.value)} placeholder="https://ilinkai.weixin.qq.com" />
                        </label>
                      )}
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
                    <span>{channel.platform === 'dingtalk' ? '收件人 userId' : (channel.platform === 'weixin' ? '目标用户 ID' : '目标会话 ID')}</span>
                    <input value={channel.targetId} onChange={event => updateChannel(channel.id, 'targetId', event.target.value)} placeholder={channel.platform === 'dingtalk' ? '在钉钉管理后台获取用户 userId' : (channel.platform === 'weixin' ? '扫码账号的 iLink 用户 ID' : '')} />
                  </label>
                  {supportsInbound && (
                    <>
                      {channel.platform !== 'feishu' && channel.platform !== 'weixin' && (
                        <label>
                          <span>回调验证 Token</span>
                          <input type="password" value={channel.callbackToken} onChange={event => updateChannel(channel.id, 'callbackToken', event.target.value)} placeholder={channel.hasCallbackToken ? '已配置，留空保持不变' : '必填'} />
                        </label>
                      )}
                      <label className="bot-form-wide">
                        <span>允许回复的用户 ID</span>
                        <textarea
                          rows={2}
                          value={channel.allowedUserIds.join(', ')}
                          onChange={event => updateChannel(channel.id, 'allowedUserIds', event.target.value.split(/[,\n]/).map(value => value.trim()).filter(Boolean))}
                          placeholder="多个 ID 使用逗号分隔"
                        />
                      </label>
                      {channel.platform === 'feishu' || channel.platform === 'weixin' ? (
                        <div className="bot-callback-path bot-form-wide" title={longConnectionStatus?.error}>
                          事件接收：{capabilityLabel}（无需公网回调）
                        </div>
                      ) : (
                        <div className="bot-callback-path bot-form-wide">
                          本机回调地址：{callbackBaseUrl}/api/bot/inbound/{channel.id}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(saving || status) && (
        <div
          className={`bot-settings-status ${saving ? 'saving' : status?.type ?? ''}`}
          role={status?.type === 'error' ? 'alert' : 'status'}
          aria-live={status?.type === 'error' ? 'assertive' : 'polite'}
        >
          {saving ? '正在自动保存…' : status?.text}
        </div>
      )}

      {scanChannelId && (
        <BotScanDialog
          platform={(settings.channels.find(channel => channel.id === scanChannelId)?.platform ?? 'feishu') as 'feishu' | 'weixin' | 'dingtalk'}
          onClose={() => setScanChannelId(null)}
          onSuccess={handleScanSuccess(scanChannelId)}
        />
      )}

      {showChannelDialog && (
        <BotChannelDialog
          callbackBaseUrl={callbackBaseUrl}
          onClose={() => setShowChannelDialog(false)}
          onConfirm={handleAddChannel}
        />
      )}
    </div>
  );
}
