import type { AgentTab } from '../../stores/appStore';
import { NativeChatPage } from './NativeChatPage';
import { RelayChatPage } from './RelayChatPage';

/** 会话式聊天容器：按创建时固定的形态分派，不做会话内切换。 */
export function AgentChatPage({ tab }: { tab: AgentTab }) {
  return tab.shape === 'native' ? <NativeChatPage tab={tab} /> : <RelayChatPage tab={tab} />;
}
