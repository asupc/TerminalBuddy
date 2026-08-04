import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { computeTaskGraphLayout } from "./utils/taskGraphLayout";
import { TaskNodeCard } from "./TaskNodeCard";
import type {
  AiAgent,
  AiAgentRuntime,
  AiRole,
  AiTaskNode,
} from "../../types/aiDelivery";

/** 虚拟「开始」「结束」节点：纯展示，不可连线，但允许拖动位置；
 *  仍需保留 Handle 作为连线锚点，否则 ReactFlow 不会渲染与虚拟节点相连的边。 */
function MarkerNode({ data }: NodeProps) {
  const label = (data as { label?: unknown })?.label;
  return (
    <div
      className="ai-dag-marker"
      style={{
        padding: "6px 14px",
        borderRadius: 999,
        background: "#1e293b",
        color: "#e2e8f0",
        fontSize: 13,
        fontWeight: 600,
        border: "1px dashed #64748b",
        whiteSpace: "nowrap",
      }}
    >
      {/* 虚拟节点也需要 Handle，否则 ReactFlow 无法锚定「开始→首任务」「末任务→结束」的连线 */}
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      {typeof label === "string" ? label : ""}
    </div>
  );
}

interface Props {
  tasks: AiTaskNode[];
  roles?: AiRole[];
  agents?: AiAgent[];
  runtimes?: AiAgentRuntime[];
  onNodeClick: (taskId: string) => void;
}

type SavedPositions = Record<string, { x: number; y: number }>;

const POSITIONS_PREFIX = "ai-dag-drag-positions:v1:";

function loadSavedPositions(deliveryId: string): SavedPositions {
  try {
    const raw = localStorage.getItem(POSITIONS_PREFIX + deliveryId);
    return raw ? (JSON.parse(raw) as SavedPositions) : {};
  } catch {
    return {};
  }
}

/** 将已保存的拖拽位置合并到自动布局节点上（仅保留仍存在的节点）。 */
function applySavedPositions(nodes: Node[], saved: SavedPositions): Node[] {
  const entries = Object.entries(saved);
  if (entries.length === 0) return nodes;
  const savedById = new Map(entries);
  return nodes.map((node) => {
    const position = savedById.get(node.id);
    return position ? { ...node, position } : node;
  });
}

export function TaskDagView({ tasks, roles, agents, runtimes, onNodeClick }: Props) {
  const compact = tasks.length > 50;
  const deliveryId = tasks[0]?.deliveryId ?? "unknown";
  const layout = useMemo(() => computeTaskGraphLayout(tasks), [tasks]);
  const [nodes, setNodes] = useState<Node[]>(() =>
    applySavedPositions(layout.nodes, loadSavedPositions(deliveryId)),
  );
  // 任务集内容指纹：仅任务增删/依赖变化时重置拖拽位置，父组件无关重渲染不影响已拖拽节点。
  const tasksKey = useMemo(
    () =>
      tasks
        .map((task) => `${task.id}:${task.dependencyIds.join("|")}`)
        .sort()
        .join(","),
    [tasks],
  );
  // 最新布局缓存：effect 只依赖 tasksKey/deliveryId，避免轮询刷新（tasks 新引用 → layout 新引用）触发复位。
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    setNodes(applySavedPositions(layoutRef.current.nodes, loadSavedPositions(deliveryId)));
    // layout 随 tasks 重算，但仅在任务集内容变化或切换交付时同步自动布局
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksKey, deliveryId]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // compact 模式禁用拖拽，避免大量节点拖动卡顿
      if (compact) return;
      setNodes((current) => applyNodeChanges(changes, current));
    },
    [compact],
  );

  // 拖拽结束持久化位置：跨轮询刷新、重启应用均保持用户布局
  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      try {
        const saved = loadSavedPositions(deliveryId);
        saved[node.id] = node.position;
        localStorage.setItem(POSITIONS_PREFIX + deliveryId, JSON.stringify(saved));
      } catch {
        /* 持久化失败不影响拖拽 */
      }
    },
    [deliveryId],
  );

  const nodeTypes = useMemo<NodeTypes>(
    () => ({
      taskNode: (props: any) => {
        const task = (props.data as { task?: AiTaskNode })?.task;
        const role = task?.roleId
          ? roles?.find((item) => item.id === task.roleId)
          : undefined;
        const roleName = role?.name;
        const agent =
          (task?.assignedAgentId
            ? agents?.find((item) => item.id === task.assignedAgentId)
            : undefined)
          ?? (role?.lockedAgentId
            ? agents?.find((item) => item.id === role.lockedAgentId)
            : undefined);
        const runtimeName = agent?.runtimeId
          ? runtimes?.find((item) => item.id === agent.runtimeId)?.name
          : undefined;
        return (
          <TaskNodeCard
            {...props}
            compact={compact}
            roleName={roleName}
            runtimeName={runtimeName}
          />
        );
      },
      markerNode: MarkerNode,
    }),
    [compact, roles, agents, runtimes],
  );

  return (
    <div className="ai-dag-view">
      <ReactFlow
        nodes={nodes}
        edges={layout.edges as Edge[]}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={!compact}
        nodesConnectable={false}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_, node) => {
          if (String(node.id).startsWith("__")) return; // 虚拟节点不打开编辑
          onNodeClick(String(node.id));
        }}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
