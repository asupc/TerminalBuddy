import { useMemo, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, QrCode, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  verifyBotChannel,
  type BotChannelConfig,
  type ScanCredentials,
} from '../../services/tauri';
import { Dialog } from '../shared/Dialog';
import { BotScanDialog } from './BotScanDialog';

export const BOT_PLATFORM_OPTIONS: ReadonlyArray<{
  value: BotChannelConfig['platform'];
  label: string;
  shortLabel: string;
  bidirectional: boolean;
}> = [
  { value: 'feishu', label: '飞书应用机器人', shortLabel: '飞书', bidirectional: true },
  { value: 'weixin', label: '微信机器人', shortLabel: '微信', bidirectional: true },
  { value: 'dingtalk', label: '钉钉应用机器人', shortLabel: '钉钉', bidirectional: false },
  { value: 'qq', label: 'QQ 机器人桥接', shortLabel: 'QQ', bidirectional: true },
  { value: 'bridge', label: '通用机器人桥接', shortLabel: '桥接', bidirectional: true },
];

export function createBotChannel(
  platform: BotChannelConfig['platform'] = 'feishu',
  id: string = crypto.randomUUID(),
): BotChannelConfig {
  const option = BOT_PLATFORM_OPTIONS.find(item => item.value === platform) ?? BOT_PLATFORM_OPTIONS[0];
  return {
    id,
    name: `${option.shortLabel}通知`,
    platform,
    enabled: true,
    targetId: '',
    receiveIdType: 'chat_id',
    webhookUrl: platform === 'weixin' ? 'https://ilinkai.weixin.qq.com' : '',
    appId: '',
    secret: '',
    callbackToken: '',
    allowedUserIds: [],
    hasSecret: false,
    hasCallbackToken: false,
  };
}

interface BotChannelDialogProps {
  callbackBaseUrl: string;
  onClose: () => void;
  onConfirm: (channel: BotChannelConfig) => Promise<void>;
}

type FieldErrors = Partial<Record<'name' | 'appId' | 'secret' | 'targetId' | 'webhookUrl' | 'callbackToken', string>>;

function isAppPlatform(platform: BotChannelConfig['platform']): platform is 'feishu' | 'weixin' | 'dingtalk' {
  return platform === 'feishu' || platform === 'weixin' || platform === 'dingtalk';
}

function authorizationSignature(channel: BotChannelConfig): string {
  return JSON.stringify({
    platform: channel.platform,
    targetId: channel.targetId.trim(),
    receiveIdType: channel.receiveIdType,
    webhookUrl: channel.webhookUrl.trim(),
    appId: channel.appId.trim(),
    secret: channel.secret,
  });
}

function validateChannel(channel: BotChannelConfig): FieldErrors {
  const errors: FieldErrors = {};
  if (!channel.name.trim()) errors.name = '请输入通道名称';

  if (isAppPlatform(channel.platform)) {
    if (!channel.appId.trim()) errors.appId = channel.platform === 'weixin' ? '请先扫码获取 Bot ID' : '请输入 App ID';
    if (!channel.secret) errors.secret = channel.platform === 'weixin' ? '请先扫码获取 Bot Token' : '请输入 App Secret';
    if (!channel.targetId.trim()) errors.targetId = channel.platform === 'dingtalk' ? '请输入收件人 userId' : '请输入接收目标';
  } else {
    const url = channel.webhookUrl.trim();
    if (!url) {
      errors.webhookUrl = '请输入桥接发送 URL';
    } else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.webhookUrl = '仅支持 HTTP 或 HTTPS 地址';
        }
      } catch {
        errors.webhookUrl = '请输入有效的 URL';
      }
    }
    if (!channel.callbackToken) errors.callbackToken = '请输入回调验证 Token';
  }

  return errors;
}

function mergeScanCredentials(channel: BotChannelConfig, credentials: ScanCredentials): BotChannelConfig {
  const isWeixin = channel.platform === 'weixin';
  const targetId = credentials.targetId || channel.targetId;
  const shouldTrustScanUser = (channel.platform === 'feishu' || isWeixin) && Boolean(credentials.targetId);
  return {
    ...channel,
    appId: credentials.appId,
    secret: credentials.appSecret,
    hasSecret: true,
    targetId,
    receiveIdType: channel.platform === 'feishu' && credentials.targetId ? 'open_id' : channel.receiveIdType,
    webhookUrl: credentials.baseUrl || channel.webhookUrl,
    allowedUserIds: shouldTrustScanUser
      ? Array.from(new Set([...channel.allowedUserIds, credentials.targetId as string]))
      : channel.allowedUserIds,
  };
}

export function BotChannelDialog({ callbackBaseUrl, onClose, onConfirm }: BotChannelDialogProps) {
  const [channel, setChannel] = useState<BotChannelConfig>(() => createBotChannel());
  const [verifiedSignature, setVerifiedSignature] = useState('');
  const [showScan, setShowScan] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const platform = BOT_PLATFORM_OPTIONS.find(option => option.value === channel.platform) ?? BOT_PLATFORM_OPTIONS[0];
  const usesAppCredentials = isAppPlatform(channel.platform);
  const usesWebhook = !usesAppCredentials;
  const supportsInbound = platform.bidirectional;
  const errors = useMemo(() => validateChannel(channel), [channel]);
  const authorizationIsCurrent = verifiedSignature !== '' && verifiedSignature === authorizationSignature(channel);
  const canConfirm = authorizationIsCurrent && Object.keys(errors).length === 0 && !saving && !verifying;

  const updateChannel = <K extends keyof BotChannelConfig>(key: K, value: BotChannelConfig[K]) => {
    setChannel(previous => ({ ...previous, [key]: value }));
    setMessage(null);
  };

  const handlePlatformChange = (nextPlatform: BotChannelConfig['platform']) => {
    setChannel(previous => createBotChannel(nextPlatform, previous.id));
    setVerifiedSignature('');
    setAttempted(false);
    setMessage(null);
  };

  const handleScanSuccess = (credentials: ScanCredentials) => {
    const next = mergeScanCredentials(channel, credentials);
    setChannel(next);
    setVerifiedSignature(authorizationSignature(next));
    setMessage({ type: 'success', text: '扫码授权成功，凭证已回填，尚未保存。' });
    setShowScan(false);
  };

  const handleVerify = async () => {
    setAttempted(true);
    setMessage(null);
    if (Object.keys(errors).length > 0) {
      setMessage({ type: 'error', text: Object.values(errors)[0] ?? '请完善通道配置' });
      return;
    }

    setVerifying(true);
    try {
      const result = await verifyBotChannel(channel);
      if (!result.success) {
        setVerifiedSignature('');
        setMessage({ type: 'error', text: result.error || '授权验证失败' });
        return;
      }
      setVerifiedSignature(authorizationSignature(channel));
      setMessage({ type: 'success', text: '授权验证成功，测试消息已发送。' });
    } catch (error) {
      setVerifiedSignature('');
      setMessage({ type: 'error', text: `授权验证失败：${String(error)}` });
    } finally {
      setVerifying(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    setMessage(null);
    if (Object.keys(errors).length > 0) {
      setMessage({ type: 'error', text: Object.values(errors)[0] ?? '请完善通道配置' });
      return;
    }
    if (!authorizationIsCurrent) {
      setMessage({ type: 'error', text: '请先完成当前配置的授权验证' });
      return;
    }

    setSaving(true);
    try {
      await onConfirm({
        ...channel,
        name: channel.name.trim(),
        targetId: channel.targetId.trim(),
        webhookUrl: channel.webhookUrl.trim(),
        appId: channel.appId.trim(),
      });
    } catch (error) {
      setMessage({ type: 'error', text: `保存通道失败：${String(error)}` });
      setSaving(false);
    }
  };

  const busy = saving || verifying;
  const statusText = authorizationIsCurrent
    ? (Object.keys(errors).length === 0 ? '授权完成' : '请完善必填项')
    : '尚未授权';

  return (
    <>
      <Dialog
        title="新增通知通道"
        className="bot-channel-dialog"
        bodyClassName="bot-channel-dialog-body"
        footerClassName="bot-channel-dialog-footer"
        onClose={onClose}
        closeDisabled={busy}
        onSubmit={handleSubmit}
        footer={(
          <>
            <span className={`bot-dialog-footer-status${authorizationIsCurrent ? ' success' : ''}`}>
              {authorizationIsCurrent ? <ShieldCheck size={15} aria-hidden="true" /> : <ShieldAlert size={15} aria-hidden="true" />}
              {statusText}
            </span>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className="btn-primary bot-icon-text-btn" disabled={!canConfirm}>
              {saving ? <LoaderCircle className="bot-spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
              {saving ? '正在保存' : '确认添加'}
            </button>
          </>
        )}
      >
        <div className="bot-dialog-heading">
          <div className={`bot-dialog-heading-icon${authorizationIsCurrent ? ' success' : ''}`}>
            {authorizationIsCurrent ? <ShieldCheck size={20} aria-hidden="true" /> : <ShieldAlert size={20} aria-hidden="true" />}
          </div>
          <div>
            <strong>{authorizationIsCurrent ? '通道已授权' : '配置并授权通道'}</strong>
            <span>{authorizationIsCurrent ? '确认后才会保存并显示在通道列表中' : '授权前的内容仅保留在当前窗口'}</span>
          </div>
        </div>

        <div className={`bot-authorization-panel${authorizationIsCurrent ? ' success' : ''}`}>
          <div className="bot-authorization-copy">
            {authorizationIsCurrent ? <ShieldCheck size={18} aria-hidden="true" /> : <ShieldAlert size={18} aria-hidden="true" />}
            <div>
              <strong>{authorizationIsCurrent ? '授权成功' : '需要完成授权'}</strong>
              <span>{usesAppCredentials ? `使用 ${platform.shortLabel} 扫码授权，或填写凭证后发送测试验证` : '连接验证会向目标地址发送一条测试消息'}</span>
            </div>
          </div>
          <div className="bot-authorization-actions">
            {usesAppCredentials && (
              <button type="button" className="btn-secondary bot-icon-text-btn" onClick={() => setShowScan(true)} disabled={busy}>
                <QrCode size={15} aria-hidden="true" />扫码授权
              </button>
            )}
            <button type="button" className="btn-primary bot-icon-text-btn" onClick={() => void handleVerify()} disabled={busy}>
              {verifying ? <LoaderCircle className="bot-spin" size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
              {verifying ? '正在验证' : '发送测试并验证'}
            </button>
          </div>
        </div>

        {message && (
          <div className={`bot-dialog-message ${message.type}`} role={message.type === 'error' ? 'alert' : 'status'}>
            {message.text}
          </div>
        )}

        <div className="bot-dialog-form-grid">
          <label className={attempted && errors.name ? 'has-error' : ''}>
            <span>通道名称</span>
            <input
              autoFocus
              value={channel.name}
              onChange={event => updateChannel('name', event.target.value)}
              aria-invalid={Boolean(attempted && errors.name)}
            />
          </label>
          <label>
            <span>平台</span>
            <select value={channel.platform} onChange={event => handlePlatformChange(event.target.value as BotChannelConfig['platform'])}>
              {BOT_PLATFORM_OPTIONS.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </label>

          {usesAppCredentials && (
            <>
              <label className={attempted && errors.appId ? 'has-error' : ''}>
                <span>{channel.platform === 'weixin' ? 'Bot ID' : 'App ID'}</span>
                <input
                  value={channel.appId}
                  onChange={event => updateChannel('appId', event.target.value)}
                  placeholder={channel.platform === 'weixin' ? '扫码后自动回填' : '扫码回填或手动输入'}
                  aria-invalid={Boolean(attempted && errors.appId)}
                />
              </label>
              <label className={attempted && errors.secret ? 'has-error' : ''}>
                <span>{channel.platform === 'weixin' ? 'Bot Token' : 'App Secret'}</span>
                <input
                  type="password"
                  value={channel.secret}
                  onChange={event => updateChannel('secret', event.target.value)}
                  placeholder={channel.platform === 'weixin' ? '扫码后自动回填' : '扫码回填或手动输入'}
                  aria-invalid={Boolean(attempted && errors.secret)}
                />
              </label>
              {channel.platform === 'weixin' && (
                <label className="bot-dialog-form-wide">
                  <span>iLink API 地址</span>
                  <input value={channel.webhookUrl} onChange={event => updateChannel('webhookUrl', event.target.value)} />
                </label>
              )}
              {channel.platform === 'feishu' && (
                <label>
                  <span>接收 ID 类型</span>
                  <select value={channel.receiveIdType} onChange={event => updateChannel('receiveIdType', event.target.value)}>
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
            <>
              <label className={`bot-dialog-form-wide${attempted && errors.webhookUrl ? ' has-error' : ''}`}>
                <span>桥接发送 URL</span>
                <input
                  value={channel.webhookUrl}
                  onChange={event => updateChannel('webhookUrl', event.target.value)}
                  placeholder="https://"
                  aria-invalid={Boolean(attempted && errors.webhookUrl)}
                />
              </label>
              <label>
                <span>发送鉴权 Token</span>
                <input type="password" value={channel.secret} onChange={event => updateChannel('secret', event.target.value)} placeholder="可选" />
              </label>
              <label className={attempted && errors.callbackToken ? 'has-error' : ''}>
                <span>回调验证 Token</span>
                <input
                  type="password"
                  value={channel.callbackToken}
                  onChange={event => updateChannel('callbackToken', event.target.value)}
                  placeholder="必填"
                  aria-invalid={Boolean(attempted && errors.callbackToken)}
                />
              </label>
            </>
          )}

          <label className={attempted && errors.targetId ? 'has-error' : ''}>
            <span>{channel.platform === 'dingtalk' ? '收件人 userId' : (channel.platform === 'weixin' ? '目标用户 ID' : '目标会话 ID')}</span>
            <input
              value={channel.targetId}
              onChange={event => updateChannel('targetId', event.target.value)}
              placeholder={channel.platform === 'dingtalk' ? '扫码后仍需填写' : (usesAppCredentials ? '扫码后自动回填' : '可选')}
              aria-invalid={Boolean(attempted && errors.targetId)}
            />
          </label>

          {supportsInbound && (
            <label className="bot-dialog-form-wide">
              <span>允许回复的用户 ID</span>
              <textarea
                rows={2}
                value={channel.allowedUserIds.join(', ')}
                onChange={event => updateChannel('allowedUserIds', event.target.value.split(/[,\n]/).map(value => value.trim()).filter(Boolean))}
                placeholder="多个 ID 使用逗号分隔"
              />
            </label>
          )}

          {supportsInbound && (
            <div className="bot-callback-path bot-dialog-form-wide">
              {channel.platform === 'feishu' || channel.platform === 'weixin'
                ? '事件接收：授权后自动建立长连接（无需公网回调）'
                : `本机回调地址：${callbackBaseUrl}/api/bot/inbound/${channel.id}`}
            </div>
          )}
        </div>
      </Dialog>

      {showScan && isAppPlatform(channel.platform) && (
        <BotScanDialog
          platform={channel.platform}
          onClose={() => setShowScan(false)}
          onSuccess={handleScanSuccess}
        />
      )}
    </>
  );
}
