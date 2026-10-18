import {
  listClaudeHistory, rescanClaudeHistory, searchClaudeHistory, getClaudeReplay,
  renameClaudeSessionRecord, setClaudeSessionFlags, deleteClaudeSessionRecord, deleteClaudeSessionRecords, exportClaudeSession,
  listCodexHistory, rescanCodexHistory, searchCodexHistory, getCodexReplay,
  renameCodexSessionRecord, setCodexSessionFlags, deleteCodexSessionRecord, deleteCodexSessionRecords, exportCodexSession,
} from './tauri';
import { pickClaudeProfile, resumeClaudeSession } from '../components/claude-history/resumeClaudeSession';
import { pickCodexProfile, resumeCodexSession } from '../components/claude-history/resumeCodexSession';
import type { SessionHistoryProvider } from '../types';

const providers = {
  claude: {
    label: 'Claude Code', home: '~/.claude', indexedEvent: 'claude-history-indexed',
    list: listClaudeHistory, rescan: rescanClaudeHistory, search: searchClaudeHistory, replay: getClaudeReplay,
    rename: renameClaudeSessionRecord, setFlags: setClaudeSessionFlags, delete: deleteClaudeSessionRecord,
    deleteMany: deleteClaudeSessionRecords, export: exportClaudeSession, pickProfile: pickClaudeProfile, resume: resumeClaudeSession,
  },
  codex: {
    label: 'Codex', home: 'Codex', indexedEvent: 'codex-history-indexed',
    list: listCodexHistory, rescan: rescanCodexHistory, search: searchCodexHistory, replay: getCodexReplay,
    rename: renameCodexSessionRecord, setFlags: setCodexSessionFlags, delete: deleteCodexSessionRecord,
    deleteMany: deleteCodexSessionRecords, export: exportCodexSession, pickProfile: pickCodexProfile, resume: resumeCodexSession,
  },
};

export function sessionHistory(provider: SessionHistoryProvider) { return providers[provider]; }
