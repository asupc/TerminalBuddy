import { aiSessionCreate, type AiSession } from '../services/tauri';
import { nativeAgentTabKey, useAppStore } from '../stores/appStore';
import { getAppSettings } from './settings';
import { openProjectAgentTerminal } from './openTerminalInDir';
import type { Project } from '../types';

/**
 * 项目模型菜单给出的是终端启动用的原始供应商 ID（如 `a9e2c4d2-…`），
 * 而原生会话目录的 ID 带来源前缀（`llm:` / `claude:` / `codex:` / `default:`）。
 * 直接透传原始 ID 会被后端 `ai_catalog_service::selection` 判为「供应商已不存在」，
 * 这里统一补齐前缀；已带前缀的值原样传递，便于将来菜单直接提供目录 ID。
 */
function catalogProviderId(provider: 'claude' | 'codex', providerId: string): string | null {
  if (!providerId) return null;
  if (/^(?:llm|claude|codex|default):/.test(providerId)) return providerId;
  return `${provider === 'codex' ? 'codex' : 'llm'}:${providerId}`;
}

/**
 * 以服务端快照打开聊天标签并激活。
 * `focusInput` 用于新建会话：标记必须在 openAgentTab 之前写入，
 * 否则页面可能先挂载、effect 消费时标记还不存在。
 */
function openAgentTabForSession(session: AiSession, focusInput = false): void {
  const key = nativeAgentTabKey(session.id);
  const store = useAppStore.getState();
  if (focusInput) store.requestAgentInputFocus(key);
  store.openAgentTab({
    key,
    shape: 'native',
    sessionId: session.id,
    title: session.title,
    provider: session.provider,
    projectPath: session.projectPath,
    model: session.model,
    status: session.status,
    openedAt: Date.now(),
  });
  store.setActiveAgentTab(key);
}

/**
 * 新建 Agent 会话的统一入口：按「新会话形态」设置分流。
 * - 原生会话：创建独立 CLI 会话并以聊天标签打开。
 * - 终端接力（默认）：沿用现有终端启动路径，形态与安卓一致，不改协议与交互。
 */
export async function openNewAgentSession(
  project: Project,
  provider: 'claude' | 'codex',
  providerId: string,
  modelId: string,
): Promise<void> {
  if (!getAppSettings().nativeChatSessions) {
    await openProjectAgentTerminal(project, provider, providerId, modelId);
    return;
  }
  const session = await aiSessionCreate({
    provider,
    providerId: catalogProviderId(provider, providerId),
    model: modelId || null,
    projectPath: project.path,
  });
  // 新建会话的唯一目的就是发消息，打开后直接把焦点交给输入框。
  openAgentTabForSession(session, true);
}

/** 打开一个已存在的原生会话（列表或历史入口），不新建进程。 */
export function openExistingAgentSession(session: AiSession): void {
  openAgentTabForSession(session);
}
