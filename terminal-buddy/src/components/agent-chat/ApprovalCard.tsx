import { useState, type KeyboardEvent } from 'react';
import { Check, ShieldQuestion, Wrench } from 'lucide-react';
import type { AiApproval, AnswerAiApproval } from '../../services/tauri';

interface Question {
  id: string;
  question: string;
  header?: string;
  options?: { label?: string; description?: string }[] | string[];
  multiSelect?: boolean;
}

type Option = { label: string; description?: string };

function questionOptions(question: Question): Option[] {
  return (question.options ?? []).map(option => (
    typeof option === 'string' ? { label: option } : { label: option.label ?? '', description: option.description }
  )).filter(option => option.label);
}

/** 某个问题最终提交的答案：单选时自定义输入优先，多选时与已选选项合并。 */
function answerValues(question: Question, selected: string[], custom: string): string[] {
  const trimmed = custom.trim();
  if (!question.multiSelect) return trimmed ? [trimmed] : selected;
  if (!trimmed || selected.includes(trimmed)) return selected;
  return [...selected, trimmed];
}

/** 原生会话的审批卡：决策问题按题目收集答案（选项或自定义输入），工具授权直接允许 / 拒绝。 */
export function ApprovalCard({ approval, onAnswer }: {
  approval: AiApproval;
  onAnswer: (answer: AnswerAiApproval) => void;
}) {
  const details = (approval.details ?? {}) as Record<string, unknown>;
  const questions = Array.isArray(details.questions) ? details.questions as Question[] : [];
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
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

  const selectionOf = (question: Question) => selected[question.id] ?? [];
  const customOf = (question: Question) => customAnswers[question.id] ?? '';
  const allAnswered = questions.every(question => (
    selectionOf(question).length > 0 || Boolean(customOf(question).trim())
  ));

  const toggle = (question: Question, label: string) => {
    setSelected(previous => {
      const current = previous[question.id] ?? [];
      const next = question.multiSelect
        ? (current.includes(label) ? current.filter(value => value !== label) : [...current, label])
        : [label];
      return { ...previous, [question.id]: next };
    });
    // 单选与自定义回答互斥：点选选项即放弃手动输入。
    if (!question.multiSelect && customOf(question)) {
      setCustomAnswers(previous => ({ ...previous, [question.id]: '' }));
    }
  };

  const updateCustom = (question: Question, value: string) => {
    setCustomAnswers(previous => ({ ...previous, [question.id]: value }));
    // 单选时输入自定义回答即清空已选选项；多选允许两者并存。
    if (!question.multiSelect && value.trim()) {
      setSelected(previous => ({ ...previous, [question.id]: [] }));
    }
  };

  const submitAnswers = () => {
    if (!allAnswered) return;
    submit({
      approvalId: approval.id,
      decision: 'accept',
      // 后端按题目 ID 读取 `answers[id].answers`（数组）。
      answers: Object.fromEntries(questions.map(question => [
        question.id,
        { answers: answerValues(question, selectionOf(question), customOf(question)) },
      ])),
    });
  };

  const handleCustomKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    if (allAnswered) {
      event.preventDefault();
      submitAnswers();
    }
  };

  return (
    <div className="agent-approval-card">
      <div className="agent-approval-title">
        <ShieldQuestion aria-hidden="true" />
        <span>需要你的决定</span>
        {questions.some(question => question.multiSelect) && (
          <span className="agent-approval-hint">多选题可勾选多项</span>
        )}
      </div>
      {questions.map((question, questionIndex) => {
        const options = questionOptions(question);
        const values = selectionOf(question);
        return (
          <div key={question.id} className="agent-approval-question">
            {question.header && <div className="agent-approval-header">{question.header}</div>}
            <div className="agent-approval-text">{question.question}</div>
            {options.length > 0 && (
              <div className="agent-approval-options">
                {options.map(option => {
                  const checked = values.includes(option.label);
                  return (
                    <button key={option.label} type="button"
                      className={`agent-approval-option${checked ? ' selected' : ''}`}
                      aria-pressed={checked}
                      onClick={() => toggle(question, option.label)}>
                      <span className="agent-approval-radio" data-multi={question.multiSelect === true}>
                        {checked ? <Check aria-hidden="true" /> : null}
                      </span>
                      <span>
                        <span className="agent-approval-option-label">{option.label}</span>
                        {option.description && <span className="agent-approval-option-desc">{option.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <label className="agent-approval-custom-row">
              <span>{options.length > 0 ? '其他回答' : '你的回答'}</span>
              <input
                className="agent-approval-custom"
                value={customOf(question)}
                autoFocus={questionIndex === 0 && options.length === 0}
                placeholder={question.multiSelect && options.length > 0
                  ? '输入补充回答，可与选项同时提交'
                  : '输入自定义回答'}
                onChange={event => updateCustom(question, event.target.value)}
                onKeyDown={handleCustomKeyDown}
              />
            </label>
          </div>
        );
      })}
      <div className="agent-approval-actions">
        <button className="agent-btn primary" disabled={!allAnswered || busy} onClick={submitAnswers}>提交</button>
        <button className="agent-btn" disabled={busy}
          onClick={() => submit({ approvalId: approval.id, decision: 'decline' })}>跳过</button>
      </div>
    </div>
  );
}
