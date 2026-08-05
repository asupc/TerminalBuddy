import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Dialog } from '../shared/Dialog';
import type { AiAttemptOutput } from '../../types/aiDelivery';

interface AttemptOutputDialogProps {
  output: AiAttemptOutput;
  attemptLabel: string;
  onClose: () => void;
}

interface OutputTab {
  key: string;
  label: string;
  language: string;
  content: string;
}

function formatJsonMaybe(text: string): { language: string; content: string } {
  const trimmed = text.trim();
  if (!trimmed) return { language: 'plaintext', content: text };
  try {
    const parsed = JSON.parse(trimmed);
    return { language: 'json', content: JSON.stringify(parsed, null, 2) };
  } catch {
    return { language: 'plaintext', content: text };
  }
}

export function AttemptOutputDialog({ output, attemptLabel, onClose }: AttemptOutputDialogProps) {
  const [activeTab, setActiveTab] = useState('');

  const tabs = useMemo<OutputTab[]>(() => {
    const result: OutputTab[] = [];

    if (output.finalMessage) {
      const { language, content } = formatJsonMaybe(output.finalMessage);
      result.push({ key: 'finalMessage', label: '最终消息', language, content });
    }

    if (output.review) {
      result.push({
        key: 'review',
        label: output.review.approved ? '审查结论 通过' : '审查结论 驳回',
        language: 'json',
        content: JSON.stringify(output.review, null, 2),
      });
    }

    if (output.decision) {
      result.push({
        key: 'decision',
        label: '决策请求',
        language: 'json',
        content: JSON.stringify(output.decision, null, 2),
      });
    }

    if (output.planJson) {
      result.push({ key: 'planJson', label: '执行计划', language: 'json', content: output.planJson });
    }

    if (output.promptExcerpt) {
      result.push({ key: 'promptExcerpt', label: '任务提示词', language: 'markdown', content: output.promptExcerpt });
    }

    if (output.transcriptTail) {
      result.push({ key: 'transcriptTail', label: '终端日志', language: 'plaintext', content: output.transcriptTail });
    }

    // live-output.log 尾部：PTY 实时显示流（含命令回显/提示符，比 transcript 更全）。
    // 修复 agent 输出回流 PTY 后才有内容；执行完毕后在此回看执行过程。
    if (output.liveOutputTail) {
      result.push({ key: 'liveOutputTail', label: '实时输出', language: 'plaintext', content: output.liveOutputTail });
    }

    return result;
  }, [output]);

  useEffect(() => {
    if (tabs.length > 0 && !tabs.some(t => t.key === activeTab)) {
      setActiveTab(tabs[0].key);
    }
  }, [tabs, activeTab]);

  const activeTabData = tabs.find(t => t.key === activeTab);

  return (
    <Dialog
      title={'执行成果 — ' + attemptLabel}
      onClose={onClose}
      className="attempt-output-dialog"
      bodyClassName="attempt-output-dialog-body"
      style={{ width: 'min(900px, 92vw)', height: 'min(680px, 88vh)' }}
    >
      {tabs.length === 0 ? (
        <div className="attempt-output-empty">
          <p>{'本次执行没有产生可查看的成果文件。'}</p>
          <p className="attempt-output-empty-hint">
            {'可能原因：任务尚未完成、执行被中断，或 Agent 未输出结果。'}
          </p>
        </div>
      ) : (
        <>
          <div className="attempt-output-tabs">
            {tabs.map(tab => (
              <button
                key={tab.key}
                type="button"
                className={tab.key === activeTab ? 'attempt-output-tab active' : 'attempt-output-tab'}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="attempt-output-editor">
            {activeTabData && (
              <Editor
                value={activeTabData.content}
                language={activeTabData.language}
                theme="vs-dark"
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: 'on',
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  domReadOnly: true,
                  renderWhitespace: 'boundary',
                  tabSize: 2,
                }}
              />
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
