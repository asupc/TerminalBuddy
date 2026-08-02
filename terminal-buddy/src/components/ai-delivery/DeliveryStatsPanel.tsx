import { useEffect, useMemo, useState } from "react";
import type { AiAgent, AiAttempt, AiDelivery } from "../../types/aiDelivery";
import { getAiAttempts } from "../../services/tauri";

interface DeliveryStatsPanelProps {
  deliveries: AiDelivery[];
  agents?: AiAgent[];
}

interface AgentStat {
  count: number;
  totalDurationMs: number;
  successCount: number;
}

const terminalDeliveryStates = new Set(["succeeded", "completed", "failed", "cancelled", "mergeFailed"]);

function summarizeFailure(summary: string | null | undefined): string {
  const text = (summary ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "（无摘要）";
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** 交付统计面板：成功率 / 任务成功率 / 平均执行时长 / 失败原因聚类 / Agent 调用。纯前端计算。 */
export function DeliveryStatsPanel({ deliveries, agents }: DeliveryStatsPanelProps) {
  const [attempts, setAttempts] = useState<AiAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void getAiAttempts()
      .then((items) => {
        if (!disposed) setAttempts(items);
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, []);

  const stats = useMemo(() => {
    const agentName = (agentId: string) =>
      agents?.find((agent) => agent.id === agentId)?.name ?? agentId.slice(0, 8);

    // 1) 交付成功率
    const terminatedDeliveries = deliveries.filter((d) => terminalDeliveryStates.has(d.state));
    const succeededDeliveries = deliveries.filter(
      (d) => d.state === "succeeded" || d.state === "completed",
    ).length;
    const deliverySuccessRate = terminatedDeliveries.length
      ? (succeededDeliveries / terminatedDeliveries.length * 100).toFixed(1)
      : null;

    // 2) 任务成功率：按 deliveryId+taskNodeId 分组 attempt（created_at 升序），
    //    组内第 1 个成功 = 首次成功；首个失败但后续成功 = 重试后成功
    const taskGroups = new Map<string, AiAttempt[]>();
    for (const attempt of attempts) {
      if (!attempt.taskNodeId) continue;
      const key = `${attempt.deliveryId}::${attempt.taskNodeId}`;
      const group = taskGroups.get(key) ?? [];
      group.push(attempt);
      taskGroups.set(key, group);
    }
    let firstTrySuccess = 0;
    let retrySuccess = 0;
    let neverSucceeded = 0;
    for (const group of taskGroups.values()) {
      const ordered = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const succeededIndex = ordered.findIndex((a) => a.state === "completed");
      if (succeededIndex === -1) {
        neverSucceeded += 1;
      } else if (succeededIndex === 0) {
        firstTrySuccess += 1;
      } else {
        retrySuccess += 1;
      }
    }
    const taskTotal = firstTrySuccess + retrySuccess + neverSucceeded;

    // 3) 平均执行时长（按 Agent，分钟）
    const agentDurations = new Map<string, number[]>();
    const agentDurationTotal = new Map<string, number>();
    for (const attempt of attempts) {
      if (!attempt.startedAt || !attempt.finishedAt) continue;
      const started = new Date(attempt.startedAt).getTime();
      const finished = new Date(attempt.finishedAt).getTime();
      if (Number.isNaN(started) || Number.isNaN(finished) || finished <= started) continue;
      const duration = finished - started;
      agentDurations.set(agentName(attempt.agentId), [...(agentDurations.get(agentName(attempt.agentId)) ?? []), duration]);
      agentDurationTotal.set(agentName(attempt.agentId), (agentDurationTotal.get(agentName(attempt.agentId)) ?? 0) + duration);
    }
    const avgDurationByAgent = [...agentDurationTotal.entries()]
      .map(([name, total]) => {
        const count = (agentDurations.get(name) ?? []).length;
        return { name, avgMinutes: Math.round(total / count / 60000 * 10) / 10, count };
      })
      .sort((a, b) => b.avgMinutes - a.avgMinutes)
      .slice(0, 5);

    // 4) 失败原因聚类：非成功 attempt 的 summary 首段 Top5
    const failureCounts = new Map<string, number>();
    for (const attempt of attempts) {
      if (attempt.state === "completed" || attempt.state === "cancelled") continue;
      if (!attempt.summary) continue;
      const key = summarizeFailure(attempt.summary);
      failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
    }
    const topFailureReasons = [...failureCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // 5) Agent 调用统计：次数 / 总耗时 / 成功率
    const agentStats = new Map<string, AgentStat>();
    for (const attempt of attempts) {
      const stat = agentStats.get(attempt.agentId) ?? { count: 0, totalDurationMs: 0, successCount: 0 };
      stat.count += 1;
      if (attempt.state === "completed") stat.successCount += 1;
      if (attempt.startedAt && attempt.finishedAt) {
        const started = new Date(attempt.startedAt).getTime();
        const finished = new Date(attempt.finishedAt).getTime();
        if (!Number.isNaN(started) && !Number.isNaN(finished) && finished > started) {
          stat.totalDurationMs += finished - started;
        }
      }
      agentStats.set(attempt.agentId, stat);
    }
    const agentCalls = [...agentStats.entries()]
      .map(([agentId, stat]) => ({
        name: agentName(agentId),
        count: stat.count,
        totalMinutes: Math.round(stat.totalDurationMs / 60000 * 10) / 10,
        successRate: stat.count ? Math.round(stat.successCount / stat.count * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      deliverySuccessRate,
      succeededDeliveries,
      terminatedDeliveries: terminatedDeliveries.length,
      deliveriesCount: deliveries.length,
      firstTrySuccess,
      retrySuccess,
      neverSucceeded,
      taskTotal,
      avgDurationByAgent,
      topFailureReasons,
      agentCalls,
    };
  }, [deliveries, attempts, agents]);

  if (loading) {
    return <p className="ai-stats-muted">正在汇总执行记录...</p>;
  }
  if (error) {
    return <p className="ai-stats-muted">统计加载失败：{error}</p>;
  }

  const taskSuccessTotal = stats.firstTrySuccess + stats.retrySuccess;

  return (
    <div className="ai-stats-panel">
      <div className="ai-stats-grid">
        <div className="ai-stat-card">
          <span>交付成功率</span>
          <strong>{stats.deliverySuccessRate === null ? "—" : `${stats.deliverySuccessRate}%`}</strong>
          <small>{stats.succeededDeliveries}/{stats.terminatedDeliveries} 已结束交付成功（共 {stats.deliveriesCount} 个交付）</small>
        </div>
        <div className="ai-stat-card">
          <span>任务成功率</span>
          <strong>{stats.taskTotal ? `${Math.round(taskSuccessTotal / stats.taskTotal * 100)}%` : "—"}</strong>
          <small>首次成功 {stats.firstTrySuccess} · 重试后成功 {stats.retrySuccess} · 未成功 {stats.neverSucceeded}</small>
        </div>
        <div className="ai-stat-card">
          <span>平均执行时长</span>
          <strong>{stats.avgDurationByAgent.length ? `${stats.avgDurationByAgent[0].avgMinutes} 分钟` : "—"}</strong>
          <small>耗时最长的 Agent：{stats.avgDurationByAgent[0]?.name ?? "暂无数据"}</small>
        </div>
        <div className="ai-stat-card">
          <span>Agent 调用</span>
          <strong>{stats.agentCalls.reduce((sum, item) => sum + item.count, 0)} 次</strong>
          <small>{stats.agentCalls.length} 个 Agent 参与过执行</small>
        </div>
      </div>

      <div className="ai-stats-columns">
        <section className="ai-stats-section">
          <h4>失败原因 Top5</h4>
          {stats.topFailureReasons.length === 0 ? (
            <p className="ai-stats-muted">暂无失败记录</p>
          ) : (
            <ol className="ai-stats-list">
              {stats.topFailureReasons.map(([reason, count]) => (
                <li key={reason}>
                  <span>{reason}</span>
                  <strong>{count}</strong>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="ai-stats-section">
          <h4>Agent 调用统计</h4>
          {stats.agentCalls.length === 0 ? (
            <p className="ai-stats-muted">暂无调用记录</p>
          ) : (
            <table className="ai-stats-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>次数</th>
                  <th>总耗时</th>
                  <th>成功率</th>
                </tr>
              </thead>
              <tbody>
                {stats.agentCalls.map((item) => (
                  <tr key={item.name}>
                    <td>{item.name}</td>
                    <td>{item.count}</td>
                    <td>{item.totalMinutes} 分钟</td>
                    <td>{item.successRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
