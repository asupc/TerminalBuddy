import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { computeTaskGraphLayout } from "./utils/taskGraphLayout";
import { TaskNodeCard } from "./TaskNodeCard";
import type { AiTaskNode } from "../../types/aiDelivery";

interface Props {
  tasks: AiTaskNode[];
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

export function TaskDagView({ tasks, onNodeClick }: Props) {
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
    () => ({ taskNode: (props: any) => <TaskNodeCard {...props} compact={compact} /> }),
    [compact],
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
        onNodeClick={(_, node) => onNodeClick(String(node.id))}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
