import type { Node, Edge } from "@xyflow/react";
import type { AiTaskNode } from "../../../types/aiDelivery";

interface LayoutCache {
  layoutVersion: string;
  nodes: Node[];
  edges: Edge[];
}

const CACHE_PREFIX = "ai-delivery-graph-layout:v5:";

/** 传递依赖裁剪：只保留直接依赖边，去掉可由其他直接依赖间接到达的依赖。
 *  例如 D 依赖 [A, B, C] 且 C→B→A 时，只保留 D→C（间接链路由数据隐式满足）。 */
function directDependencyPairs(tasks: AiTaskNode[]): Array<[string, string]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const collectReachable = (start: string, visited: Set<string>) => {
    if (visited.has(start)) return;
    visited.add(start);
    byId.get(start)?.dependencyIds.forEach((depId) => collectReachable(depId, visited));
  };
  const pairs: Array<[string, string]> = [];
  for (const task of tasks) {
    const deps = Array.from(new Set(task.dependencyIds));
    const reachableFrom = new Map<string, Set<string>>();
    deps.forEach((depId) => {
      const set = new Set<string>();
      collectReachable(depId, set);
      set.delete(depId);
      reachableFrom.set(depId, set);
    });
    deps.forEach((depId) => {
      const indirect = deps.some(
        (other) => other !== depId && (reachableFrom.get(other)?.has(depId) ?? false),
      );
      if (!indirect) pairs.push([depId, task.id]);
    });
  }
  return pairs;
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}

function computeVersion(tasks: AiTaskNode[]): string {
  const nodeIds = tasks.map((t) => t.id).sort().join(",");
  const edgePairs = directDependencyPairs(tasks)
    .map(([source, target]) => [source, target].sort().join("|"))
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

  // 依赖边在全图上做传递裁剪：旧数据里可能存了 D→A、D→B 这类间接依赖，
  // 渲染只保留直接依赖线，避免 DAG 杂乱。
  const directPairs = directDependencyPairs(tasks);
  const directDepOf = new Map<string, Set<string>>();
  directPairs.forEach(([source, target]) => {
    if (!directDepOf.has(target)) directDepOf.set(target, new Set());
    directDepOf.get(target)!.add(source);
  });

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
      (directDepOf.get(task.id) ?? []).forEach((depId) =>
        edges.push({ id: `${depId}->${task.id}`, source: depId, target: task.id } as Edge)
      );
    });
  });

  // 虚拟「开始」「结束」节点：纯展示，不代表真实任务，不参与依赖校验/派发/成果交接。
  // id 以 __ 前缀标记，TaskDagView 据此跳过点击编辑；位置可拖动并随其他节点一起持久化。
  if (tasks.length > 0) {
    const positionById = new Map(nodes.map((node) => [node.id, node.position]));
    const referencedIds = new Set(directPairs.map(([source]) => source));
    const startTargets = tasks.filter((task) => (directDepOf.get(task.id)?.size ?? 0) === 0);
    const endSources = tasks.filter((task) => !referencedIds.has(task.id));
    const meanY = (ids: string[]): number =>
      ids.length === 0
        ? 0
        : ids.reduce((sum, id) => sum + (positionById.get(id)?.y ?? 0), 0) / ids.length;
    const maxLayerNum = Object.keys(byLayer)
      .map(Number)
      .reduce((max, value) => Math.max(max, value), -1);

    if (startTargets.length > 0) {
      nodes.push({
        id: "__start__",
        type: "markerNode",
        position: { x: -240, y: meanY(startTargets.map((task) => task.id)) },
        data: { label: "开始" },
      });
      startTargets.forEach((task) =>
        edges.push({ id: `__start__->${task.id}`, source: "__start__", target: task.id } as Edge),
      );
    }
    if (endSources.length > 0) {
      nodes.push({
        id: "__end__",
        type: "markerNode",
        position: { x: (maxLayerNum + 1) * 240, y: meanY(endSources.map((task) => task.id)) },
        data: { label: "结束" },
      });
      endSources.forEach((task) =>
        edges.push({ id: `${task.id}->__end__`, source: task.id, target: "__end__" } as Edge),
      );
    }
  }

  const result: LayoutCache = { layoutVersion, nodes, edges };
  try {
    localStorage.setItem(cacheKey, JSON.stringify(result));
  } catch {
    /* 缓存失败不影响渲染 */
  }
  return { nodes: result.nodes, edges: result.edges };
}
