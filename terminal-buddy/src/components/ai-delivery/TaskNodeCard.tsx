import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { AiTaskNode } from "../../types/aiDelivery";

// 任务实际状态全集（12 种）——无 "completed"（成功态为 "succeeded"）；skipped 为标记忽略
export const STATE_COLORS: Record<string, string> = {
  planned: "#94a3b8", ready: "#3b82f6", queued: "#60a5fa",
  running: "#eab308", succeeded: "#22c55e", failed: "#ef4444",
  policyViolation: "#dc2626", rework: "#f97316", cancelled: "#64748b",
  awaitingReview: "#06b6d4", needsInput: "#a855f7", skipped: "#94a3b8",
};

export function TaskNodeCard({ data, compact }: NodeProps & { compact?: boolean }) {
  const task = data.task as AiTaskNode;
  if (compact) {
    return (
      <div className="ai-dag-node ai-dag-node-compact" style={{ background: STATE_COLORS[task.state] ?? "#94a3b8" }}>
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }
  return (
    <div className={`ai-dag-node ${task.state === "running" ? "ai-dag-node-running" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="ai-dag-node-title">{task.title}</div>
      <div className="ai-dag-node-meta">
        <span className="ai-status-chip" style={{ background: STATE_COLORS[task.state] ?? "#94a3b8" }}>{task.state}</span>
        {task.roleId && <span className="ai-dag-node-role">角色 {task.roleId}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
