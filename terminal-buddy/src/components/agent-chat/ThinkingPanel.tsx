import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, ChevronDown, ChevronUp } from 'lucide-react';
import type { AiThinking } from '../../services/tauri';

/**
 * 思考面板：贴在消息列表底部「AI 正在思考中」那一行里。
 *
 * 背景：长回合里模型可能连续思考几十分钟才输出第一句正文（实测一个会话第一轮
 * 有 164 段思考、42 万字，前 28 分钟一条正文都没有）。过去这段过程完全不外显，
 * 用户只看到一个「已等待 N 秒」的呼吸灯，观感上还不如终端。
 *
 * 设计取向是「少打扰但可核对」：
 * - 折叠态只占一行，滚动显示思考的最新一句（取最后一句完整的），不抢正文的注意力；
 * - 点开才看尾部全文（服务端只保留尾部若干字符，够回看刚才在想什么，不做长文档）；
 * - 括号里的段数与累计字数说明模型确实在推进，而不是卡住。
 *
 * 不做逐字打字机效果：思考 delta 是 token 级的，动画只会让这一行持续抖动。
 */

/** 折叠态展示的字符上限：一行放不下就截断，避免撑高「思考中」气泡。 */
const PEEK_LIMIT = 120;

/** 展开状态记住：面板会随「无思考」阶段卸载，展开与否跨挂载保留。 */
let thinkingOpen = false;

/** 从思考正文里取「最新一句」：优先最后一个完整句子，其次最后一个非空行。 */
export function thinkingPeek(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return '';
  // 思考里常见 markdown 小标题与列表符号，展示时去掉行首记号，读起来更像一句话。
  const clean = (value: string) => value.replace(/^[#>*\-\s]+/, '').replace(/\s+/g, ' ').trim();
  const lines = trimmed.split('\n').map(clean).filter(Boolean);
  if (lines.length > 0) {
    const last = lines[lines.length - 1];
    // 最后一行太短（比如只有「1.」）时回退到上一行，避免闪出一个残句。
    if (last.length >= 4 || lines.length === 1) return last;
    return lines[lines.length - 2] ?? last;
  }
  return clean(trimmed);
}

/** 秒 → 「刚刚 / 12 秒前」，让用户看出这段思考是不是还在推进。 */
function ageText(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 3) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

/** 只在活动状态计时：思考结束后不再每秒重渲染（同 ElapsedBadge 的约束）。 */
const Freshness = memo(function Freshness({ updatedAt, active }: { updatedAt: number; active: boolean }) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!active) return null;
  return <span className="agent-thinking-age"> · {ageText(updatedAt, clock)}</span>;
});

interface Props {
  thinking: AiThinking;
  /** 本回合是否仍在执行：回合结束后思考行随「思考中」气泡一起消失。 */
  running: boolean;
}

export const ThinkingPanel = memo(function ThinkingPanel({ thinking, running }: Props) {
  // 展开状态用模块级变量记住：新段思考开始时组件不会卸载，但用户切走标签页、
  // 或在「无思考」的纯工具阶段面板返回 null 后重新挂载时，本地 state 会丢。
  const [open, setOpenState] = useState(() => thinkingOpen);
  const setOpen = (next: boolean) => {
    thinkingOpen = next;
    setOpenState(next);
  };
  const bodyRef = useRef<HTMLPreElement>(null);
  const peek = useMemo(() => thinkingPeek(thinking.text), [thinking.text]);

  // 展开时贴底：思考是持续追加的，新内容出现在末尾。
  useEffect(() => {
    if (!open || !thinking.active) return;
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [open, thinking.active, thinking.text]);

  if (!peek) return null;

  const truncated = peek.length > PEEK_LIMIT;
  const shown = truncated ? `${peek.slice(0, PEEK_LIMIT)}…` : peek;
  const label = thinking.blocks > 1 ? `第 ${thinking.blocks} 段思考` : '思考';
  const counter = thinking.totalChars > 0
    ? ` · ${thinking.totalChars >= 10000
      ? `${Math.round(thinking.totalChars / 1000)} 千字`
      : `${thinking.totalChars} 字`}`
    : '';

  return (
    <div className={`agent-thinking-panel${open ? ' open' : ''}${thinking.active ? ' active' : ''}`}>
      <button
        type="button"
        className="agent-thinking-peek"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={open ? '收起思考内容' : '展开查看这段思考的完整内容'}
      >
        <Brain aria-hidden="true" />
        <span className="agent-thinking-label">{label}{counter}</span>
        <span className="agent-thinking-text">{shown}</span>
        {open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
      </button>
      {open && (
        <>
          <pre className="agent-thinking-body" ref={bodyRef}>{thinking.text}</pre>
          <div className="agent-thinking-foot">
            <span>
              {thinking.active ? '仍在思考' : running ? '思考已结束，等待下一步' : '本回合已结束'}
              <Freshness updatedAt={thinking.updatedAt} active={thinking.active} />
            </span>
            {thinking.totalChars > thinking.text.length && (
              <span className="agent-thinking-hint">只保留最近 {thinking.text.length} 字的思考内容</span>
            )}
          </div>
        </>
      )}
    </div>
  );
});
