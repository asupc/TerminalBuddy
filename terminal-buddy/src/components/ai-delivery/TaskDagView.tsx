import { useMemo } from "react";
import { ReactFlow, Background, Controls, MiniMap, type NodeTypes } from "@xyflow/react";
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
  const { nodes, edges } = useMemo(() => computeTaskGraphLayout(tasks), [tasks]);

  const nodeTypes = useMemo<NodeTypes>(
    () => ({ taskNode: (props: any) => <TaskNodeCard {...props} compact={compact} /> }),
    [compact]
  );

  return (
    <div className="ai-dag-view">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        onNodeClick={(_, node) => onNodeClick(String(node.id))}
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
