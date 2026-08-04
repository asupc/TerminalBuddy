import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { readAiAttemptOutput, onTerminalOutput } from "../../services/tauri";
import type { AiAttempt, AiTaskNode } from "../../types/aiDelivery";

interface Props {
  attempt: AiAttempt;
  /** 关联任务节点：用于展示任务标题/说明/任务提示等可读信息。 */
  task?: AiTaskNode;
  /** Agent 显示名（从 agents 列表解析后传入）。 */
  agentName?: string;
  onClose: () => void;
}

/** 运行中 attempt 的实时终端弹窗：事件流零延迟 + live-output.log 尾部历史。
 *  不要调用 drainTerminalOutput——drain 会清空缓冲、破坏 monitor 线程落盘。 */
export function AttemptLiveTerminalDialog({ attempt, task, agentName, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [finalMessage, setFinalMessage] = useState<string | null>(null);

  useEffect(() => {
    const term = new Terminal({ theme: { background: "#1e1e1e" } });
    terminalRef.current = term;
    term.open(containerRef.current!);

    // 1) 先注册事件监听，再读历史尾部 —— 无丢失窗口（历史与事件流间可能有毫秒级重复，接受不去重）
    let stopped = false;
    const unlistenPromise = onTerminalOutput(attempt.terminalId ?? "", (output) => {
      if (!stopped) term.write(output);
    });

    readAiAttemptOutput(attempt.id).then((output) => {
      if (!stopped) term.write(output.liveOutputTail);
    });

    // 2) attempt 结束后补拉一次，显示 final-message 收尾（4 秒轮询状态翻转或手动关闭）
    const poll = setInterval(() => {
      readAiAttemptOutput(attempt.id)
        .then((output) => {
          if (!output.isLive) {
            setFinalMessage(output.finalMessage ?? null);
            clearInterval(poll);
          }
        })
        .catch(() => undefined);
    }, 4000);

    return () => {
      stopped = true;
      clearInterval(poll);
      unlistenPromise.then((unlisten) => unlisten());
      term.dispose();
    };
  }, [attempt.id, attempt.terminalId]);

  const elapsed = attempt.startedAt
    ? Math.max(0, Math.round((Date.now() - new Date(attempt.startedAt).getTime()) / 1000))
    : 0;

  return (
    <div className="ai-attempt-live-dialog" role="dialog" aria-label="实时终端">
      <div className="ai-attempt-live-meta">
        <strong>{task?.title ?? "AI 交付任务"}</strong>
        {agentName && <span>Agent: {agentName}</span>}
        <span>状态: {attempt.state}</span>
        <span>已运行: {elapsed}s</span>
        {attempt.exitCode !== null && attempt.exitCode !== undefined && (
          <span>退出码: {attempt.exitCode}</span>
        )}
      </div>
      {task?.description && <p className="ai-attempt-live-desc">{task.description}</p>}
      {task?.taskPrompt && <p className="ai-attempt-live-desc">任务提示：{task.taskPrompt}</p>}
      <div ref={containerRef} className="ai-attempt-live-terminal" />
      {finalMessage && <div className="ai-attempt-live-final">{finalMessage}</div>}
      <button className="btn-secondary" onClick={onClose}>关闭</button>
    </div>
  );
}
