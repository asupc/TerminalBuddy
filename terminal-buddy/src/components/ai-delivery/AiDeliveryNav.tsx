import { Bot, CircleDot, RefreshCw, ShieldCheck, SquareTerminal, Users, Workflow } from 'lucide-react';
import type { AiRuntimeProbe } from '../../types/aiDelivery';
import type { AiDeliveryConfigView } from './workspace-utils';
import './AiDeliveryNav.css';

const label = (kind: string) => kind === 'claude' ? 'Claude Code' : kind === 'opencode' ? 'OpenCode' : kind === 'hermes' ? 'Hermes' : kind === 'pi' ? 'Pi' : kind === 'mimo' ? 'Mimo Code' : kind === 'kimi' ? 'Kimi Code' : 'Codex';

const runtimeKinds = ['codex', 'claude', 'opencode', 'hermes', 'pi', 'mimo', 'kimi'] as const;

interface AiDeliveryNavProps {
  runtimes: AiRuntimeProbe[];
  isDetecting: boolean;
  error: string;
  onDetect: () => Promise<void>;
  onOpenConfiguration: (view: AiDeliveryConfigView) => void;
}

export function AiDeliveryNav({ runtimes, isDetecting, error, onDetect, onOpenConfiguration }: AiDeliveryNavProps) {

  return <aside className="ai-delivery-nav ai-delivery-rail" aria-label="AI 交付导航">
    <div className="panel-titlebar"><span className="panel-title">AI 交付</span></div>
    <section className="ai-rail-section"><div className="ai-rail-heading"><CircleDot size={14} />可用 Runtime<button type="button" className="ai-rail-runtime-reload" disabled={isDetecting} onClick={() => void onDetect()}><RefreshCw size={12} />重新检测</button></div>{runtimeKinds.map(kind => { const available = runtimes.some(item => item.kind === kind && item.available); return <div className="ai-rail-runtime" key={kind}><i className={!isDetecting && available ? 'online' : ''} /><span>{label(kind)}</span><small>{isDetecting ? '检测中' : available ? '已就绪' : '不可用'}</small></div>; })}{error && <p className="ai-rail-error">{error}</p>}</section>
    <section className="ai-rail-section"><div className="ai-rail-heading"><Workflow size={14} />交付流程</div><ol className="ai-rail-steps"><li>登记多仓库项目</li><li>创建需求与任务图</li><li>批准后并发执行</li><li>审核并本地合并</li></ol></section>
    <nav className="ai-rail-section ai-rail-config" aria-label="AI 交付配置管理">
      <div className="ai-rail-heading">配置管理</div>
      <button type="button" onClick={() => onOpenConfiguration('workflow')}>
        <Workflow size={15} />
        <span><strong>任务编排</strong><small>步骤、顺序与执行角色</small></span>
      </button>
      <button type="button" onClick={() => onOpenConfiguration('roles')}>
        <Users size={15} />
        <span><strong>角色管理</strong><small>自由定义团队职责</small></span>
      </button>
      <button type="button" onClick={() => onOpenConfiguration('runtimes')}>
        <SquareTerminal size={15} />
        <span><strong>Runtime 管理</strong><small>本机 CLI 命令与启用状态</small></span>
      </button>
      <button type="button" onClick={() => onOpenConfiguration('agents')}>
        <Bot size={15} />
        <span><strong>Agent 配置</strong><small>本机 CLI 与启动参数</small></span>
      </button>
    </nav>
    <section className="ai-rail-safety"><ShieldCheck size={15} /><p>Coder 仅获得单服务 worktree。不会自动推送、创建 PR 或部署。</p></section>
  </aside>;
}
