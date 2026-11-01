// 终端 Agent 会话接力 · React 协议归并用例（§9.1）。
// 直接 node 运行：node scripts/test-terminal-agent-protocol.mjs，退出码 0 通过 / 1 失败。
// 不引入测试框架；被测对象是 src/services/terminalAgentProtocol.mjs（纯 ESM，无 TS/DOM 依赖）。
import assert from 'node:assert/strict';
import {
  applyFrame,
  applyPage,
  createSyncState,
} from '../src/services/terminalAgentProtocol.mjs';

const TERMINAL = 'term-abc_1';
const OTHER_TERMINAL = 'term-other-2';

let passed = 0;
let failed = 0;

function test(name, run) {
  try {
    run();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${error && error.stack ? error.stack : error}`);
  }
}

function message(seq, role, text) {
  return { seq, role, text, tools: [], toolName: null, timestamp: 1762000000000 + seq * 1000 };
}

function session(overrides = {}) {
  return {
    terminalId: TERMINAL,
    profileName: '项目 A',
    terminalType: 'powershell',
    directory: '/workspace/a',
    provider: 'claude',
    sessionId: '3f2c0000',
    title: '修复登录超时',
    model: 'claude-opus-4-5',
    phase: 'running',
    phaseAt: 1762000000000,
    lastActivityAt: 1761999990000,
    pendingDecisionId: null,
    pendingDecisionCount: 0,
    canReply: true,
    replyBlockedReason: null,
    revision: 7,
    mirror: { available: true, reason: null },
    ...overrides,
  };
}

function snapshotFrame(type, messages, extra = {}) {
  return {
    type,
    terminalId: TERMINAL,
    session: session(),
    messages,
    revision: 7,
    cursor: messages.length ? messages[messages.length - 1].seq : -1,
    total: messages.length,
    truncated: false,
    hasMore: false,
    nextCursor: messages.length ? messages[messages.length - 1].seq : -1,
    oldestRetainedSeq: messages.length ? messages[0].seq : null,
    subscriptionIds: ['sub-1'],
    ...extra,
  };
}

console.log('terminal-agent protocol reducer');

test('初始状态：无基线、无消息、generation 0', () => {
  const state = createSyncState();
  assert.equal(state.terminalId, null);
  assert.equal(state.revision, null);
  assert.equal(state.messages.length, 0);
  assert.equal(state.cursor, -1);
  assert.equal(state.generation, 0);
  assert.equal(state.mirrorAvailable, true);
  assert.equal(state.lastError, null);
});

test('mirror 首帧：清空重建，按 seq 升序，cursor 是最后一条 seq', () => {
  const state = applyFrame(createSyncState(), snapshotFrame('mirror', [
    message(3, 'user', '继续'),
    message(0, 'user', '开始'),
    message(5, 'assistant', '好的'),
    // Claude seq 允许空洞：1/2/4 缺失不算异常
  ]));
  assert.equal(state.terminalId, TERMINAL);
  assert.equal(state.revision, 7);
  assert.deepEqual(state.messages.map((item) => item.seq), [0, 3, 5]);
  assert.equal(state.cursor, 5, 'cursor 是最后一条 seq，不是条数');
  assert.equal(state.total, 3);
  assert.equal(state.generation, 1);
  assert.equal(state.mirrorAvailable, true);
});

test('mirror 空快照：cursor=-1、oldestRetainedSeq=null', () => {
  const state = applyFrame(createSyncState(), snapshotFrame('mirror', [], { oldestRetainedSeq: null }));
  assert.equal(state.messages.length, 0);
  assert.equal(state.cursor, -1);
  assert.equal(state.total, 0);
});

test('append 同 revision：尾部新增拼接', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', 'hi'), message(1, 'assistant', 'ok')]));
  state = applyFrame(state, {
    type: 'append',
    terminalId: TERMINAL,
    revision: 7,
    messages: [message(2, 'user', '继续'), message(4, 'assistant', '收到')],
    cursor: 4,
    total: 4,
    truncated: false,
    hasMore: false,
    nextCursor: 4,
  });
  assert.deepEqual(state.messages.map((item) => item.seq), [0, 1, 2, 4]);
  assert.equal(state.cursor, 4);
  assert.equal(state.total, 4);
  assert.equal(state.generation, 1, '纯追加不提升 generation');
});

test('append 重复帧：按 seq 去重，无变化返回原引用', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', 'hi')]));
  const appendFrame = {
    type: 'append',
    terminalId: TERMINAL,
    revision: 7,
    messages: [message(1, 'assistant', 'ok')],
    cursor: 1,
    total: 2,
    truncated: false,
    hasMore: false,
    nextCursor: 1,
  };
  state = applyFrame(state, appendFrame);
  assert.equal(state.messages.length, 2);
  const again = applyFrame(state, appendFrame);
  assert.equal(again, state, '重复帧返回原 state 引用');
  // 帧内混入已见 seq（重叠窗口）也不重复
  const overlapping = applyFrame(state, { ...appendFrame, messages: [message(0, 'user', 'hi'), message(2, 'user', 'next')] });
  assert.deepEqual(overlapping.messages.map((item) => item.seq), [0, 1, 2]);
});

test('append revision 跨代：不同 revision 一律忽略，绝不拼接', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', 'hi')], { revision: 7 }));
  const stale = applyFrame(state, {
    type: 'append',
    terminalId: TERMINAL,
    revision: 8,
    messages: [message(1, 'assistant', '新代次消息')],
    cursor: 1,
    total: 2,
    truncated: false,
    hasMore: false,
    nextCursor: 1,
  });
  assert.equal(stale, state, '跨 revision append 被忽略');
  // 无 revision 的 append（非法帧）同样忽略
  const malformed = applyFrame(state, { type: 'append', terminalId: TERMINAL, messages: [message(1, 'assistant', 'x')] });
  assert.equal(malformed, state);
});

test('rotated：与 mirror 同构的完整尾页，清空重建并提升 generation', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [
    message(0, 'user', '旧代'),
    message(1, 'assistant', '旧回复'),
  ], { revision: 7 }));
  assert.equal(state.generation, 1);
  // Codex 去重重排：旧消息消失、seq 重排，revision +1
  state = applyFrame(state, snapshotFrame('rotated', [
    message(0, 'user', '新代'),
    message(1, 'assistant', '新回复'),
  ], { revision: 8, total: 2 }));
  assert.equal(state.revision, 8);
  assert.deepEqual(state.messages.map((item) => item.text), ['新代', '新回复']);
  assert.equal(state.generation, 2);
  assert.equal(state.cursor, 1);
});

test('status：只更新元数据，消息与 revision 基线不动', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', 'hi')], { revision: 7 }));
  const statusFrame = {
    type: 'status',
    terminalId: TERMINAL,
    session: session({
      phase: 'attention',
      pendingDecisionId: 'dec-1',
      pendingDecisionCount: 2,
      canReply: false,
      replyBlockedReason: '有待确认问题',
      revision: 7,
    }),
  };
  state = applyFrame(state, statusFrame);
  assert.equal(state.session.phase, 'attention');
  assert.equal(state.session.pendingDecisionCount, 2);
  assert.equal(state.session.canReply, false);
  assert.equal(state.messages.length, 1, 'status 不清消息');
  assert.equal(state.revision, 7, 'status 不改基线 revision');
  assert.equal(state.generation, 1, 'status 不提升 generation');
  // 缺 session 的 status 帧忽略
  assert.equal(applyFrame(state, { type: 'status', terminalId: TERMINAL }), state);
});

test('unavailable：清空消息、记录 reason、提升 generation', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', 'hi')]));
  state = applyFrame(state, {
    type: 'unavailable',
    terminalId: TERMINAL,
    session: session({ mirror: { available: false, reason: 'transcript_too_large' } }),
    messages: [],
    reason: 'transcript_too_large',
  });
  assert.equal(state.mirrorAvailable, false);
  assert.equal(state.unavailableReason, 'transcript_too_large');
  assert.equal(state.messages.length, 0);
  assert.equal(state.cursor, -1);
  assert.equal(state.generation, 2);
  // 恢复：mirror 快照（revision+1）整体替换回可用态
  state = applyFrame(state, snapshotFrame('mirror', [message(0, 'user', '恢复后')], { revision: 8 }));
  assert.equal(state.mirrorAvailable, true);
  assert.equal(state.unavailableReason, null);
  assert.equal(state.messages.length, 1);
  assert.equal(state.revision, 8);
});

test('unavailable 后残留的同 revision 迟到 append 不拼进空基线', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', 'hi')], { revision: 7 }));
  state = applyFrame(state, {
    type: 'unavailable',
    terminalId: TERMINAL,
    session: session({ mirror: { available: false, reason: 'transcript_unreadable' } }),
    messages: [],
    reason: 'transcript_unreadable',
  });
  assert.equal(state.mirrorAvailable, false);
  // 降级期间 watcher 仍在 tick：同 revision 的 append 帧必须被忽略
  const staleAppend = applyFrame(state, {
    type: 'append',
    terminalId: TERMINAL,
    revision: 7,
    messages: [message(1, 'assistant', '降级期间的追加')],
    cursor: 1,
    total: 2,
    truncated: false,
    hasMore: false,
    nextCursor: 1,
  });
  assert.equal(staleAppend, state, '不可用基线上不拼接 append');
  assert.equal(staleAppend.messages.length, 0);
  // incremental 补偿页同理：按快照重建（不 merge 进空基线）
  const incrementalPage = {
    session: session({ revision: 7, mirror: { available: false, reason: 'transcript_unreadable' } }),
    messages: [],
    cursor: -1,
    total: 0,
    truncated: false,
    hasMore: false,
    nextCursor: -1,
    resetRequired: false,
  };
  const afterPage = applyPage(state, incrementalPage, { mode: 'incremental' });
  assert.equal(afterPage.messages.length, 0);
  assert.equal(afterPage.mirrorAvailable, false, 'REST 页保留提示态');
});

test('快照重建读 session.mirror：REST 页携带不可用态时保留提示', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', '基线')]));
  assert.equal(state.mirrorAvailable, true);
  // 转录不可用时的 REST 快照页：session.mirror.available=false + 空尾页
  const unavailablePage = {
    session: session({ mirror: { available: false, reason: 'transcript_too_large' } }),
    messages: [],
    cursor: -1,
    total: 0,
    truncated: false,
    hasMore: false,
    nextCursor: -1,
    resetRequired: true,
  };
  state = applyPage(state, unavailablePage);
  assert.equal(state.mirrorAvailable, false, '不得硬置可用');
  assert.equal(state.unavailableReason, 'transcript_too_large');
  assert.equal(state.messages.length, 0);
  // 恢复页（available=true）回到正常态
  state = applyPage(state, {
    session: session({ revision: 9, mirror: { available: true, reason: null } }),
    messages: [message(0, 'user', '恢复')],
    cursor: 0,
    total: 1,
    truncated: false,
    hasMore: false,
    nextCursor: 0,
    resetRequired: false,
  });
  assert.equal(state.mirrorAvailable, true);
  assert.equal(state.unavailableReason, null);
  assert.equal(state.messages.length, 1);
});

test('error 帧：记录 code/message，保留已归并消息', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', 'hi')]));
  state = applyFrame(state, { type: 'error', terminalId: TERMINAL, code: 'terminal_closed', message: '终端已关闭' });
  assert.deepEqual(state.lastError, { code: 'terminal_closed', message: '终端已关闭' });
  assert.equal(state.messages.length, 1, '只读兜底：不清空消息');
  assert.equal(state.generation, 1);
  // 重复 error 帧返回原引用
  assert.equal(applyFrame(state, { type: 'error', terminalId: TERMINAL, code: 'terminal_closed', message: '终端已关闭' }), state);
});

test('跨 terminalId 帧 / 页：一律忽略（expectedTerminalId 与 state.terminalId 双保险）', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', 'hi')]));
  const otherMirror = snapshotFrame('mirror', [message(9, 'user', '别的终端')]);
  otherMirror.terminalId = OTHER_TERMINAL;
  otherMirror.session = session({ terminalId: OTHER_TERMINAL });
  assert.equal(applyFrame(state, otherMirror), state, '已锚定 terminalId 后忽略他端 mirror');
  const fresh = createSyncState();
  const filtered = applyFrame(fresh, otherMirror, { expectedTerminalId: TERMINAL });
  assert.equal(filtered, fresh, 'expectedTerminalId 不匹配时完全不采纳');
  const otherPage = {
    session: session({ terminalId: OTHER_TERMINAL }),
    messages: [message(1, 'user', 'x')],
    cursor: 1,
    total: 1,
    truncated: false,
    hasMore: false,
    nextCursor: 1,
    resetRequired: false,
  };
  assert.equal(applyPage(state, otherPage, { expectedTerminalId: TERMINAL }), state, '跨终端页忽略');
});

test('generation：只在重建时递增，异步回调可据此丢弃旧结果', () => {
  let state = createSyncState();
  assert.equal(state.generation, 0);
  state = applyFrame(state, snapshotFrame('mirror', [message(0, 'user', 'a')], { revision: 1 }));
  const gen1 = state.generation;
  state = applyFrame(state, { type: 'append', terminalId: TERMINAL, revision: 1, messages: [message(1, 'assistant', 'b')], cursor: 1, total: 2 });
  assert.equal(state.generation, gen1, 'append 不动 generation');
  state = applyFrame(state, { type: 'status', terminalId: TERMINAL, session: session({ phase: 'idle', revision: 1 }) });
  assert.equal(state.generation, gen1, 'status 不动 generation');
  state = applyFrame(state, snapshotFrame('rotated', [message(0, 'user', 'c')], { revision: 2 }));
  assert.equal(state.generation, gen1 + 1, 'rotated 提升 generation');
  // 模拟迟到回调：拿到 gen1 时代派生的 append（revision 已变）必须无效
  const staleAppend = applyFrame(state, { type: 'append', terminalId: TERMINAL, revision: 1, messages: [message(2, 'assistant', '迟到')], cursor: 2, total: 3 });
  assert.equal(staleAppend, state, '旧代次 append 在新基线上被忽略');
});

test('applyPage 快照页：整体采用（清空重建）', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', '旧首屏')]));
  const page = {
    session: session({ revision: 7 }),
    messages: [message(10, 'user', '快照页'), message(11, 'assistant', '回复')],
    cursor: 11,
    total: 2,
    truncated: false,
    hasMore: false,
    nextCursor: 11,
    resetRequired: false,
  };
  state = applyPage(state, page);
  assert.deepEqual(state.messages.map((item) => item.seq), [10, 11]);
  assert.equal(state.generation, 2, '快照页整体替换提升 generation');
});

test('applyPage resetRequired：强制清空重建，不能用空增量继续显示旧消息', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', '旧'), message(1, 'assistant', '消息')]));
  const resetPage = {
    session: session({ revision: 9 }),
    messages: [message(5, 'user', '重写后')],
    cursor: 5,
    total: 1,
    truncated: true,
    hasMore: false,
    nextCursor: 5,
    oldestRetainedSeq: 5,
    resetRequired: true,
  };
  state = applyPage(state, resetPage, { mode: 'incremental' });
  assert.deepEqual(state.messages.map((item) => item.seq), [5]);
  assert.equal(state.revision, 9);
  assert.equal(state.truncated, true);
  assert.equal(state.oldestRetainedSeq, 5);
});

test('applyPage incremental：同 revision 按 seq 追加、可多次追平', () => {
  let state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', '基线')]));
  const page1 = {
    session: session({ revision: 7 }),
    messages: [message(1, 'assistant', 'p1'), message(2, 'assistant', 'p2')],
    cursor: 2,
    total: 4,
    truncated: false,
    hasMore: true,
    nextCursor: 2,
    resetRequired: false,
  };
  state = applyPage(state, page1, { mode: 'incremental' });
  assert.deepEqual(state.messages.map((item) => item.seq), [0, 1, 2]);
  assert.equal(state.total, 4);
  const page2 = { ...page1, messages: [message(3, 'assistant', 'p3')], cursor: 3, hasMore: false, nextCursor: 3 };
  state = applyPage(state, page2, { mode: 'incremental' });
  assert.deepEqual(state.messages.map((item) => item.seq), [0, 1, 2, 3]);
  // revision 不同的增量页 → 按快照重建
  const rotatedPage = { ...page2, session: session({ revision: 8 }), messages: [message(0, 'user', '新代')] };
  state = applyPage(state, rotatedPage, { mode: 'incremental' });
  assert.deepEqual(state.messages.map((item) => item.text), ['新代']);
  assert.equal(state.revision, 8);
});

test('畸形输入：非对象帧 / 未知 type / 空 page 一律原样返回', () => {
  const state = applyFrame(createSyncState(), snapshotFrame('mirror', [message(0, 'user', 'hi')]));
  assert.equal(applyFrame(state, null), state);
  assert.equal(applyFrame(state, undefined), state);
  assert.equal(applyFrame(state, { type: 'future', terminalId: TERMINAL }), state);
  assert.equal(applyFrame(state, { terminalId: TERMINAL }), state, '缺 type 忽略');
  assert.equal(applyPage(state, null), state);
  assert.equal(applyPage(state, {}), state, '缺 session 的 page 忽略');
});

console.log('');
if (failed > 0) {
  console.error(`terminal-agent protocol: ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`terminal-agent protocol: ${passed} passed`);
