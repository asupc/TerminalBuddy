// TerminalBuddy Pi Agent 扩展（由 TerminalBuddy 管理，请勿手工修改）。
// 无 TerminalBuddy 环境变量且未开启工具审批时完全 no-op；不在工厂里启动进程/定时器。
// 事件：session_start / input / agent_settled / tool_call / session_shutdown。
// 事件上报走 HTTP Hook（桌面终端链路）；工具审批在 RPC 模式（原生会话）走扩展 UI 确认。

export default function terminalBuddyExtension(pi) {
	const terminalId = process.env.TERMINAL_BUDDY_TERMINAL_ID;
	const token = process.env.TERMINAL_BUDDY_HOOK_TOKEN;
	const port = process.env.TERMINAL_BUDDY_HOOK_PORT;
	const hooked = Boolean(terminalId && token && port);
	const approvalEnabled = process.env.TERMINAL_BUDDY_PI_TOOL_APPROVAL === '1';
	if (!hooked && !approvalEnabled) return;

	const endpoint = `http://127.0.0.1:${port || 0}/api/pi/hooks`;
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

	// 审批提示里给出最关键的一行输入（命令或路径），其余以 JSON 兜底。
	const describeInput = (input) => {
		if (input == null) return '';
		if (typeof input === 'string') return input;
		if (typeof input.command === 'string') return input.command;
		if (typeof input.path === 'string') return input.path;
		if (typeof input.file_path === 'string') return input.file_path;
		try {
			return JSON.stringify(input);
		} catch {
			return '';
		}
	};

	if (hooked) {
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

		pi.on('session_shutdown', (event, ctx) => send('SessionEnd', ctx, { reason: event?.reason }));
	}

	pi.on('tool_call', async (event, ctx) => {
		const toolName = event?.toolName || '';
		if (hooked) await send('ToolCall', ctx, { toolName, toolInput: event?.input });
		if (!approvalEnabled || !['bash', 'edit', 'write'].includes(String(toolName).toLowerCase())) return;
		if (hooked) {
			const result = await send('ToolApproval', ctx, {
				toolName,
				toolInput: event?.input,
			});
			if (result && result.allow === false) {
				return { block: true, reason: '用户在 TerminalBuddy 中拒绝了本次工具调用' };
			}
			return;
		}
		// RPC 模式（原生会话）：扩展 UI 由 TerminalBuddy 客户端代答；无 UI 的模式保持 Pi 原生行为。
		const ui = ctx?.ui;
		if (!ui || typeof ui.confirm !== 'function') return;
		try {
			const confirmed = await ui.confirm(`允许 Pi 执行 ${toolName} 工具？`, describeInput(event?.input));
			if (confirmed !== true) {
				return { block: true, reason: '用户在 TerminalBuddy 中拒绝了本次工具调用' };
			}
		} catch (error) {
			return { block: true, reason: `工具审批未完成：${error?.message || error}` };
		}
	});
}
