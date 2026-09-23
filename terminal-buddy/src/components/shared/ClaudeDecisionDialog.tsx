import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Bot, Check, Terminal } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import {
  answerClaudeHookDecision,
  continueClaudeHookInTerminal,
  getPendingClaudeHookDecisions,
  onClaudeHookDecision,
  onClaudeHookDecisionExpired,
  onClaudeHookDecisionResolved,
  type ClaudeHookDecisionEvent,
} from '../../services/tauri';
import { Dialog } from './Dialog';
import './ClaudeDecisionDialog.css';

type Selections = Record<string, string[]>;
type FocusTarget = 'tab' | 'option';

function nextWrappedIndex(current: number, direction: -1 | 1, count: number): number {
  return (current + direction + count) % count;
}

export function ClaudeDecisionDialog() {
  const [queue, setQueue] = useState<ClaudeHookDecisionEvent[]>([]);
  const [selections, setSelections] = useState<Selections>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [activeOptionIndexes, setActiveOptionIndexes] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState('');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
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
      setActiveQuestionIndex(0);
      setActiveOptionIndexes([]);
      return;
    }
    setSelections(Object.fromEntries(
      decision.questions.map(question => [question.question, []]),
    ));
    setCustomAnswers({});
    setActiveQuestionIndex(0);
    setActiveOptionIndexes(decision.questions.map(() => 0));
    setError('');
    setSubmitting(false);
    setReturning(false);
  }, [decision?.decisionId]);

  const complete = useMemo(() => {
    if (!decision || decision.questions.length === 0) return false;
    return decision.questions.every(question => (
      (selections[question.question]?.length ?? 0) > 0
      || Boolean(customAnswers[question.question]?.trim())
    ));
  }, [customAnswers, decision, selections]);

  if (!decision) return null;

  const questionCount = decision.questions.length;
  const currentQuestionIndex = Math.min(activeQuestionIndex, Math.max(questionCount - 1, 0));
  const currentQuestion = decision.questions[currentQuestionIndex];
  const hasQuestionTabs = questionCount > 1;

  const isQuestionAnswered = (questionIndex: number) => {
    const question = decision.questions[questionIndex];
    return Boolean(question) && (
      (selections[question.question]?.length ?? 0) > 0
      || Boolean(customAnswers[question.question]?.trim())
    );
  };

  const focusQuestion = (questionIndex: number, target: FocusTarget) => {
    requestAnimationFrame(() => {
      if (target === 'tab') {
        tabRefs.current[questionIndex]?.focus();
        return;
      }
      const optionIndex = activeOptionIndexes[questionIndex] ?? 0;
      optionRefs.current[optionIndex]?.focus();
      if (!optionRefs.current[optionIndex]) {
        document.getElementById(`claude-decision-custom-${questionIndex}`)?.focus();
      }
    });
  };

  const activateQuestion = (questionIndex: number, focusTarget?: FocusTarget) => {
    setActiveQuestionIndex(questionIndex);
    setError('');
    if (focusTarget) focusQuestion(questionIndex, focusTarget);
  };

  const moveQuestion = (direction: -1 | 1, focusTarget: FocusTarget) => {
    if (questionCount < 2) return;
    const nextIndex = nextWrappedIndex(currentQuestionIndex, direction, questionCount);
    activateQuestion(nextIndex, focusTarget);
  };

  const toggle = (questionIndex: number, label: string) => {
    const question = decision.questions[questionIndex];
    if (!question) return;
    setSelections(previous => {
      const current = previous[question.question] ?? [];
      return {
        ...previous,
        [question.question]: question.multiSelect
          ? (current.includes(label) ? current.filter(item => item !== label) : [...current, label])
          : [label],
      };
    });
    if (!question.multiSelect) {
      setCustomAnswers(previous => ({ ...previous, [question.question]: '' }));
    }
    setError('');
  };

  const selectSingleAndAdvance = (questionIndex: number, label: string) => {
    toggle(questionIndex, label);
    if (questionIndex + 1 < questionCount) {
      activateQuestion(questionIndex + 1, 'option');
    }
  };

  const moveOptionFocus = (questionIndex: number, optionIndex: number) => {
    const optionCount = decision.questions[questionIndex]?.options.length ?? 0;
    if (optionCount === 0) return;
    const nextIndex = Math.min(Math.max(optionIndex, 0), optionCount - 1);
    setActiveOptionIndexes(previous => {
      const next = [...previous];
      next[questionIndex] = nextIndex;
      return next;
    });
    optionRefs.current[nextIndex]?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      moveQuestion(event.key === 'ArrowLeft' ? -1 : 1, 'tab');
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      activateQuestion(event.key === 'Home' ? 0 : questionCount - 1, 'tab');
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusQuestion(currentQuestionIndex, 'option');
    }
  };

  const handleOptionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    questionIndex: number,
    optionIndex: number,
    label: string,
  ) => {
    const question = decision.questions[questionIndex];
    if (!question) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      moveQuestion(event.key === 'ArrowLeft' ? -1 : 1, 'option');
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      const nextIndex = nextWrappedIndex(optionIndex, direction, question.options.length);
      moveOptionFocus(questionIndex, nextIndex);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      moveOptionFocus(questionIndex, event.key === 'Home' ? 0 : question.options.length - 1);
    } else if (event.key === ' ' && question.multiSelect) {
      event.preventDefault();
      toggle(questionIndex, label);
    } else if (event.key === 'Enter' && !question.multiSelect && !event.repeat) {
      event.preventDefault();
      selectSingleAndAdvance(questionIndex, label);
    }
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
          <span className="claude-decision-agent"><Bot size={15} aria-hidden="true" /></span>
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
      className="claude-decision-dialog"
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
            <Terminal size={14} aria-hidden="true" />
            {returning ? '正在返回...' : '回到终端'}
          </button>
          <button
            type="button"
            className="claude-decision-submit"
            disabled={!complete || busy}
            onClick={() => void submit()}
          >
            <Check size={14} aria-hidden="true" />
            {submitting ? '正在提交...' : '提交'}
          </button>
        </>
      )}
    >
      {hasQuestionTabs && (
        <div className="claude-decision-tabs" role="tablist" aria-label="决策分类">
          {decision.questions.map((question, questionIndex) => {
            const answered = isQuestionAnswered(questionIndex);
            const active = questionIndex === currentQuestionIndex;
            return (
              <button
                key={`${question.header}-${questionIndex}`}
                ref={element => { tabRefs.current[questionIndex] = element; }}
                id={`claude-decision-tab-${questionIndex}`}
                type="button"
                role="tab"
                className={`claude-decision-tab${active ? ' active' : ''}${answered ? ' answered' : ''}`}
                aria-selected={active}
                aria-controls={`claude-decision-panel-${questionIndex}`}
                aria-label={`${question.header || `问题 ${questionIndex + 1}`}${answered ? '，已回答' : '，未回答'}`}
                tabIndex={active ? 0 : -1}
                onClick={() => activateQuestion(questionIndex)}
                onKeyDown={handleTabKeyDown}
              >
                <span className="claude-decision-tab-index">{questionIndex + 1}</span>
                <span className="claude-decision-tab-label">{question.header || `问题 ${questionIndex + 1}`}</span>
                {answered && <Check className="claude-decision-tab-check" size={13} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}

      {currentQuestion ? (
        <section
          id={`claude-decision-panel-${currentQuestionIndex}`}
          className="claude-decision-question"
          role={hasQuestionTabs ? 'tabpanel' : undefined}
          aria-labelledby={hasQuestionTabs ? `claude-decision-tab-${currentQuestionIndex}` : undefined}
          aria-label={!hasQuestionTabs ? (currentQuestion.header || '决策问题') : undefined}
        >
          <div className="claude-decision-question-heading">
            {!hasQuestionTabs && (
              <span className="claude-decision-question-category">
                {currentQuestion.header || '决策问题'}
              </span>
            )}
            <h3>{currentQuestion.question}</h3>
          </div>

          <div
            className="claude-decision-options"
            role={currentQuestion.multiSelect ? 'group' : 'radiogroup'}
            aria-label={currentQuestion.question}
          >
            {currentQuestion.options.map((option, optionIndex) => {
              const checked = selections[currentQuestion.question]?.includes(option.label) ?? false;
              const activeOptionIndex = activeOptionIndexes[currentQuestionIndex] ?? 0;
              return (
                <button
                  key={`${option.label}-${optionIndex}`}
                  ref={element => { optionRefs.current[optionIndex] = element; }}
                  type="button"
                  role={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                  className={`claude-decision-option${checked ? ' selected' : ''}${currentQuestion.multiSelect ? ' multiple' : ' single'}`}
                  aria-checked={checked}
                  tabIndex={optionIndex === activeOptionIndex ? 0 : -1}
                  autoFocus={currentQuestionIndex === 0 && optionIndex === 0}
                  onFocus={() => moveOptionFocus(currentQuestionIndex, optionIndex)}
                  onClick={() => toggle(currentQuestionIndex, option.label)}
                  onKeyDown={event => handleOptionKeyDown(event, currentQuestionIndex, optionIndex, option.label)}
                >
                  <span className="claude-decision-check" aria-hidden="true"><Check size={12} /></span>
                  <span className="claude-decision-option-text">
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              );
            })}
          </div>

          <label className="claude-decision-custom-row" htmlFor={`claude-decision-custom-${currentQuestionIndex}`}>
            <span>其他回答</span>
            <input
              id={`claude-decision-custom-${currentQuestionIndex}`}
              className="claude-decision-custom"
              value={customAnswers[currentQuestion.question] ?? ''}
              autoFocus={currentQuestionIndex === 0 && currentQuestion.options.length === 0}
              onChange={event => {
                const value = event.target.value;
                setCustomAnswers(previous => ({ ...previous, [currentQuestion.question]: value }));
                if (!currentQuestion.multiSelect && value) {
                  setSelections(previous => ({ ...previous, [currentQuestion.question]: [] }));
                }
                setError('');
              }}
              onKeyDown={event => {
                if (event.key === 'Enter'
                  && !currentQuestion.multiSelect
                  && event.currentTarget.value.trim()
                  && currentQuestionIndex + 1 < questionCount) {
                  event.preventDefault();
                  activateQuestion(currentQuestionIndex + 1, 'option');
                }
              }}
              placeholder="输入自定义回答"
            />
          </label>
        </section>
      ) : (
        <div className="claude-decision-empty">当前决策没有可处理的问题</div>
      )}

      {error && <div className="claude-decision-error" role="alert">{error}</div>}
    </Dialog>
  );
}
