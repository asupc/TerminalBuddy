export interface GroupNode<T = unknown> {
  name: string;       // 当前层级名称，如 "前端"
  path: string;       // 完整路径，如 "开发/前端"
  children: GroupNode<T>[];
  items: T[];         // 直接属于该节点的条目
}

const DEFAULT_GROUP = '默认';
const SEPARATOR = '/';

/** 将扁平 group 字符串解析为嵌套树结构 */
export function buildGroupTree<T>(
  items: T[],
  getGroup: (item: T) => string,
  sortItems?: (items: T[]) => T[],
): GroupNode<T>[] {
  // 根 Map：path → GroupNode（用 Map 保证插入序，后续排序）
  const nodeMap = new Map<string, GroupNode<T>>();

  const getOrCreateNode = (path: string): GroupNode<T> => {
    if (nodeMap.has(path)) return nodeMap.get(path)!;
    const segments = path.split(SEPARATOR);
    const name = segments[segments.length - 1];
    const node: GroupNode<T> = { name, path, children: [], items: [] };
    nodeMap.set(path, node);
    // 确保父节点也存在
    if (segments.length > 1) {
      const parentPath = segments.slice(0, -1).join(SEPARATOR);
      const parent = getOrCreateNode(parentPath);
      if (!parent.children.find(c => c.path === path)) {
        parent.children.push(node);
      }
    }
    return node;
  };

  // 分配 items 到对应节点
  for (const item of items) {
    const rawGroup = getGroup(item) || DEFAULT_GROUP;
    const node = getOrCreateNode(rawGroup);
    node.items.push(item);
  }

  // 对每个节点的 items 排序
  if (sortItems) {
    for (const node of nodeMap.values()) {
      if (node.items.length > 0) {
        node.items = sortItems(node.items);
      }
    }
  }

  // 对每个节点的 children 排序（按中文名）
  const sortChildren = (nodes: GroupNode<T>[]): GroupNode<T>[] => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const node of nodes) {
      sortChildren(node.children);
    }
    return nodes;
  };

  // 收集根节点（path 不含 '/' 或是第一段）
  const roots: GroupNode<T>[] = [];
  for (const node of nodeMap.values()) {
    if (!node.path.includes(SEPARATOR)) {
      roots.push(node);
    }
  }

  return sortChildren(roots);
}

