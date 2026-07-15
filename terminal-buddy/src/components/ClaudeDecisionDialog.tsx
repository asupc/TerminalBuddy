import { useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Bot, Check, Terminal, X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import {
  answerClaudeHookDecision,
  continueClaudeHookInTerminal,
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
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState('');
  const sessions = useAppStore(state => state.sessions);
  const decision = queue[0];
  const terminalName = decision
    ? sessions.find(session => session.id === decision.terminalId)?.profileName || 'Claude Code'
    : '';

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
    setSubmitting(false);
    setReturning(false);
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

  const focusTerminal = async () => {
    const store = useAppStore.getState();
    if (!store.sessions.some(session => session.id === decision.terminalId)) return;
    if (store.splitMode !== 'off'
      && !store.splitSlots.some(slot => slot.sessionId === decision.terminalId)) {
      store.placeSessionInSplitSlot(decision.terminalId);
    } else {
      store.setActiveSession(decision.terminalId);
    }
    const appWindow = getCurrentWindow();
    await appWindow.unminimize().catch(() => {});
    await appWindow.show().catch(() => {});
    await appWindow.setFocus().catch(() => {});
  };

  const continueInTerminal = async (focus: boolean) => {
    setReturning(true);
    setError('');
    try {
      await continueClaudeHookInTerminal(decision.decisionId);
      setQueue(previous => previous.filter(item => item.decisionId !== decision.decisionId));
      if (focus) await focusTerminal();
    } catch (continueError) {
      setError(String(continueError));
      setReturning(false);
    }
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
      setSubmitting(false);
    }
  };

  const busy = submitting || returning;

  return (
    <div className="claude-decision-region" aria-live="polite">
      <section className="claude-decision-dialog" role="dialog" aria-modal="false" aria-labelledby="claude-decision-title">
        <header className="claude-decision-header">
          <span className="claude-decision-agent"><Bot size={15} /></span>
          <div className="claude-decision-heading">
            <div className="claude-decision-title-row">
              <h2 id="claude-decision-title">Claude 等待决策</h2>
              {queue.length > 1 && <span className="claude-decision-count">{queue.length}</span>}
            </div>
            <span className="claude-decision-terminal">{terminalName}</span>
          </div>
          <button
            type="button"
            className="claude-decision-icon-button"
            title="关闭并在终端内决策"
            aria-label="关闭并在终端内决策"
            disabled={busy}
            onClick={() => void continueInTerminal(false)}
          >
            <X size={16} />
          </button>
        </header>

        <div className="claude-decision-content">
          {decision.questions.map((question, questionIndex) => (
            <fieldset key={question.question} className="claude-decision-question">
              <legend>{question.header || `问题 ${questionIndex + 1}`}</legend>
              <p>{question.question}</p>
              <div className="claude-decision-options">
                {question.options.map(option => {
                  const checked = selections[question.question]?.includes(option.label) ?? false;
                  return (
                    <label className={`claude-decision-option${checked ? ' selected' : ''}`} key={option.label}>
                      <input
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={`${decision.decisionId}-${questionIndex}`}
                        checked={checked}
                        onChange={() => toggle(question.question, option.label, question.multiSelect)}
                      />
                      <span className="claude-decision-check"><Check size={12} /></span>
                      <span className="claude-decision-option-text">
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

        <footer className="claude-decision-footer">
          <button
            type="button"
            className="claude-decision-terminal-button"
            disabled={busy}
            onClick={() => void continueInTerminal(true)}
          >
            <Terminal size={14} />
            {returning ? '正在返回...' : '回到终端'}
          </button>
          <button
            type="button"
            className="claude-decision-submit"
            disabled={!complete || busy}
            onClick={() => void submit()}
          >
            <Check size={14} />
            {submitting ? '正在提交...' : '提交'}
          </button>
        </footer>
      </section>
    </div>
  );
}
