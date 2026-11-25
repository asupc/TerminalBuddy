import { memo, useEffect, useMemo, useState } from 'react';
import type { AiSession } from '../../services/tauri/aiChat';
import { getAgentCliStatus } from '../../services/tauri/agentCli';
import { listClaudeMcpServers } from '../../services/tauri/claudeMcp';
import type { GitRepositoryStatus } from '../../services/tauri/git';
import {
  getCachedGitRepositoryStatus,
  loadGitRepositoryStatus,
  subscribeGitRepositoryStatus,
} from '../../services/gitStatusCache';
import './SessionStatusBar.css';

/**
 * 会话状态行（输入框下方、面板底边）：把 status-line 里适合远程查看的
 * 会话信息汇总成一行小字。数据全部来自会话快照、项目 Git / MCP / CLI 接口，
 * 不新增轮询通道；取不到的项直接不渲染，避免占位符噪声。
 */

/** CLI 版本查询有进程开销：同一 Agent 只查一次，浏览器端不支持时静默缓存空值。 */
const versionCache = new Map<string, Promise<string | null>>();
function loadCliVersion(provider: string): Promise<string | null> {
  const cached = versionCache.get(provider);
  if (cached) return cached;
  const request = getAgentCliStatus(provider as 'claude' | 'codex' | 'antigravity', false)
    .then(status => status.version)
    .catch(() => null);
  versionCache.set(provider, request);
  return request;
}

function durationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

function agoLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return '刚刚';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  return `${Math.floor(hours / 24)}d 前`;
}

/** 本轮平均输出速度：只在完整收尾后计算，避免流式快照给出跳变的值。 */
function outputSpeed(session: AiSession): number | null {
  const turn = session.usage?.lastTurn;
  if (!turn?.startedAt || !turn.endedAt || turn.endedAt <= turn.startedAt) return null;
  const output = turn.outputTokens ?? 0;
  if (output <= 0) return null;
  return output / ((turn.endedAt - turn.startedAt) / 1000);
}

/** 最近一条主线程回复的时间。 */
function lastReplyAt(session: AiSession): number | null {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role === 'assistant' && !message.subagent) return message.createdAt;
  }
  return null;
}

/** 本轮（最后一条用户消息之后）实际调用过的 MCP 服务器与 Skill。 */
function activeTools(session: AiSession): { mcps: string[]; skills: string[] } {
  const messages = session.messages;
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') { start = index + 1; break; }
  }
  const mcps: string[] = [];
  const skills: string[] = [];
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index];
    if (message.role !== 'tool' || message.subagent || message.todo) continue;
    const [name, ...rest] = message.text.split('\n');
    const tool = name.trim();
    if (tool.startsWith('mcp__')) {
      const server = tool.split('__')[1];
      if (server && !mcps.includes(server)) mcps.push(server);
      continue;
    }
    if (tool === 'Skill') {
      const argument = rest.join('\n');
      let skill = message.skillName ?? null;
      if (!skill) {
        try {
          const parsed = JSON.parse(argument) as { skill?: unknown };
          skill = typeof parsed.skill === 'string' ? parsed.skill : null;
        } catch {
          skill = argument.match(/"skill"\s*:\s*"([^"]+)"/)?.[1] ?? null;
        }
      }
      if (skill && !skills.includes(skill)) skills.push(skill);
    }
  }
  return { mcps: mcps.slice(0, 3), skills: skills.slice(0, 3) };
}

interface Props {
  session: AiSession;
  running: boolean;
}

export const SessionStatusBar = memo(function SessionStatusBar({ session, running }: Props) {
  const [git, setGit] = useState<GitRepositoryStatus | null>(null);
  const [mcpCount, setMcpCount] = useState<number | null>(null);
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());

  // 时长与「最近回复」需要随时间流动；30 秒刷新一次足以，避免每秒重渲染。
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setGit(null);
    if (!session.projectPath) return;
    // 先读缓存，再发起一次实际检测；项目面板的 Git 操作会刷新同一份缓存，
    // 这里订阅后无需再开一条轮询通道。
    setGit(getCachedGitRepositoryStatus(session.projectPath)?.status ?? null);
    loadGitRepositoryStatus(session.projectPath)
      .then(status => { if (!cancelled) setGit(status); })
      .catch(() => {});
    const unsubscribe = subscribeGitRepositoryStatus(() => {
      if (!cancelled) setGit(getCachedGitRepositoryStatus(session.projectPath)?.status ?? null);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [session.projectPath]);

  useEffect(() => {
    let cancelled = false;
    setMcpCount(null);
    if (session.provider !== 'claude') return;
    Promise.all([
      listClaudeMcpServers('user').catch(() => []),
      listClaudeMcpServers('project', session.projectPath).catch(() => []),
    ]).then(([user, project]) => {
      if (cancelled) return;
      const names = new Set([...user, ...project].map(server => server.name));
      setMcpCount(names.size);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [session.provider, session.projectPath]);

  useEffect(() => {
    let cancelled = false;
    setCliVersion(null);
    loadCliVersion(session.provider).then(version => {
      if (!cancelled) setCliVersion(version);
    });
    return () => { cancelled = true; };
  }, [session.provider]);

  const active = useMemo(() => activeTools(session), [session.messages]);
  const replyAt = useMemo(() => lastReplyAt(session), [session.messages]);
  const speed = outputSpeed(session);

  const startedAt = session.createdAt || session.messages[0]?.createdAt || 0;
  const duration = startedAt > 0 ? durationLabel((running ? tick : session.updatedAt || tick) - startedAt) : null;

  const items: { key: string; text: string; title?: string }[] = [];
  if (duration) items.push({ key: 'duration', text: `运行 ${duration}`, title: '会话运行时长' });
  if (replyAt) items.push({ key: 'reply', text: `回复 ${agoLabel(tick - replyAt)}`, title: '距最近一次助手回复' });
  if (session.compactions) items.push({ key: 'compact', text: `压缩 ${session.compactions} 次`, title: '上下文压缩次数' });
  if (git) {
    const changes = git.changedCount > 0 ? ` · ${git.changedCount} 处变更` : '';
    const sync = `${git.ahead > 0 ? ` ↑${git.ahead}` : ''}${git.behind > 0 ? ` ↓${git.behind}` : ''}`;
    items.push({ key: 'git', text: `${git.branch}${sync}${changes}`, title: '当前 Git 分支与未提交变更' });
  }
  if (speed != null) items.push({ key: 'speed', text: `${speed >= 100 ? Math.round(speed) : speed.toFixed(1)} tok/s`, title: '本轮平均输出速度' });
  if (active.mcps.length > 0) items.push({ key: 'mcp-active', text: `MCP: ${active.mcps.join(', ')}`, title: '本轮调用过的 MCP 服务器' });
  if (active.skills.length > 0) items.push({ key: 'skill', text: `Skill: ${active.skills.join(', ')}`, title: '本轮调用过的 Skill' });
  if (cliVersion) items.push({
    key: 'version',
    text: `${session.provider === 'codex' ? 'Codex' : session.provider === 'antigravity' ? 'Antigravity' : 'Claude Code'} ${cliVersion}`,
    title: 'CLI 版本',
  });
  if (mcpCount != null && mcpCount > 0) items.push({ key: 'mcp-count', text: `MCP 服务器 ${mcpCount}`, title: '已配置的 MCP 服务器数量' });

  if (items.length === 0) return null;

  return (
    <div className="agent-session-meta" aria-label="会话状态">
      {items.map(item => (
        <span className="agent-session-meta-item" key={item.key} title={item.title}>{item.text}</span>
      ))}
    </div>
  );
});
