import type { Profile } from '../types';

export interface GroupTreeNode {
  name: string;
  displayName: string;
  level: number;
  children: Map<string, GroupTreeNode>;
  profiles: Profile[];
}

export function buildGroupTree(profiles: Profile[]): GroupTreeNode[] {
  const rootMap = new Map<string, GroupTreeNode>();

  for (const profile of profiles) {
    const groupPath = profile.group || '默认';
    const parts = groupPath.split('/');

    let currentMap = rootMap;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!currentMap.has(part)) {
        const node: GroupTreeNode = {
          name: currentPath,
          displayName: part,
          level: i,
          children: new Map(),
          profiles: [],
        };
        currentMap.set(part, node);
      }

      const node = currentMap.get(part)!;

      // If this is the last part, add the profile
      if (i === parts.length - 1) {
        node.profiles.push(profile);
      }

      currentMap = node.children;
    }
  }

  return Array.from(rootMap.values());
}

export function sortGroupTree(nodes: GroupTreeNode[]): GroupTreeNode[] {
  return nodes
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'))
    .map(node => {
      const sortedChildren = sortGroupTree(Array.from(node.children.values()));
      const childrenMap = new Map<string, GroupTreeNode>();
      for (const child of sortedChildren) {
        childrenMap.set(child.displayName, child);
      }
      return { ...node, children: childrenMap };
    });
}