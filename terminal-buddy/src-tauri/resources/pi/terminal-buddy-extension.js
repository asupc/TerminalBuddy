// TerminalBuddy Pi Agent 扩展（由 TerminalBuddy 管理，请勿手工修改）。
// 无 TerminalBuddy 环境变量时完全 no-op；不在工厂里启动进程/定时器。
// 事件：session_start / input / agent_settled / tool_call / session_shutdown。

export default function terminalBuddyExtension(pi) {
	const terminalId = process.env.TERMINAL_BUDDY_TERMINAL_ID;
	const token = process.env.TERMINAL_BUDDY_HOOK_TOKEN;
	const port = process.env.TERMINAL_BUDDY_HOOK_PORT;
	if (!terminalId || !token || !port) return;

	const endpoint = `http://127.0.0.1:${port}/api/pi/hooks`;
	const approvalEnabled = process.env.TERMINAL_BUDDY_PI_TOOL_APPROVAL === '1';
	let lastStopReason;

	const sessionInfo = (ctx) => {
		try {
			return {
				sessionId: ctx?.sessionManager?.getSessionId?.(),
				sessionFile: ctx?.sessionManager?.getSessionFile?.(),
				cwd: ctx?.cwd,
			};
		} catch {
			return {};
		}
	};

	const post = async (payload) => {
		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
					'x-terminalbuddy-terminal-id': terminalId,
				},
				body: JSON.stringify(payload),
			});
			if (!response.ok) return null;
			const text = await response.text();
			return text ? JSON.parse(text) : null;
		} catch {
			// 上报失败不能影响 Pi 的正常运行。
			return null;
		}
	};

	const send = (event, ctx, extra = {}) => {
		const info = sessionInfo(ctx);
		if (!info.sessionId) return Promise.resolve(null);
		return post({ ...info, event, ...extra });
	};

	pi.on('message_end', (event) => {
		if (event?.message?.role === 'assistant') lastStopReason = event.message.stopReason;
	});

	pi.on('session_start', (event, ctx) => send('SessionStart', ctx, { reason: event?.reason }));

	pi.on('input', (event, ctx) => send('UserPromptSubmit', ctx, { prompt: event?.text }));

	pi.on('agent_start', (_event, ctx) => send('ToolCall', ctx));

	pi.on('agent_settled', (event, ctx) => {
		const failed = event?.aborted === true || lastStopReason === 'error';
		return send(failed ? 'StopFailure' : 'Stop', ctx, {
			reason: event?.aborted ? 'aborted' : lastStopReason,
		});
	});

	pi.on('tool_call', async (event, ctx) => {
		const toolName = event?.toolName || '';
		await send('ToolCall', ctx, { toolName, toolInput: event?.input });
		if (!approvalEnabled || !['bash', 'edit', 'write'].includes(String(toolName).toLowerCase())) return;
		const result = await send('ToolApproval', ctx, {
			toolName,
			toolInput: event?.input,
		});
		if (result && result.allow === false) {
			return { block: true, reason: '用户在 TerminalBuddy 中拒绝了本次工具调用' };
		}
	});

	pi.on('session_shutdown', (event, ctx) => send('SessionEnd', ctx, { reason: event?.reason }));
}
