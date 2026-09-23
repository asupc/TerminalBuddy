import type { GitCommit, GitHistoryRef, GitHistoryResult } from '../../services/tauri';

export const SWIMLANE_HEIGHT = 22;
export const SWIMLANE_WIDTH = 11;
export const SWIMLANE_CURVE_RADIUS = 5;
export const CIRCLE_RADIUS = 4;
export const CIRCLE_STROKE_WIDTH = 2;

export const INCOMING_HISTORY_ITEM_ID = '__terminal_buddy_incoming_changes__';
export const OUTGOING_HISTORY_ITEM_ID = '__terminal_buddy_outgoing_changes__';

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

function cloneLanes(lanes: HistoryGraphNode[]): HistoryGraphNode[] {
  return lanes.map((lane) => ({ ...lane }));
}

function findLastIndex(nodes: HistoryGraphNode[], id: string): number {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (nodes[i].id === id) return i;
  }
  return -1;
}

function findLastViewModelIndex(viewModels: HistoryGraphViewModel[], predicate: (viewModel: HistoryGraphViewModel) => boolean): number {
  for (let i = viewModels.length - 1; i >= 0; i -= 1) {
    if (predicate(viewModels[i])) return i;
  }
  return -1;
}

function createRefsByRevision(result: GitHistoryResult): Map<string, GitHistoryRef[]> {
  const refsByRevision = new Map<string, GitHistoryRef[]>();
  for (const ref of result.refs) addRef(refsByRevision, ref);
  for (const commit of result.commits) {
    for (const ref of commit.refs) addRef(refsByRevision, ref);
  }
  return refsByRevision;
}

function sortedRefsForHash(refsByRevision: Map<string, GitHistoryRef[]>, hash: string): GitHistoryRef[] {
  return sortHistoryRefs(refsByRevision.get(hash) ?? []);
}

function labelColorForHash(refsByRevision: Map<string, GitHistoryRef[]>, hash: string): string | undefined {
  const preferred = sortedRefsForHash(refsByRevision, hash)[0];
  return preferred ? historyRefColor(preferred) : undefined;
}

function labelColorForCommit(refsByRevision: Map<string, GitHistoryRef[]>, commit: GitCommit): string | undefined {
  if (commit.hash === INCOMING_HISTORY_ITEM_ID) return HISTORY_COLORS.remote;
  if (commit.hash === OUTGOING_HISTORY_ITEM_ID) return HISTORY_COLORS.local;
  return labelColorForHash(refsByRevision, commit.hash);
}

function createFallbackColorResolver() {
  let colorIndex = -1;
  const fallbackColors = new Map<string, string>();

  return (id: string): string => {
    const cached = fallbackColors.get(id);
    if (cached) return cached;

    colorIndex = (colorIndex + 1) % HISTORY_COLORS.foregrounds.length;
    const next = HISTORY_COLORS.foregrounds[colorIndex];
    fallbackColors.set(id, next);
    return next;
  };
}

function decorateCommitRefs(commit: GitCommit, refsByRevision: Map<string, GitHistoryRef[]>): GitCommit {
  return {
    ...commit,
    refs: sortedRefsForHash(refsByRevision, commit.hash),
  };
}

function createVirtualCommit(hash: string, subject: string, author: string | undefined, parent: string): GitCommit {
  return {
    hash,
    shortHash: '',
    parents: [parent],
    refs: [],
    author: author ?? '',
    date: '',
    subject,
  };
}

function addIncomingOutgoingChangesHistoryItems(
  viewModels: HistoryGraphViewModel[],
  result: GitHistoryResult,
): void {
  const currentRef = result.currentRef;
  const upstreamRef = result.upstreamRef;
  const mergeBase = result.mergeBase;

  if (!currentRef || !upstreamRef || !mergeBase || currentRef.revision === upstreamRef.revision) {
    return;
  }

  if (result.behind > 0 && upstreamRef.revision !== mergeBase) {
    const beforeHistoryItemIndex = findLastViewModelIndex(
      viewModels,
      (viewModel) => viewModel.outputSwimlanes.some((node) => node.id === mergeBase && node.color === HISTORY_COLORS.remote),
    );
    const afterHistoryItemIndex = viewModels.findIndex((viewModel) => viewModel.commit.hash === mergeBase);

    if (beforeHistoryItemIndex !== -1 && afterHistoryItemIndex !== -1) {
      const incomingChangeMerged = viewModels[beforeHistoryItemIndex].commit.parents.length === 2
        && viewModels[beforeHistoryItemIndex].commit.parents.includes(mergeBase);

      if (!incomingChangeMerged) {
        viewModels[beforeHistoryItemIndex] = {
          ...viewModels[beforeHistoryItemIndex],
          inputSwimlanes: viewModels[beforeHistoryItemIndex].inputSwimlanes.map((node) => (
            node.id === mergeBase && node.color === HISTORY_COLORS.remote
              ? { ...node, id: INCOMING_HISTORY_ITEM_ID }
              : node
          )),
          outputSwimlanes: viewModels[beforeHistoryItemIndex].outputSwimlanes.map((node) => (
            node.id === mergeBase && node.color === HISTORY_COLORS.remote
              ? { ...node, id: INCOMING_HISTORY_ITEM_ID }
              : node
          )),
        };

        const incomingChangesCommit = createVirtualCommit(
          INCOMING_HISTORY_ITEM_ID,
          'Incoming Changes',
          upstreamRef.name,
          mergeBase,
        );

        viewModels.splice(afterHistoryItemIndex, 0, {
          commit: incomingChangesCommit,
          kind: 'incoming-changes',
          inputSwimlanes: cloneLanes(viewModels[beforeHistoryItemIndex].outputSwimlanes),
          outputSwimlanes: cloneLanes(viewModels[afterHistoryItemIndex].inputSwimlanes),
        });
      }
    }
  }

  if (result.ahead > 0 && currentRef.revision !== mergeBase) {
    const currentHistoryItemRefIndex = viewModels.findIndex(
      (viewModel) => viewModel.kind === 'head' && viewModel.commit.hash === currentRef.revision,
    );

    if (currentHistoryItemRefIndex !== -1) {
      const outgoingChangesCommit = createVirtualCommit(
        OUTGOING_HISTORY_ITEM_ID,
        'Outgoing Changes',
        currentRef.name,
        currentRef.revision,
      );
      const inputSwimlanes = cloneLanes(viewModels[currentHistoryItemRefIndex].inputSwimlanes);
      const outputSwimlanes = cloneLanes(inputSwimlanes).concat({
        id: currentRef.revision,
        color: HISTORY_COLORS.local,
      });

      viewModels.splice(currentHistoryItemRefIndex, 0, {
        commit: outgoingChangesCommit,
        kind: 'outgoing-changes',
        inputSwimlanes,
        outputSwimlanes,
      });

      viewModels[currentHistoryItemRefIndex + 1].inputSwimlanes.push({
        id: currentRef.revision,
        color: HISTORY_COLORS.local,
      });
    }
  }
}

export function getHistoryItemIndex(viewModel: HistoryGraphViewModel): number {
  const inputIndex = viewModel.inputSwimlanes.findIndex((node) => node.id === viewModel.commit.hash);
  return inputIndex !== -1 ? inputIndex : viewModel.inputSwimlanes.length;
}

export function buildHistoryGraph(result: GitHistoryResult | null): HistoryGraphResult {
  if (!result) {
    return { viewModels: [], laneCount: 0 };
  }

  const refsByRevision = createRefsByRevision(result);
  const commitsByHash = new Map(result.commits.map((commit) => [commit.hash, commit]));
  const fallbackColorForId = createFallbackColorResolver();
  const viewModels: HistoryGraphViewModel[] = [];
  let laneCount = 1;

  for (const commit of result.commits) {
    const decoratedCommit = decorateCommitRefs(commit, refsByRevision);
    const previousViewModel = viewModels.length > 0 ? viewModels[viewModels.length - 1] : undefined;
    const inputSwimlanes = cloneLanes(previousViewModel?.outputSwimlanes ?? []);
    const outputSwimlanes: HistoryGraphNode[] = [];
    const parents = decoratedCommit.parents.filter(Boolean);
    let firstParentAdded = false;

    if (parents.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === decoratedCommit.hash) {
          if (!firstParentAdded) {
            outputSwimlanes.push({
              id: parents[0],
              color: labelColorForCommit(refsByRevision, decoratedCommit) ?? node.color,
            });
            firstParentAdded = true;
          }
          continue;
        }

        outputSwimlanes.push({ ...node });
      }
    }

    for (let i = firstParentAdded ? 1 : 0; i < parents.length; i += 1) {
      let color: string | undefined;

      if (i === 0) {
        color = labelColorForCommit(refsByRevision, decoratedCommit);
      } else {
        const parentCommit = commitsByHash.get(parents[i]);
        color = parentCommit ? labelColorForCommit(refsByRevision, parentCommit) : labelColorForHash(refsByRevision, parents[i]);
      }

      outputSwimlanes.push({
        id: parents[i],
        color: color ?? fallbackColorForId(parents[i]),
      });
    }

    const kind: HistoryGraphKind = result.currentRef?.revision === decoratedCommit.hash ? 'head' : 'node';
    viewModels.push({
      commit: decoratedCommit,
      kind,
      inputSwimlanes,
      outputSwimlanes,
    });
    laneCount = Math.max(
      laneCount,
      inputSwimlanes.length,
      outputSwimlanes.length,
      getHistoryItemIndex(viewModels[viewModels.length - 1]) + 1,
    );
  }

  addIncomingOutgoingChangesHistoryItems(viewModels, result);
  laneCount = viewModels.reduce(
    (max, viewModel) => Math.max(max, viewModel.inputSwimlanes.length, viewModel.outputSwimlanes.length, getHistoryItemIndex(viewModel) + 1),
    laneCount,
  );

  return { viewModels, laneCount };
}

export function getLastOutputSwimlaneIndex(viewModel: HistoryGraphViewModel, id: string): number {
  return findLastIndex(viewModel.outputSwimlanes, id);
}
