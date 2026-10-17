/** 仅替换变化的后缀，保留终端中输入框之前已有的内容。光标始终位于同步文本末尾。 */
export function diffTerminalInput(previous: string, next: string): { erase: number; text: string } {
  const before = Array.from(previous);
  const after = Array.from(next);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  return { erase: before.length - prefix, text: after.slice(prefix).join('') };
}

/** 文本和提交键分开发送，让 Codex 等 TUI 明确区分粘贴内容与 Enter。 */
export function terminalPaste(text: string, bracketedPaste: boolean): string {
  const normalized = text.replace(/\r?\n/g, '\r').replace(/\x1b/g, '\u241b');
  return bracketedPaste
    ? '\x1b[200~' + normalized + '\x1b[201~'
    : normalized;
}
