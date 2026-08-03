import type { Node, Edge } from "@xyflow/react";
import type { AiTaskNode } from "../../../types/aiDelivery";

interface LayoutCache {
  layoutVersion: string;
  nodes: Node[];
  edges: Edge[];
}

const CACHE_PREFIX = "ai-delivery-graph-layout:v2:";

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}

function computeVersion(tasks: AiTaskNode[]): string {
  const nodeIds = tasks.map((t) => t.id).sort().join(",");
  const edgePairs = tasks
    .flatMap((t) => t.dependencyIds.map((d) => [d, t.id].sort().join("|")))
    .sort()
    .join(",");
  return simpleHash(`${nodeIds};;${edgePairs}`);
}

/** 拓扑分层布局：每节点层 = max(父节点层) + 1；同层按标题字母序；结果缓存到 localStorage。
 *  缓存键含 layoutVersion（节点 id 集合 + 依赖边集合的短 hash），节点/依赖增删均触发重算。 */
export function computeTaskGraphLayout(tasks: AiTaskNode[]) {
  const deliveryId = tasks[0]?.deliveryId ?? "unknown";
  const layoutVersion = computeVersion(tasks);
  const cacheKey = `${CACHE_PREFIX}${deliveryId}`;
  const cached = (() => {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as LayoutCache;
      return parsed.layoutVersion === layoutVersion ? parsed : null;
    } catch {
      return null;
    }
  })();

  if (cached) return { nodes: cached.nodes, edges: cached.edges };

  // 简化 Kahn 拓扑分层：每节点层 = max(父节点层) + 1
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const layer: Record<string, number> = {};
  const visiting = new Set<string>(); // 环防护：既有数据若含环（T4-1 只防新增环）避免无限递归栈溢出
  const computeLayer = (id: string): number => {
    if (layer[id] !== undefined) return layer[id];
    const task = byId.get(id);
    if (!task || task.dependencyIds.length === 0) return (layer[id] = 0);
    if (visiting.has(id)) return 0; // 环：给兜底层号，避免栈溢出
    visiting.add(id);
    const parentMax = Math.max(...task.dependencyIds.map((d) => computeLayer(d)));
    visiting.delete(id);
    return (layer[id] = parentMax + 1);
  };
  tasks.forEach((t) => computeLayer(t.id));

  const byLayer: Record<number, AiTaskNode[]> = {};
  tasks.forEach((t) => (byLayer[layer[t.id]] ??= []).push(t));
  Object.values(byLayer).forEach((list) => list.sort((a, b) => a.title.localeCompare(b.title)));

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  Object.entries(byLayer).forEach(([layerNum, layerTasks]) => {
    layerTasks.forEach((task, index) => {
      nodes.push({
        id: task.id,
        position: { x: Number(layerNum) * 240, y: index * 120 },
        data: { task },
        type: "taskNode",
      });
      task.dependencyIds.forEach((depId) =>
        edges.push({ id: `${depId}->${task.id}`, source: depId, target: task.id } as Edge)
      );
    });
  });

  const result: LayoutCache = { layoutVersion, nodes, edges };
  try {
    localStorage.setItem(cacheKey, JSON.stringify(result));
  } catch {
    /* 缓存失败不影响渲染 */
  }
  return { nodes: result.nodes, edges: result.edges };
}
