import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { RefreshCw } from 'lucide-react';
import {
  botScanBegin,
  botScanPoll,
  type ScanBeginResult,
  type ScanCredentials,
  type ScanPollResult,
} from '../../services/tauri';
import { Dialog } from '../shared/Dialog';

type Phase = 'loading' | 'waiting' | 'success' | 'failed' | 'expired';

interface BotScanDialogProps {
  platform: 'feishu' | 'weixin' | 'dingtalk';
  onClose: () => void;
  onSuccess: (credentials: ScanCredentials) => void;
}

const PLATFORM_LABEL: Record<BotScanDialogProps['platform'], string> = {
  feishu: '飞书',
  weixin: '微信',
  dingtalk: '钉钉',
};

export function BotScanDialog({ platform, onClose, onSuccess }: BotScanDialogProps) {
  const [begin, setBegin] = useState<ScanBeginResult | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const deadlineRef = useRef(0);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const start = useCallback(async () => {
    setPhase('loading');
    setError('');
    setBegin(null);
    try {
      const result = await botScanBegin(platform);
      setBegin(result);
      deadlineRef.current = Date.now() + result.expireIn * 1000;
      setQrDataUrl(await QRCode.toDataURL(result.qrUrl, { width: 220, margin: 1 }));
      setPhase('waiting');
    } catch (err) {
      setPhase('failed');
      setError(String(err));
    }
  }, [platform]);

  useEffect(() => {
    void start();
  }, [start]);

  // 轮询授权结果：进入 waiting 后按 interval 轮询，终态或过期时停止。
  useEffect(() => {
    if (phase !== 'waiting' || !begin) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pollOnce = async () => {
      if (stopped) return;
      if (Date.now() > deadlineRef.current) {
        setPhase('expired');
        return;
      }
      let result: ScanPollResult;
      try {
        result = await botScanPoll(begin);
      } catch (err) {
        if (stopped) return;
        if (Date.now() > deadlineRef.current) {
          setPhase('expired');
          return;
        }
        setError(String(err));
        timer = setTimeout(pollOnce, (begin.interval + 2) * 1000);
        return;
      }
      if (stopped) return;
      if (result.status === 'success' && result.credentials) {
        setPhase('success');
        onSuccessRef.current(result.credentials);
        return;
      }
      if (result.status === 'expired') {
        setPhase('expired');
        return;
      }
      if (result.status === 'failed') {
        setPhase('failed');
        setError(result.error || '授权失败');
        return;
      }
      timer = setTimeout(pollOnce, begin.interval * 1000);
    };
    timer = setTimeout(pollOnce, begin.interval * 1000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, begin]);

  return (
    <Dialog
      title={`${PLATFORM_LABEL[platform]} 扫码配置`}
      className="bot-scan-dialog"
      bodyClassName="bot-scan-body"
      onClose={onClose}
    >
          {phase === 'loading' && <div className="bot-scan-status">正在生成二维码...</div>}
          {phase === 'waiting' && qrDataUrl && (
            <>
              <img className="bot-scan-qr" src={qrDataUrl} alt="扫码二维码" />
              <p className="bot-scan-tip">请使用 {PLATFORM_LABEL[platform]} App 扫描上方二维码完成授权</p>
              <p className="bot-scan-sub">等待扫描中…</p>
            </>
          )}
          {phase === 'success' && (
            <div className="bot-scan-status success">授权成功，正在回填凭证...</div>
          )}
          {phase === 'expired' && (
            <>
              <div className="bot-scan-status">二维码已过期</div>
              <button className="btn-primary bot-icon-text-btn" onClick={() => void start()}>
                <RefreshCw size={15} aria-hidden="true" />重新生成
              </button>
            </>
          )}
          {phase === 'failed' && (
            <>
              <div className="bot-scan-status error">{error || '授权失败'}</div>
              <button className="btn-primary bot-icon-text-btn" onClick={() => void start()}>
                <RefreshCw size={15} aria-hidden="true" />重试
              </button>
            </>
          )}
    </Dialog>
  );
}
