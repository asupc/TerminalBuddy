import type { Terminal } from '@xterm/xterm';
import type { TerminalColors } from '../utils/terminalTheme';

type SnapshotProvider = () => Promise<string | null>;

const providers = new Map<string, SnapshotProvider>();

export function registerTerminalSnapshotProvider(
  terminalId: string,
  provider: SnapshotProvider,
): () => void {
  providers.set(terminalId, provider);
  return () => {
    if (providers.get(terminalId) === provider) providers.delete(terminalId);
  };
}

export async function captureTerminalSnapshot(terminalId: string): Promise<string | null> {
  return providers.get(terminalId)?.() ?? null;
}

export async function renderTerminalSnapshot(
  terminal: Terminal,
  terminalName: string,
  theme?: TerminalColors,
  maxRows = 30,
): Promise<string | null> {
  if (terminal.rows <= 0 || terminal.cols <= 0) return null;

  await document.fonts.ready;
  const buffer = terminal.buffer.active;
  const rowCount = Math.min(maxRows, terminal.rows);
  const startRow = buffer.viewportY + Math.max(0, terminal.rows - rowCount);
  const lines: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    lines.push(buffer.getLine(startRow + index)?.translateToString(true) ?? '');
  }

  const fontSize = 14;
  const lineHeight = 20;
  const horizontalPadding = 18;
  const headerHeight = 42;
  const fontFamily = "'Cascadia Mono', Consolas, 'Courier New', monospace";
  const measureCanvas = document.createElement('canvas');
  const measureContext = measureCanvas.getContext('2d');
  if (!measureContext) return null;
  measureContext.font = `${fontSize}px ${fontFamily}`;
  const cellWidth = Math.max(7, Math.ceil(measureContext.measureText('M').width));
  const naturalWidth = Math.max(420, horizontalPadding * 2 + terminal.cols * cellWidth);
  const naturalHeight = headerHeight + 14 + rowCount * lineHeight + 14;
  const scale = Math.min(1.5, 1600 / naturalWidth);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(naturalWidth * scale));
  canvas.height = Math.max(1, Math.floor(naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.scale(scale, scale);

  const background = theme?.background || '#1e1e1e';
  const foreground = theme?.foreground || '#cccccc';
  context.fillStyle = background;
  context.fillRect(0, 0, naturalWidth, naturalHeight);
  context.fillStyle = 'rgba(255, 255, 255, 0.06)';
  context.fillRect(0, 0, naturalWidth, headerHeight);
  context.fillStyle = foreground;
  context.font = `600 13px ${fontFamily}`;
  context.textBaseline = 'middle';
  context.fillText(terminalName, horizontalPadding, headerHeight / 2);
  context.globalAlpha = 0.65;
  context.font = `12px ${fontFamily}`;
  const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const timestampWidth = context.measureText(timestamp).width;
  context.fillText(timestamp, naturalWidth - horizontalPadding - timestampWidth, headerHeight / 2);
  context.globalAlpha = 1;

  context.font = `${fontSize}px ${fontFamily}`;
  context.textBaseline = 'top';
  lines.forEach((line, index) => {
    context.fillText(line, horizontalPadding, headerHeight + 14 + index * lineHeight);
  });

  return canvas.toDataURL('image/png');
}
