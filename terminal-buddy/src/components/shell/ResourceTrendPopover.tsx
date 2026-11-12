import { FC, RefObject, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  getResourceHistory,
  subscribeResourceHistory,
  RESOURCE_HISTORY_WINDOW_MS,
  type ResourceSample,
} from '../../services/resourceHistory';
import './ResourceTrendPopover.css';

const VIEW_W = 436;
const VIEW_H = 158;
const PAD_LEFT = 32;
const PAD_RIGHT = 10;
const PAD_TOP = 8;
const PAD_BOTTOM = 20;
const PLOT_W = VIEW_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = VIEW_H - PAD_TOP - PAD_BOTTOM;
/** 趋势图不需要 3 秒粒度：按时间桶取均值，2 小时约 150 个点。 */
const BUCKETS = 150;

interface TrendPoint {
  t: number;
  cpu: number;
  mem: number;
}

interface ResourceTrendPopoverProps {
  /** 相对视口的定位：距右边缘、距底部（状态栏上沿之上）。 */
  anchor: { right: number; bottom: number };
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

function aggregate(samples: ResourceSample[], start: number, end: number): TrendPoint[] {
  const bucketMs = (end - start) / BUCKETS;
  const buckets = new Array<{ t: number; cpu: number; mem: number; n: number } | undefined>(BUCKETS);
  for (const sample of samples) {
    if (sample.t < start || sample.t > end) continue;
    const index = Math.min(BUCKETS - 1, Math.floor((sample.t - start) / bucketMs));
    const bucket = buckets[index] ?? { t: 0, cpu: 0, mem: 0, n: 0 };
    bucket.t += sample.t;
    bucket.cpu += sample.cpu;
    bucket.mem += sample.mem;
    bucket.n += 1;
    buckets[index] = bucket;
  }
  return buckets
    .filter((bucket): bucket is { t: number; cpu: number; mem: number; n: number } => bucket !== undefined)
    .map(bucket => ({ t: bucket.t / bucket.n, cpu: bucket.cpu / bucket.n, mem: bucket.mem / bucket.n }));
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 状态栏资源趋势：近 2 小时的 CPU / 内存折线。
 * 采样来自状态栏轮询的内存缓存（localStorage 持久化），打开时按时间桶降采样。
 */
export const ResourceTrendPopover: FC<ResourceTrendPopoverProps> = ({ anchor, anchorRef, onClose }) => {
  const [samples, setSamples] = useState<ResourceSample[]>(() => getResourceHistory());
  const [hover, setHover] = useState<{ x: number; point: TrendPoint } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeResourceHistory(() => setSamples(getResourceHistory())), []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const handleResize = () => onClose();
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [anchorRef, onClose]);

  const now = Date.now();
  const start = now - RESOURCE_HISTORY_WINDOW_MS;
  const points = aggregate(samples, start, now);
  const latest = samples[samples.length - 1];
  const peakCpu = samples.reduce((peak, sample) => Math.max(peak, sample.cpu), 0);
  const peakMem = samples.reduce((peak, sample) => Math.max(peak, sample.mem), 0);

  const xOf = (timestamp: number) => PAD_LEFT + ((timestamp - start) / (now - start)) * PLOT_W;
  const yOf = (value: number) => PAD_TOP + (1 - value / 100) * PLOT_H;
  const pathFor = (key: 'cpu' | 'mem') => points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(point.t).toFixed(1)},${yOf(point[key]).toFixed(1)}`)
    .join(' ');
  const lastPoint = points[points.length - 1];

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const viewX = ((event.clientX - rect.left) / rect.width) * VIEW_W;
    let nearest = points[0];
    let nearestDistance = Infinity;
    for (const point of points) {
      const distance = Math.abs(xOf(point.t) - viewX);
      if (distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }
    setHover({ x: xOf(nearest.t), point: nearest });
  };

  return (
    <div
      className="resource-trend-popover"
      ref={popoverRef}
      style={{ right: anchor.right, bottom: anchor.bottom }}
      role="dialog"
      aria-label="资源使用趋势"
    >
      <div className="resource-trend-header">
        <span className="resource-trend-title">资源使用趋势</span>
        <span className="resource-trend-range">近 2 小时</span>
        <button
          type="button"
          className="resource-trend-close"
          onClick={onClose}
          title="关闭"
          aria-label="关闭资源使用趋势"
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <div className="resource-trend-legend">
        <span className="resource-trend-legend-item">
          <span className="resource-trend-key cpu" aria-hidden="true" />
          <span>CPU</span>
          <strong>{Math.round(latest?.cpu ?? 0)}%</strong>
          <span className="resource-trend-peak">峰值 {Math.round(peakCpu)}%</span>
        </span>
        <span className="resource-trend-legend-item">
          <span className="resource-trend-key mem" aria-hidden="true" />
          <span>内存</span>
          <strong>{Math.round(latest?.mem ?? 0)}%</strong>
          <span className="resource-trend-peak">峰值 {Math.round(peakMem)}%</span>
        </span>
      </div>

      <div className="resource-trend-chart">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          width="100%"
          height={VIEW_H}
          role="img"
          aria-label="近 2 小时 CPU 与内存使用率折线图"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHover(null)}
        >
          {[0, 50, 100].map(value => (
            <g key={value}>
              <line
                x1={PAD_LEFT}
                x2={VIEW_W - PAD_RIGHT}
                y1={yOf(value)}
                y2={yOf(value)}
                className="resource-trend-grid"
              />
              <text x={PAD_LEFT - 6} y={yOf(value) + 3.5} textAnchor="end" className="resource-trend-axis">
                {value}%
              </text>
            </g>
          ))}

          {points.length > 1 && (
            <>
              <path className="resource-trend-line cpu" d={pathFor('cpu')} />
              <path className="resource-trend-line mem" d={pathFor('mem')} />
            </>
          )}

          {lastPoint && (
            <>
              <circle cx={xOf(lastPoint.t)} cy={yOf(lastPoint.cpu)} r="4" className="resource-trend-dot cpu" />
              <circle cx={xOf(lastPoint.t)} cy={yOf(lastPoint.mem)} r="4" className="resource-trend-dot mem" />
            </>
          )}

          {hover && (
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD_TOP}
              y2={PAD_TOP + PLOT_H}
              className="resource-trend-crosshair"
            />
          )}

          <text x={PAD_LEFT} y={VIEW_H - 4} className="resource-trend-axis">2 小时前</text>
          <text x={PAD_LEFT + PLOT_W / 2} y={VIEW_H - 4} textAnchor="middle" className="resource-trend-axis">1 小时前</text>
          <text x={VIEW_W - PAD_RIGHT} y={VIEW_H - 4} textAnchor="end" className="resource-trend-axis">现在</text>
        </svg>

        {points.length === 0 && (
          <div className="resource-trend-empty">暂无采样数据，状态栏每 3 秒采样一次</div>
        )}

        {hover && (
          <div
            className="resource-trend-tooltip"
            style={{
              left: `${(hover.x / VIEW_W) * 100}%`,
              transform: hover.x > VIEW_W * 0.62 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            <div className="resource-trend-tooltip-time">{formatClock(hover.point.t)}</div>
            <div className="resource-trend-tooltip-row">
              <strong>{Math.round(hover.point.cpu)}%</strong>
              <span>CPU</span>
            </div>
            <div className="resource-trend-tooltip-row">
              <strong>{Math.round(hover.point.mem)}%</strong>
              <span>内存</span>
            </div>
          </div>
        )}
      </div>

      <div className="resource-trend-footnote">采样间隔 3 秒 · 页面隐藏时暂停 · 缓存保留 2 小时</div>
    </div>
  );
};
