import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import {
  answerClaudeHookDecision,
  onClaudeHookDecision,
  onClaudeHookDecisionExpired,
  onClaudeHookDecisionResolved,
  type ClaudeHookDecisionEvent,
} from '../services/tauri';
import './ClaudeDecisionDialog.css';

type Selections = Record<string, string[]>;

export function ClaudeDecisionDialog() {
  const [queue, setQueue] = useState<ClaudeHookDecisionEvent[]>([]);
  const [selections, setSelections] = useState<Selections>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const decision = queue[0];

  useEffect(() => {
    let unlistenDecision: (() => void) | undefined;
    let unlistenExpired: (() => void) | undefined;
    let unlistenResolved: (() => void) | undefined;
    void Promise.all([
      onClaudeHookDecision(payload => {
        setQueue(previous => previous.some(item => item.decisionId === payload.decisionId)
          ? previous
          : [...previous, payload]);
      }),
      onClaudeHookDecisionExpired(decisionId => {
        setQueue(previous => previous.filter(item => item.decisionId !== decisionId));
      }),
      onClaudeHookDecisionResolved(decisionId => {
        setQueue(previous => previous.filter(item => item.decisionId !== decisionId));
      }),
    ]).then(([decisionCleanup, expiredCleanup, resolvedCleanup]) => {
      unlistenDecision = decisionCleanup;
      unlistenExpired = expiredCleanup;
      unlistenResolved = resolvedCleanup;
    });
    return () => {
      unlistenDecision?.();
      unlistenExpired?.();
      unlistenResolved?.();
    };
  }, []);

  useEffect(() => {
    if (!decision) {
      setSelections({});
      setCustomAnswers({});
      return;
    }
    setSelections(Object.fromEntries(
      decision.questions.map(question => [
        question.question,
        question.multiSelect ? [] : [question.options[0]?.label].filter(Boolean),
      ]),
    ));
    setError('');
    setCustomAnswers({});
  }, [decision?.decisionId]);

  const complete = useMemo(() => decision?.questions.every(question => (
    (selections[question.question]?.length ?? 0) > 0
    || Boolean(customAnswers[question.question]?.trim())
  )) ?? false, [customAnswers, decision, selections]);

  if (!decision) return null;

  const toggle = (questionText: string, label: string, multiSelect: boolean) => {
    setSelections(previous => {
      const current = previous[questionText] ?? [];
      return {
        ...previous,
        [questionText]: multiSelect
          ? (current.includes(label) ? current.filter(item => item !== label) : [...current, label])
          : [label],
      };
    });
    setError('');
  };

  const submit = async () => {
    if (!complete) return;
    setSubmitting(true);
    setError('');
    try {
      const answers = Object.fromEntries(
        decision.questions.map(question => {
          const custom = customAnswers[question.question]?.trim();
          const selected = selections[question.question] ?? [];
          const values = question.multiSelect && custom ? [...selected, custom] : selected;
          return [question.question, custom && !question.multiSelect ? custom : values.join(', ')];
        }),
      );
      await answerClaudeHookDecision(decision.decisionId, answers);
      setQueue(previous => previous.filter(item => item.decisionId !== decision.decisionId));
    } catch (submitError) {
      setError(String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="claude-decision-overlay">
      <div className="claude-decision-dialog" role="dialog" aria-modal="true" aria-labelledby="claude-decision-title">
        <div className="claude-decision-header">
          <div>
            <h2 id="claude-decision-title">Claude Code 等待回答</h2>
            <span>{queue.length > 1 ? `还有 ${queue.length - 1} 个待处理决策` : '请选择后提交'}</span>
          </div>
        </div>
        <div className="claude-decision-content">
          {decision.questions.map(question => (
            <fieldset key={question.question} className="claude-decision-question">
              <legend>{question.header || '选择'}</legend>
              <p>{question.question}</p>
              <div className="claude-decision-options">
                {question.options.map(option => {
                  const checked = selections[question.question]?.includes(option.label) ?? false;
                  return (
                    <label className={`claude-decision-option${checked ? ' selected' : ''}`} key={option.label}>
                      <input
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={question.question}
                        checked={checked}
                        onChange={() => toggle(question.question, option.label, question.multiSelect)}
                      />
                      <span className="claude-decision-check"><Check size={14} /></span>
                      <span>
                        <strong>{option.label}</strong>
                        {option.description && <small>{option.description}</small>}
                      </span>
                    </label>
                  );
                })}
                <input
                  className="claude-decision-custom"
                  value={customAnswers[question.question] ?? ''}
                  onChange={event => {
                    setCustomAnswers(previous => ({ ...previous, [question.question]: event.target.value }));
                    setError('');
                  }}
                  placeholder="其他回答"
                />
              </div>
            </fieldset>
          ))}
          {error && <div className="claude-decision-error" role="alert">{error}</div>}
        </div>
        <div className="claude-decision-footer">
          <button className="btn-primary" disabled={!complete || submitting} onClick={() => void submit()}>
            <Check size={16} />{submitting ? '正在提交...' : '提交回答'}
          </button>
        </div>
      </div>
    </div>
  );
}
