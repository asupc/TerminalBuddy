import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, RefreshCw } from 'lucide-react';
import { api, type AiDeliveryItem, type AiDeliveryProject, type AiDeliverySnapshot } from '../api';

export default function AiDelivery() {
  const [projects, setProjects] = useState<AiDeliveryProject[]>([]);
  const [deliveries, setDeliveries] = useState<AiDeliveryItem[]>([]);
  const [snapshot, setSnapshot] = useState<AiDeliverySnapshot | null>(null);
  const [projectId, setProjectId] = useState('');
  const [deliveryId, setDeliveryId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const nextProjects = await api.getAiDeliveryProjects();
      setProjects(nextProjects);
      const activeProject = projectId || nextProjects[0]?.id || '';
      if (!activeProject) return;
      setProjectId(activeProject);
      const nextDeliveries = await api.getAiDeliveries(activeProject);
      setDeliveries(nextDeliveries);
      const activeDelivery = deliveryId || nextDeliveries[0]?.id || '';
      if (activeDelivery && nextDeliveries.some(item => item.id === activeDelivery)) {
        setDeliveryId(activeDelivery);
        setSnapshot(await api.getAiDeliverySnapshot(activeDelivery));
      } else { setSnapshot(null); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '加载 AI 交付失败'); }
  }, [deliveryId, projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => void load(), 5000); return () => window.clearInterval(timer); }, [load]);
  const selectProject = async (id: string) => { setProjectId(id); setDeliveryId(''); setSnapshot(null); const next = await api.getAiDeliveries(id); setDeliveries(next); if (next[0]) { setDeliveryId(next[0].id); setSnapshot(await api.getAiDeliverySnapshot(next[0].id)); } };
  const selectDelivery = async (id: string) => { setDeliveryId(id); setSnapshot(await api.getAiDeliverySnapshot(id)); };
  const refreshSnapshot = async () => { if (deliveryId) setSnapshot(await api.getAiDeliverySnapshot(deliveryId)); };

  return <div className="screen ai-web-screen"><header className="topbar"><button className="icon-button" type="button" title="返回连接" onClick={() => { window.location.href = '/'; }}><ArrowLeft size={19} /></button><strong>AI 交付</strong><button className="icon-button" type="button" title="刷新" onClick={() => void load()}><RefreshCw size={18} /></button></header>
    <main className="ai-web-body"><p className="ai-web-note">仅观察、批准任务图和回答决策。本机 CLI、派发、审核与合并仍只在桌面端执行。</p>{error && <div className="nav-error">{error}</div>}<label className="ai-web-field">项目<select value={projectId} onChange={event => void selectProject(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <div className="ai-web-deliveries">{deliveries.map(delivery => <button type="button" key={delivery.id} className={delivery.id === deliveryId ? 'active' : ''} onClick={() => void selectDelivery(delivery.id)}><span>{delivery.title}</span><small>{delivery.state}</small></button>)}</div>
      {snapshot && <section className="ai-web-detail"><div className="ai-web-title"><div><h1>{snapshot.delivery.title}</h1><p>{snapshot.delivery.requirement}</p></div><span>{snapshot.delivery.state}</span></div>{['drafting', 'awaitingApproval'].includes(snapshot.delivery.state) && snapshot.tasks.length > 0 && <button className="btn primary" type="button" onClick={() => void api.approveAiDelivery(snapshot.delivery.id).then(refreshSnapshot).catch(reason => setError(String(reason)))}><Check size={17} />批准任务图</button>}<h2>任务</h2>{snapshot.tasks.map(task => <div className="ai-web-task" key={task.id}><strong>{task.title}</strong><span>{task.state}</span><small>{task.allowedWritePaths.join(', ')}</small></div>)}{snapshot.decisions.filter(item => item.state === 'pending').map(decision => <div className="ai-web-decision" key={decision.id}><strong>需要你的决策</strong><p>{decision.question}</p><small>{decision.impact}</small><div>{decision.options.map(option => <button type="button" key={option.label} onClick={() => void api.answerAiDecision(decision.id, option.label).then(refreshSnapshot).catch(reason => setError(String(reason)))}>{option.label}</button>)}</div></div>)}<h2>事件</h2><div className="ai-web-events">{snapshot.events.slice(-12).reverse().map(event => <div key={event.id}><small>{new Date(event.occurredAt).toLocaleString()}</small><span>{event.message}</span></div>)}</div></section>}</main></div>;
}
