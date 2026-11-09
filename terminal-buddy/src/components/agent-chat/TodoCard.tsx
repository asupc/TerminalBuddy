import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { AiTodo } from '../../services/tauri';

/**
 * 底部任务清单卡（输入框上方，排队消息之上）。
 *
 * 折叠态一行给出「进度 + 当前动作 + 进度条」，展开后逐条列出；
 * 展开状态按会话记忆（localStorage），并在本回合首次出现 in_progress 时自动展开一次。
 * 规格见 docs/原生会话任务清单与子代理面板实施计划.md 第 6.1 节。
 */

/** 展开态按会话记忆：读取失败（隐私模式 / 存储被禁）一律按折叠处理。 */
const OPEN_KEY_PREFIX = 'agent-todo-open:';
function readOpen(sessionId: string): boolean | null {
  try {
    const raw = localStorage.getItem(OPEN_KEY_PREFIX + sessionId);
    return raw == null ? null : raw === '1';
  } catch {
    return null;
  }
}
function writeOpen(sessionId: string, open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY_PREFIX + sessionId, open ? '1' : '0');
  } catch {
    // 记忆失败不影响本次展开。
  }
}

/** 用时文案：全部完成时展示本清单从首次出现到收尾的耗时。 */
function durationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

const STATE_CLASS: Record<string, string> = {
  completed: 'done',
  in_progress: 'now',
  pending: 'pending',
};
function statusClass(status: string): string {
  return STATE_CLASS[status] ?? 'pending';
}

interface Props {
  todos: AiTodo[];
  sessionId: string;
  /** 回合是否仍在执行：全部完成时用来决定文案与是否淡化整卡。 */
  running: boolean;
}

export const TodoCard = memo(function TodoCard({ todos, sessionId, running }: Props) {
  const stored = useRef(readOpen(sessionId));
  const [open, setOpen] = useState(() => stored.current ?? false);
  // 用户手动展开/收起后不再自动展开（后续回合同样尊重用户选择）。
  const manual = useRef(stored.current != null);
  const autoOpened = useRef(false);
  // 清单首次出现的时刻：全部完成时用它算「用时」。
  const startedAt = useRef<number | null>(todos.length > 0 ? Date.now() : null);
  // 全部完成的那一刻：用时在完成时定格，回合结束后的 3 秒保持期间不再增长。
  const finishedAt = useRef<number | null>(null);

  const done = useMemo(() => todos.filter(todo => todo.status === 'completed').length, [todos]);
  const total = todos.length;
  const current = useMemo(() => todos.find(todo => todo.status === 'in_progress') ?? null, [todos]);
  const firstPending = useMemo(() => todos.find(todo => todo.status === 'pending') ?? null, [todos]);
  const allDone = total > 0 && done === total;

  // 会话切换：展开状态回到该会话记忆，自动展开与计时重新开始。
  useEffect(() => {
    const saved = readOpen(sessionId);
    stored.current = saved;
    manual.current = saved != null;
    autoOpened.current = false;
    finishedAt.current = null;
    setOpen(saved ?? false);
    startedAt.current = null;
  }, [sessionId]);

  // 清单从空变为非空：记录起始时刻；新一轮清空时连同完成时刻一起重置。
  useEffect(() => {
    if (total === 0) { startedAt.current = null; finishedAt.current = null; return; }
    if (startedAt.current == null) startedAt.current = Date.now();
  }, [total]);

  // 全部完成：定格完成时刻（只在刚完成时记一次）。
  useEffect(() => {
    if (allDone && finishedAt.current == null) finishedAt.current = Date.now();
    if (!allDone) finishedAt.current = null;
  }, [allDone]);

  // 本回合首次出现 in_progress：用户没手动干预过就自动展开一次。
  useEffect(() => {
    if (!current || manual.current || autoOpened.current) return;
    autoOpened.current = true;
    setOpen(true);
  }, [current]);

  // 全部完成且回合已 idle：保持展开 3 秒，再收起为单行并淡化。
  useEffect(() => {
    if (!allDone || running) return;
    const timer = window.setTimeout(() => setOpen(false), 3000);
    return () => window.clearTimeout(timer);
  }, [allDone, running]);

  const toggle = () => {
    setOpen(value => {
      const next = !value;
      manual.current = true;
      writeOpen(sessionId, next);
      return next;
    });
  };

  if (total === 0) return null;

  const finished = finishedAt.current;
  const elapsed = durationLabel((finished ?? Date.now()) - (startedAt.current ?? finished ?? Date.now()));
  const labelText = allDone
    ? `全部完成 · 用时 ${elapsed}`
    : current
      ? `正在 ${current.activeForm || current.content}`
      : firstPending
        ? `待开始：${firstPending.content}`
        : '准备中';
  const percent = Math.round((done / total) * 100);

  return (
    <div className={`agent-todo-card${allDone && !running ? ' done-all' : ''}`}>
      <button
        type="button"
        className="agent-todo-head"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`agent-todo-list-${sessionId}`}
        title={labelText}
      >
        <span className="agent-todo-ring">{allDone ? `✓ ${total}/${total}` : `${done}/${total}`}</span>
        <span className="agent-todo-now">
          {allDone || !current ? labelText : <>正在 <b>{current.activeForm || current.content}</b></>}
        </span>
        <span className="agent-todo-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
        <span className="agent-todo-chev" aria-hidden="true">›</span>
      </button>
      {open && (
        <ol className="agent-todo-list" id={`agent-todo-list-${sessionId}`}>
          {todos.map((todo, index) => {
            const state = statusClass(todo.status);
            return (
              <li
                key={`${index}-${todo.content}`}
                className={`agent-todo-item ${state}`}
                aria-current={state === 'now' ? 'step' : undefined}
                title={todo.content}
              >
                <span className="agent-todo-mark" aria-hidden="true">
                  {state === 'done' ? '✓' : state === 'now' ? '◐' : ''}
                </span>
                <span className="agent-todo-text">{todo.content}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
});
