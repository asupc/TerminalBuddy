import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  type Edge,
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

export function TaskDagView({ tasks, onNodeClick }: Props) {
  const compact = tasks.length > 50;
  const layout = useMemo(() => computeTaskGraphLayout(tasks), [tasks]);
  const [nodes, setNodes] = useState(layout.nodes);
  // 任务集内容指纹：仅任务增删/依赖变化时重置拖拽位置，父组件无关重渲染不影响已拖拽节点。
  const tasksKey = useMemo(
    () =>
      tasks
        .map((task) => `${task.id}:${task.dependencyIds.join("|")}`)
        .sort()
        .join(","),
    [tasks],
  );

  useEffect(() => {
    setNodes(layout.nodes);
    // layout 随 tasks 重算，仅任务集变化时同步（以 tasksKey 为准）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksKey, layout]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // compact 模式禁用拖拽，避免大量节点拖动卡顿
      if (compact) return;
      setNodes((current) => applyNodeChanges(changes, current));
    },
    [compact],
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
        onNodeClick={(_, node) => onNodeClick(String(node.id))}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
