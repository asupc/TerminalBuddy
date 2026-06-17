import { invoke } from '@tauri-apps/api/core';

/**
 * 启动日志：同时输出到 devtools console 和 Rust 终端（统一时间线）。
 * ts = performance.now()（相对页面导航的毫秒）。Rust 端会把它与进程启动时间并排打印，
 * 用于定位启动卡顿发生在 Rust 侧（进程/WebView 启动）还是前端侧（JS 执行/IPC 初始化）。
 *
 * 临时诊断用途，定位完启动卡顿后可移除。
 */
export async function bootLog(msg: string): Promise<void> {
  const ts = performance.now();
  console.log(`[boot] js+${ts.toFixed(0)}ms ${msg}`);
  try {
    await invoke('log_boot', { msg, ts });
  } catch {
    // invoke handler 未就绪（启动极早期）时降级为仅 console
  }
}
