import { useState } from 'react';
import { Check, ShieldQuestion, Wrench } from 'lucide-react';
import type { AiApproval, AnswerAiApproval } from '../../services/tauri';

interface Question {
  id: string;
  question: string;
  header?: string;
  options?: { label?: string; description?: string }[] | string[];
  multiSelect?: boolean;
}

function questionOptions(question: Question): { label: string; description?: string }[] {
  return (question.options ?? []).map(option => (
    typeof option === 'string' ? { label: option } : { label: option.label ?? '', description: option.description }
  )).filter(option => option.label);
}

/** 原生会话的审批卡：决策问题按题目收集答案，工具授权直接允许 / 拒绝。 */
export function ApprovalCard({ approval, onAnswer }: {
  approval: AiApproval;
  onAnswer: (answer: AnswerAiApproval) => void;
}) {
  const details = (approval.details ?? {}) as Record<string, unknown>;
  const questions = Array.isArray(details.questions) ? details.questions as Question[] : [];
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  const submit = (answer: AnswerAiApproval) => {
    if (busy) return;
    setBusy(true);
    onAnswer(answer);
  };

  if (questions.length === 0) {
    const toolName = typeof details.toolName === 'string' ? details.toolName : '';
    const command = typeof details.command === 'string' ? details.command : '';
    return (
      <div className="agent-approval-card">
        <div className="agent-approval-title">
          <Wrench aria-hidden="true" />
          <span>需要授权：{toolName || '工具调用'}</span>
        </div>
        {command && <pre className="agent-approval-command">{command}</pre>}
        <div className="agent-approval-actions">
          <button className="agent-btn primary" disabled={busy}
            onClick={() => submit({ approvalId: approval.id, decision: 'accept' })}>允许</button>
          <button className="agent-btn" disabled={busy}
            onClick={() => submit({ approvalId: approval.id, decision: 'decline' })}>拒绝</button>
        </div>
      </div>
    );
  }

  const toggle = (question: Question, label: string) => {
    setAnswers(previous => {
      const current = previous[question.id] ?? [];
      const next = question.multiSelect
        ? (current.includes(label) ? current.filter(value => value !== label) : [...current, label])
        : [label];
      return { ...previous, [question.id]: next };
    });
  };

  const allAnswered = questions.every(question => (answers[question.id]?.length ?? 0) > 0);

  return (
    <div className="agent-approval-card">
      <div className="agent-approval-title">
        <ShieldQuestion aria-hidden="true" />
        <span>需要你的决定</span>
      </div>
      {questions.map(question => (
        <div key={question.id} className="agent-approval-question">
          {question.header && <div className="agent-approval-header">{question.header}</div>}
          <div className="agent-approval-text">{question.question}</div>
          <div className="agent-approval-options">
            {questionOptions(question).map(option => {
              const selected = (answers[question.id] ?? []).includes(option.label);
              return (
                <button key={option.label} type="button"
                  className={`agent-approval-option${selected ? ' selected' : ''}`}
                  onClick={() => toggle(question, option.label)}>
                  <span className="agent-approval-radio" data-multi={question.multiSelect === true}>
                    {selected ? <Check aria-hidden="true" /> : null}
                  </span>
                  <span>
                    <span className="agent-approval-option-label">{option.label}</span>
                    {option.description && <span className="agent-approval-option-desc">{option.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="agent-approval-actions">
        <button className="agent-btn primary" disabled={!allAnswered || busy}
          onClick={() => submit({
            approvalId: approval.id,
            decision: 'accept',
            // 后端按题目 ID 读取 `answers[id].answers`（数组）。
            answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])),
          })}>提交</button>
        <button className="agent-btn" disabled={busy}
          onClick={() => submit({ approvalId: approval.id, decision: 'decline' })}>跳过</button>
      </div>
    </div>
  );
}
