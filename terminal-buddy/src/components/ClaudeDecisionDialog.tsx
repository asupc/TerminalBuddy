import { useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Bot, Check, Terminal } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import {
  answerClaudeHookDecision,
  continueClaudeHookInTerminal,
  getPendingClaudeHookDecisions,
  onClaudeHookDecision,
  onClaudeHookDecisionExpired,
  onClaudeHookDecisionResolved,
  type ClaudeHookDecisionEvent,
} from '../services/tauri';
import { Dialog } from './Dialog';
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
    let cancelled = false;
    let cleanups: Array<() => void> = [];
    const settledDecisionIds = new Set<string>();
    const addDecision = (payload: ClaudeHookDecisionEvent) => {
      if (settledDecisionIds.has(payload.decisionId)) return;
      setQueue(previous => previous.some(item => item.decisionId === payload.decisionId)
        ? previous
        : [...previous, payload]);
    };
    void Promise.allSettled([
      onClaudeHookDecision(payload => {
        if (!cancelled) addDecision(payload);
      }),
      onClaudeHookDecisionExpired(payload => {
        if (cancelled) return;
        settledDecisionIds.add(payload.decisionId);
        setQueue(previous => previous.filter(item => item.decisionId !== payload.decisionId));
      }),
      onClaudeHookDecisionResolved(payload => {
        if (cancelled) return;
        settledDecisionIds.add(payload.decisionId);
        setQueue(previous => previous.filter(item => item.decisionId !== payload.decisionId));
      }),
    ]).then(results => {
      const listeners: Array<() => void> = [];
      let registrationFailed = false;
      let registrationError: unknown;
      for (const result of results) {
        if (result.status === 'fulfilled') listeners.push(result.value);
        else {
          registrationFailed = true;
          if (registrationError === undefined) registrationError = result.reason;
        }
      }
      if (cancelled || registrationFailed) {
        listeners.forEach(cleanup => cleanup());
        if (!cancelled && registrationFailed) {
          console.error('初始化 Claude 决策监听失败:', registrationError ?? '未知错误');
        }
        return;
      }
      cleanups = listeners;
      void getPendingClaudeHookDecisions()
        .then(pending => {
          if (!cancelled) pending.forEach(addDecision);
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      cleanups.forEach(cleanup => cleanup());
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
    <Dialog
      title={(
        <>
          <span className="claude-decision-agent"><Bot size={15} /></span>
          <div className="claude-decision-heading">
            <div className="claude-decision-title-row">
              <span className="claude-decision-title-text">Claude 等待决策</span>
              {queue.length > 1 && <span className="claude-decision-count">{queue.length}</span>}
            </div>
            <span className="claude-decision-terminal">{terminalName}</span>
          </div>
        </>
      )}
      ariaLabel="Claude 等待决策"
      modal={false}
      autoFocus={false}
      className="claude-decision-dialog"
      overlayClassName="claude-decision-region"
      positionerClassName="claude-decision-positioner"
      headerClassName="claude-decision-header"
      titleClassName="claude-decision-header-content"
      closeButtonClassName="claude-decision-icon-button"
      bodyClassName="claude-decision-content"
      footerClassName="claude-decision-footer"
      closeLabel="关闭并在终端内决策"
      closeDisabled={busy}
      onClose={() => void continueInTerminal(false)}
      footer={(
        <>
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
        </>
      )}
    >
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
    </Dialog>
  );
}
