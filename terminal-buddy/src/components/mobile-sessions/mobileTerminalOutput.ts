import type { MobileAiMessage, MobileAiSession } from '../../services/mobileAi';

/** 消息正文只当文本显示，终端控制序列由渲染层统一生成。 */
function terminalText(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\n/g, '\r\n');
}

export function mobileTerminalOutput(session: MobileAiSession | null, messages: MobileAiMessage[]): string {
  if (!session) return '';
  const provider = session.provider === 'codex' ? 'Codex' : 'Claude';
  const context = [session.model, session.projectPath].filter(Boolean).join(' · ');
  const blocks = [`\x1b[1m${provider}\x1b[0m  移动端\r\n${terminalText(context)}`];
  for (const message of messages) {
    const prefix = message.role === 'user' ? '\x1b[1m❯\x1b[0m '
      : message.role === 'tool' ? '\x1b[90m●\x1b[0m ' : '● ';
    blocks.push(prefix + terminalText(message.text));
  }
  for (const input of session.pendingInputs ?? []) blocks.push(`排队中 · ${terminalText(input.text)}`);
  if (session.error) blocks.push(`\x1b[31m执行提示：\x1b[0m${terminalText(session.error)}`);
  // 末尾不追加换行，模型分段输出时可直接追加到同一条消息。
  return blocks.join('\r\n\r\n');
}
