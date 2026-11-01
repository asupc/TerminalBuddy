// 终端 Agent 会话接力 · 协议归并 reducer（纯模块，无 TS / DOM / Tauri 依赖）。
//
// 设计依据 docs/specs/2026-11-01--terminal-agent-chat-relay.md §4.4 / §4.5 / §4.10：
// - mirror / rotated / unavailable：清空重建（generation +1），是唯一允许整体替换的帧；
// - append：仅同 revision 可拼接，按 seq 去重防重复，跨 revision 一律忽略（等 mirror/rotated）；
// - status：只更新会话元数据（阶段 / 决策 / 回复闸门），不动消息基线；
// - error：记录 lastError，保留已归并消息（只读兜底）；
// - revision 只比较相等，不比较大小（服务端重启后从 1 重新计数）；
// - 归并器是纯函数：无变化时返回原 state 引用，React 可用引用相等跳过重渲染。
//
// 本文件被 scripts/test-terminal-agent-protocol.mjs 直接 import（node 原生 ESM），
// 也被 src/services/terminalAgent.ts 引用（类型见同目录 terminalAgentProtocol.d.mts）。

/**
 * @typedef {'mirror' | 'append' | 'status' | 'rotated' | 'unavailable' | 'error'} AgentFrameType
 */

/**
 * @typedef {object} AgentReplayTool
 * @property {string} name
 * @property {string | null} [summary]
 */

/**
 * @typedef {object} AgentReplayMessage
 * @property {number} seq
 * @property {string} role  user | assistant | tool | system
 * @property {number | null} [timestamp]
 * @property {string} text
 * @property {AgentReplayTool[]} tools
 * @property {string | null} [toolName]
 */

/**
 * @typedef {object} AgentMirrorStatus
 * @property {boolean} available
 * @property {string | null} [reason]
 */

/**
 * @typedef {object} AgentSessionMeta
 * @property {string} terminalId
 * @property {string} profileName
 * @property {string} terminalType
 * @property {string | null} [directory]
 * @property {string} provider  claude | codex | pi
 * @property {string} sessionId
 * @property {string | null} [title]
 * @property {string | null} [model]
 * @property {string} phase  attention | running | idle | completed | failed | ended | unknown
 * @property {number | null} [phaseAt]
 * @property {number | null} [lastActivityAt]
 * @property {string | null} [pendingDecisionId]
 * @property {number} pendingDecisionCount
 * @property {boolean} canReply
 * @property {string | null} [replyBlockedReason]
 * @property {number} revision
 * @property {AgentMirrorStatus} mirror
 */

/** 快照页 / 内容帧共用的尾页字段。 */
/**
 * @typedef {object} AgentSnapshotCore
 * @property {AgentReplayMessage[]} [messages]
 * @property {number} [revision]
 * @property {number} [cursor]  本页最后一条 seq；无消息为 -1（不是条数）
 * @property {number} [total]   截断前的完整解析消息数
 * @property {boolean} [truncated]
 * @property {boolean} [hasMore]
 * @property {number} [nextCursor]
 * @property {number | null} [oldestRetainedSeq]
 */

/**
 * 推送帧（terminal-agent-update 事件与 subscribe.initialFrame 同构）。
 * @typedef {AgentSnapshotCore} AgentFrame
 * @property {AgentFrameType} type
 * @property {string} terminalId
 * @property {AgentSessionMeta} [session]
 * @property {string | null} [reason]   unavailable 专属
 * @property {string | null} [code]     error 专属
 * @property {string | null} [message]  error 专属
 * @property {string[]} [subscriptionIds] 事件通道附带：本帧发往的仍有效租约
 */

/**
 * REST / Tauri 命令 terminal_agent_messages 的响应。
 * @typedef {AgentSnapshotCore} AgentPage
 * @property {AgentSessionMeta} session
 * @property {AgentReplayMessage[]} messages
 * @property {number} cursor
 * @property {number} total
 * @property {boolean} truncated
 * @property {boolean} hasMore
 * @property {number} nextCursor
 * @property {boolean} resetRequired  true 时客户端必须清空并整体采用本页
 */

/**
 * 归并器维护的客户端状态。
 * @typedef {object} AgentSyncState
 * @property {string | null} terminalId   归并目标；跨 terminalId 的帧 / 页一律忽略
 * @property {AgentSessionMeta | null} session
 * @property {number | null} revision     当前消息基线的镜像代次（只在重建时变化）
 * @property {boolean} mirrorAvailable
 * @property {string | null} unavailableReason
 * @property {AgentReplayMessage[]} messages  按 seq 升序
 * @property {number} cursor               已归并到的最后 seq；无消息为 -1
 * @property {number} total
 * @property {boolean} truncated
 * @property {number | null} oldestRetainedSeq
 * @property {number} generation  本地重建计数：mirror/rotated/unavailable/reset +1，
 *                                迟到的异步回调据此丢弃旧结果
 * @property {{ code: string, message: string } | null} lastError
 */

/**
 * @typedef {object} ApplyOptions
 * @property {string} [expectedTerminalId]  期望归属终端；缺省用 state.terminalId
 */

/**
 * @typedef {ApplyOptions} ApplyPageOptions
 * @property {'snapshot' | 'incremental'} [mode]
 *   snapshot（默认）＝不带 afterSeq 的首屏快照页，整体采用；
 *   incremental＝带 afterSeq 的同 revision 补偿页，按 seq 追加归并。
 */

/** 创建空状态。 */
export function createSyncState() {
	return {
		terminalId: null,
		session: null,
		revision: null,
		mirrorAvailable: true,
		unavailableReason: null,
		messages: [],
		cursor: -1,
		total: 0,
		truncated: false,
		oldestRetainedSeq: null,
		generation: 0,
		lastError: null,
	};
}

/**
 * 按 seq 去重合并；无新增时返回原数组引用。
 * @param {AgentReplayMessage[]} existing
 * @param {AgentReplayMessage[] | undefined} incoming
 * @returns {AgentReplayMessage[]}
 */
function mergeMessages(existing, incoming) {
	if (!incoming || incoming.length === 0) return existing;
	const seen = new Set(existing.map((message) => message.seq));
	const additions = incoming.filter((message) => !seen.has(message.seq));
	if (additions.length === 0) return existing;
	return [...existing, ...additions].sort((a, b) => a.seq - b.seq);
}

/**
 * 用完整快照（mirror / rotated / reset 页 / snapshot 页）清空重建。
 * 镜像可用态读 session.mirror.available 而非硬置 true：REST 快照页在转录不可用 /
 * 过大时携带 available=false 的 session + 空尾页，必须保留提示态而不是误报可用。
 * @param {AgentSyncState} state
 * @param {string} terminalId
 * @param {AgentSessionMeta} session
 * @param {AgentSnapshotCore} payload
 * @returns {AgentSyncState}
 */
function rebuildFromSnapshot(state, terminalId, session, payload) {
	const messages = Array.isArray(payload.messages)
		? payload.messages.slice().sort((a, b) => a.seq - b.seq)
		: [];
	const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : -1;
	const cursor = Math.max(
		typeof payload.cursor === 'number' ? payload.cursor : -1,
		lastSeq,
	);
	const mirrorAvailable = session.mirror ? session.mirror.available !== false : true;
	const unavailableReason = mirrorAvailable ? null : (session.mirror && session.mirror.reason) || null;
	return {
		...state,
		terminalId,
		session,
		revision: typeof payload.revision === 'number' ? payload.revision : session.revision,
		mirrorAvailable,
		unavailableReason,
		messages,
		cursor,
		total: typeof payload.total === 'number' ? payload.total : messages.length,
		truncated: Boolean(payload.truncated),
		oldestRetainedSeq: payload.oldestRetainedSeq ?? null,
		generation: state.generation + 1,
		lastError: null,
	};
}

/**
 * 归并一帧推送（或 subscribe 返回的 initialFrame）。
 * 无变化（忽略 / 重复 / 跨终端）时返回原 state 引用。
 * @param {AgentSyncState} state
 * @param {AgentFrame} frame
 * @param {ApplyOptions} [options]
 * @returns {AgentSyncState}
 */
export function applyFrame(state, frame, options = {}) {
	if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return state;
	const expected = options.expectedTerminalId ?? state.terminalId;
	if (expected && frame.terminalId !== expected) return state;

	switch (frame.type) {
		case 'mirror':
		case 'rotated': {
			// 与 mirror 相同的完整尾页：清空后整体采用（rotated 只是告知原因）。
			if (!frame.session) return state;
			return rebuildFromSnapshot(state, frame.terminalId, frame.session, frame);
		}
		case 'append': {
			// 仅同 revision 可拼接；不同 revision 的 append 是迟到 / 乱序帧，等待 mirror/rotated。
			if (state.revision === null || frame.revision !== state.revision) return state;
			// unavailable 之后残留的同 revision 迟到 append 不拼进空基线，等 mirror 重建。
			if (!state.mirrorAvailable) return state;
			const messages = mergeMessages(state.messages, frame.messages);
			const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : -1;
			const cursor = Math.max(
				state.cursor,
				typeof frame.cursor === 'number' ? frame.cursor : -1,
				lastSeq,
			);
			const total = typeof frame.total === 'number' ? frame.total : state.total;
			const truncated = frame.truncated === undefined ? state.truncated : Boolean(frame.truncated);
			const oldestRetainedSeq = frame.oldestRetainedSeq !== undefined ? frame.oldestRetainedSeq : state.oldestRetainedSeq;
			if (
				messages === state.messages
				&& cursor === state.cursor
				&& total === state.total
				&& truncated === state.truncated
				&& oldestRetainedSeq === state.oldestRetainedSeq
			) {
				return state;
			}
			return { ...state, messages, cursor, total, truncated, oldestRetainedSeq, lastError: null };
		}
		case 'status': {
			// 阶段 / 决策 / 回复闸门变化：只覆盖元数据，消息基线不动。
			if (!frame.session) return state;
			if (state.session === frame.session) return state;
			return { ...state, session: frame.session };
		}
		case 'unavailable': {
			// 镜像降级：清空旧消息并进入提示态；恢复时会再来 mirror（revision+1）。
			const session = frame.session ?? state.session;
			return {
				...state,
				terminalId: frame.terminalId,
				session,
				mirrorAvailable: false,
				unavailableReason: frame.reason ?? session?.mirror?.reason ?? null,
				messages: [],
				cursor: -1,
				total: 0,
				truncated: false,
				oldestRetainedSeq: null,
				revision: typeof frame.revision === 'number' ? frame.revision : state.revision,
				generation: state.generation + 1,
				lastError: null,
			};
		}
		case 'error': {
			// 终端关闭 / 失权 / 内部错误：保留已归并消息作只读兜底，记录错误。
			const lastError = {
				code: typeof frame.code === 'string' ? frame.code : 'internal',
				message: typeof frame.message === 'string' ? frame.message : '未知错误',
			};
			if (state.lastError && state.lastError.code === lastError.code && state.lastError.message === lastError.message) {
				return state;
			}
			return { ...state, lastError };
		}
		default:
			return state;
	}
}

/**
 * 归并一页 terminal_agent_messages 响应。
 * - resetRequired、revision 不同、snapshot 模式或本地无基线 → 清空重建；
 * - incremental 且同 revision → 按 seq 追加（补偿页可多次调用直到 hasMore=false）。
 * @param {AgentSyncState} state
 * @param {AgentPage} page
 * @param {ApplyPageOptions} [options]
 * @returns {AgentSyncState}
 */
export function applyPage(state, page, options = {}) {
	if (!page || typeof page !== 'object' || !page.session) return state;
	const expected = options.expectedTerminalId ?? state.terminalId;
	if (expected && page.session.terminalId !== expected) return state;
	const mode = options.mode === 'incremental' ? 'incremental' : 'snapshot';
	const mustRebuild = page.resetRequired
		|| mode === 'snapshot'
		|| state.revision === null
		|| !state.mirrorAvailable
		|| page.session.revision !== state.revision;
	if (mustRebuild) {
		return rebuildFromSnapshot(state, page.session.terminalId, page.session, page);
	}
	const messages = mergeMessages(state.messages, page.messages);
	const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : -1;
	const cursor = Math.max(
		state.cursor,
		typeof page.cursor === 'number' ? page.cursor : -1,
		lastSeq,
	);
	const total = typeof page.total === 'number' ? page.total : state.total;
	const truncated = page.truncated === undefined ? state.truncated : Boolean(page.truncated);
	const oldestRetainedSeq = page.oldestRetainedSeq !== undefined ? page.oldestRetainedSeq : state.oldestRetainedSeq;
	if (
		messages === state.messages
		&& cursor === state.cursor
		&& total === state.total
		&& truncated === state.truncated
		&& oldestRetainedSeq === state.oldestRetainedSeq
	) {
		return state;
	}
	return { ...state, session: page.session, messages, cursor, total, truncated, oldestRetainedSeq, lastError: null };
}
