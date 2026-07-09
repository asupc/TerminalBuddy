import type { GitCommit, GitHistoryRef, GitHistoryResult } from '../services/tauri';

export const SWIMLANE_HEIGHT = 22;
export const SWIMLANE_WIDTH = 11;
export const SWIMLANE_CURVE_RADIUS = 5;
export const CIRCLE_RADIUS = 4;
export const CIRCLE_STROKE_WIDTH = 2;

export const HISTORY_COLORS = {
  local: '#3794ff',
  remote: '#b180d7',
  base: '#ea5c00',
  tag: '#d7ba7d',
  foregrounds: ['#ffb000', '#dc267f', '#994f00', '#40b0a6', '#b66dff'],
} as const;

export interface HistoryGraphNode {
  id: string;
  color: string;
}

export type HistoryGraphKind = 'head' | 'node' | 'incoming-changes' | 'outgoing-changes';

export interface HistoryGraphViewModel {
  commit: GitCommit;
  kind: HistoryGraphKind;
  inputSwimlanes: HistoryGraphNode[];
  outputSwimlanes: HistoryGraphNode[];
  currentSwimlaneIndex: number;
  currentLaneStarted: boolean;
  currentNode: HistoryGraphNode;
}

export interface HistoryGraphResult {
  viewModels: HistoryGraphViewModel[];
  laneCount: number;
}

function refPriority(ref: GitHistoryRef): number {
  if (ref.isCurrent || ref.kind === 'head') return 0;
  if (ref.isUpstream) return 1;
  if (ref.isBase || ref.kind === 'base') return 2;
  if (ref.kind === 'local') return 3;
  if (ref.kind === 'remote') return 4;
  if (ref.kind === 'tag') return 5;
  return 6;
}

export function sortHistoryRefs(refs: GitHistoryRef[]): GitHistoryRef[] {
  return [...refs].sort((a, b) => {
    const priority = refPriority(a) - refPriority(b);
    if (priority !== 0) return priority;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

export function historyRefColor(ref: GitHistoryRef): string {
  if (ref.isBase || ref.kind === 'base') return HISTORY_COLORS.base;
  if (ref.isUpstream || ref.kind === 'remote') return HISTORY_COLORS.remote;
  if (ref.kind === 'tag') return HISTORY_COLORS.tag;
  return HISTORY_COLORS.local;
}

function addRef(refsByRevision: Map<string, GitHistoryRef[]>, ref: GitHistoryRef) {
  const refs = refsByRevision.get(ref.revision) ?? [];
  if (!refs.some((existing) => existing.fullName === ref.fullName)) {
    refs.push(ref);
    refsByRevision.set(ref.revision, refs);
  }
}

function compactLanes(lanes: HistoryGraphNode[]): HistoryGraphNode[] {
  const seen = new Set<string>();
  return lanes.filter((lane) => {
    if (seen.has(lane.id)) return false;
    seen.add(lane.id);
    return true;
  });
}

function cloneLanes(lanes: HistoryGraphNode[]): HistoryGraphNode[] {
  return lanes.map((lane) => ({ ...lane }));
}

export function buildHistoryGraph(result: GitHistoryResult | null): HistoryGraphResult {
  if (!result) {
    return { viewModels: [], laneCount: 0 };
  }

  const refsByRevision = new Map<string, GitHistoryRef[]>();
  const commitsByHash = new Map<string, GitCommit>();
  for (const ref of result.refs) addRef(refsByRevision, ref);
  for (const commit of result.commits) {
    commitsByHash.set(commit.hash, commit);
    for (const ref of commit.refs) addRef(refsByRevision, ref);
  }

  const fallbackColors = new Map<string, string>();
  let colorCursor = 0;
  const refColorForHash = (hash: string): string | null => {
    const refs = refsByRevision.get(hash) ?? commitsByHash.get(hash)?.refs ?? [];
    const preferred = sortHistoryRefs(refs)[0];
    return preferred ? historyRefColor(preferred) : null;
  };
  const colorForHash = (hash: string, fallback?: string): string => {
    const refColor = refColorForHash(hash);
    if (refColor) return refColor;
    if (fallback) return fallback;
    const cached = fallbackColors.get(hash);
    if (cached) return cached;
    const next = HISTORY_COLORS.foregrounds[colorCursor % HISTORY_COLORS.foregrounds.length];
    colorCursor += 1;
    fallbackColors.set(hash, next);
    return next;
  };

  let activeLanes: HistoryGraphNode[] = [];
  let laneCount = 1;

  const viewModels = result.commits.map((commit) => {
    const commitWithSortedRefs = { ...commit, refs: sortHistoryRefs(commit.refs) };
    const inputSwimlanes = cloneLanes(activeLanes);
    const existingIndex = inputSwimlanes.findIndex((lane) => lane.id === commit.hash);
    const currentLaneStarted = existingIndex === -1;
    const currentSwimlaneIndex = currentLaneStarted ? inputSwimlanes.length : existingIndex;
    const currentNode = {
      id: commit.hash,
      color: colorForHash(commit.hash, inputSwimlanes[currentSwimlaneIndex]?.color),
    };

    if (currentLaneStarted) {
      inputSwimlanes.push(currentNode);
    } else {
      inputSwimlanes[currentSwimlaneIndex] = currentNode;
    }

    let outputSwimlanes = cloneLanes(inputSwimlanes);
    const parents = commit.parents.filter(Boolean);
    const seenParents = new Set<string>();
    if (parents.length > 0) {
      const firstParent = parents[0];
      outputSwimlanes[currentSwimlaneIndex] = {
        id: firstParent,
        color: colorForHash(firstParent, currentNode.color),
      };
      seenParents.add(firstParent);
    } else {
      outputSwimlanes.splice(currentSwimlaneIndex, 1);
    }

    for (const parent of parents.slice(1)) {
      if (seenParents.has(parent)) continue;
      const existingParentIndex = outputSwimlanes.findIndex((lane) => lane.id === parent);
      if (existingParentIndex >= 0) {
        outputSwimlanes[existingParentIndex] = {
          id: parent,
          color: colorForHash(parent, outputSwimlanes[existingParentIndex].color),
        };
      } else {
        outputSwimlanes.push({ id: parent, color: colorForHash(parent) });
      }
      seenParents.add(parent);
    }

    outputSwimlanes = compactLanes(outputSwimlanes);
    laneCount = Math.max(laneCount, inputSwimlanes.length, outputSwimlanes.length);
    activeLanes = cloneLanes(outputSwimlanes);

    const kind: HistoryGraphKind = result.currentRef?.revision === commit.hash ? 'head' : 'node';

    return {
      commit: commitWithSortedRefs,
      kind,
      inputSwimlanes,
      outputSwimlanes,
      currentSwimlaneIndex,
      currentLaneStarted,
      currentNode,
    };
  });

  return { viewModels, laneCount };
}
