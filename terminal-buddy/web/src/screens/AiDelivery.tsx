import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, RefreshCw } from 'lucide-react';
import { api, type AiDeliveryItem, type AiDeliveryProject, type AiDeliverySnapshot } from '../api';

const RETRYABLE_STATES = ['failed', 'rework', 'policyViolation'];

export default function AiDelivery() {
  const [projects, setProjects] = useState<AiDeliveryProject[]>([]);
  const [deliveries, setDeliveries] = useState<AiDeliveryItem[]>([]);
  const [snapshot, setSnapshot] = useState<AiDeliverySnapshot | null>(null);
  const [projectId, setProjectId] = useState('');
  const [deliveryId, setDeliveryId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createRequirement, setCreateRequirement] = useState('');
  const [answerText, setAnswerText] = useState<Record<string, string>>({});

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

  const run = (op: () => Promise<unknown>, label: string) => {
    setBusy(true);
    op()
      .then(refreshSnapshot)
      .catch(reason => setError(`${label}失败: ${String(reason)}`))
      .finally(() => setBusy(false));
  };

  const handleCreate = async () => {
    if (!projectId || !createTitle.trim()) return;
    setBusy(true);
    try {
      const created = await api.createAiDelivery({
        projectId,
        title: createTitle.trim(),
        requirement: createRequirement.trim(),
      });
      setShowCreate(false);
      setCreateTitle('');
      setCreateRequirement('');
      const nextDeliveries = await api.getAiDeliveries(projectId);
      setDeliveries(nextDeliveries);
      if (created.id) {
        setDeliveryId(created.id);
        setSnapshot(await api.getAiDeliverySnapshot(created.id));
      }
    } catch (reason) { setError(`创建交付失败: ${String(reason)}`); } finally { setBusy(false); }
  };

  const submitAnswer = (decisionId: string) => {
    const text = (answerText[decisionId] || '').trim();
    if (!text) return;
    setBusy(true);
    api.answerAiDecision(decisionId, text)
      .then(refreshSnapshot)
      .catch(reason => setError(`提交回答失败: ${String(reason)}`))
      .finally(() => {
        setBusy(false);
        setAnswerText(prev => ({ ...prev, [decisionId]: '' }));
      });
  };

  return (
    <div className="screen ai-web-screen">
      <header className="topbar">
        <button className="icon-button" type="button" title="返回连接" onClick={() => { window.location.href = '/'; }}><ArrowLeft size={19} /></button>
        <strong>AI 交付</strong>
        <button className="icon-button" type="button" title="刷新" onClick={() => void load()}><RefreshCw size={18} /></button>
      </header>
      <main className="ai-web-body">
        <p className="ai-web-note">远程操作：创建交付、规划、派发、手动完成、合并与重试。执行细节仍需桌面端参与。</p>
        {error && <div className="nav-error">{error}</div>}
        <label className="ai-web-field">项目
          <select value={projectId} onChange={event => void selectProject(event.target.value)}>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <div className="ai-web-deliveries">
          {deliveries.map(delivery => (
            <button type="button" key={delivery.id} className={delivery.id === deliveryId ? 'active' : ''} onClick={() => void selectDelivery(delivery.id)}>
              <span>{delivery.title}</span><small>{delivery.state}</small>
            </button>
          ))}
        </div>
        {snapshot && (
          <section className="ai-web-detail">
            <div className="ai-web-title">
              <div><h1>{snapshot.delivery.title}</h1><p>{snapshot.delivery.requirement}</p></div>
              <span>{snapshot.delivery.state}</span>
            </div>
            <div className="ai-web-actions">
              <button className="btn" type="button" disabled={busy} onClick={() => setShowCreate(v => !v)}>创建交付</button>
              <button className="btn" type="button" disabled={busy} onClick={() => run(() => api.planAiDelivery(snapshot.delivery.id), '重新规划')}>重新规划</button>
              <button className="btn" type="button" disabled={busy} onClick={() => run(() => api.dispatchAiDelivery(snapshot.delivery.id), '派发')}>派发</button>
              <button className="btn" type="button" disabled={busy} onClick={() => run(() => api.completeAiDeliveryAttempt(snapshot.delivery.id), '手动完成')}>手动完成</button>
              <button className="btn" type="button" disabled={busy} onClick={() => run(() => api.mergeAiDelivery(snapshot.delivery.id), '合并')}>合并</button>
              <button className="btn" type="button" disabled={busy} onClick={() => run(() => api.cleanupIntegration(snapshot.delivery.id), '清理集成')}>清理集成</button>
            </div>
            {showCreate && (
              <div className="ai-web-create">
                <input placeholder="交付标题" value={createTitle} onChange={event => setCreateTitle(event.target.value)} />
                <textarea placeholder="需求描述" value={createRequirement} onChange={event => setCreateRequirement(event.target.value)} />
                <button className="btn primary" type="button" disabled={busy || !createTitle.trim()} onClick={() => void handleCreate()}>创建</button>
              </div>
            )}
            {['drafting', 'awaitingApproval'].includes(snapshot.delivery.state) && snapshot.tasks.length > 0 && (
              <button className="btn primary" type="button" disabled={busy} onClick={() => run(() => api.approveAiDelivery(snapshot.delivery.id), '批准任务图')}>
                <Check size={17} />批准任务图
              </button>
            )}
            <h2>任务</h2>
            {snapshot.tasks.map(task => (
              <div className="ai-web-task" key={task.id}>
                <strong>{task.title}</strong><span>{task.state}</span>
                <small>{task.allowedWritePaths.join(', ')}</small>
                {RETRYABLE_STATES.includes(task.state) && (
                  <button className="btn" type="button" disabled={busy} onClick={() => run(() => api.retryAiDeliveryTask(snapshot.delivery.id, task.id), '重试')}>重试</button>
                )}
              </div>
            ))}
            {snapshot.decisions.filter(item => item.state === 'pending').map(decision => (
              <div className="ai-web-decision" key={decision.id}>
                <strong>需要你的决策</strong>
                <p>{decision.question}</p>
                <small>{decision.impact}</small>
                <div>{decision.options.map(option => (
                  <button type="button" key={option.label} disabled={busy} onClick={() => run(() => api.answerAiDecision(decision.id, option.label), '提交回答')}>{option.label}</button>
                ))}</div>
                <div className="ai-web-decision-free">
                  <textarea placeholder="自由输入回答（不限于选项）" value={answerText[decision.id] || ''} onChange={event => setAnswerText(prev => ({ ...prev, [decision.id]: event.target.value }))} />
                  <button type="button" disabled={busy || !(answerText[decision.id] || '').trim()} onClick={() => submitAnswer(decision.id)}>提交回答</button>
                </div>
              </div>
            ))}
            <h2>事件</h2>
            <div className="ai-web-events">
              {snapshot.events.slice(-12).reverse().map(event => (
                <div key={event.id}><small>{new Date(event.occurredAt).toLocaleString()}</small><span>{event.message}</span></div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
