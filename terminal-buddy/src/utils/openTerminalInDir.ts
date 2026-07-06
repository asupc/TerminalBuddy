import { useAppStore } from '../stores/appStore';
import { startBlankTerminal } from '../services/tauri';

/**
 * 打开一个 PowerShell 终端标签到指定目录，行为等同文件导航右键的“在当前目录打开命令窗口”。
 * dir 缺省或为空时使用后端默认目录，且不设置会话目录。
 */
export async function openTerminalInDir(dir?: string): Promise<void> {
  const store = useAppStore.getState();
  if (store.splitMode !== 'off' && !store.splitSlots.some(s => s.sessionId === null)) {
    store.showToast('分屏模式已满，请先关闭某个分屏或退出分屏', 'info');
    return;
  }
  const content = document.querySelector('.terminal-content');
  let estRows = 0, estCols = 0;
  if (content) {
    estCols = Math.max(2, Math.floor((content.clientWidth - 20) / 8.4));
    estRows = Math.max(1, Math.floor((content.clientHeight - 20) / 17));
  }
  const terminalId = await startBlankTerminal('powershell', estRows, estCols, dir);
  useAppStore.getState().addSession({
    id: terminalId,
    profileId: '',
    profileName: 'PowerShell',
    terminalType: 'powershell',
    colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
    tabColor: null,
    groupId: 'default',
  });
  const st = useAppStore.getState();
  if (st.splitMode !== 'off') st.placeSessionInSplitSlot(terminalId);
  if (dir) st.setSessionDirectory(terminalId, dir);
}
