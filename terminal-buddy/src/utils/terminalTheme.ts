import type { Profile } from '../types';
import { PRESET_THEMES } from '../types';
import { isDecorativeThemeSkin, MAX_APP_OPACITY } from './settings';
import type { DecorativeThemeSkin, ThemeSkin } from './settings';

/**
 * 判断背景色是否偏亮（浅色背景）。
 * 用 ITU-R BT.601 亮度近似公式。浅色背景下需启用最低对比度增强，
 * 以保证 truecolor 输出（PSReadLine / Oh My Posh / 各类 CLI 硬编码的颜色）
 * 在白底也能看清——这些 24-bit 颜色不受 16 色 ANSI 调色板影响。
 */
export const isLightBackground = (hex: string): boolean => {
  const m = hex.replace('#', '');
  if (m.length < 6) return false;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return false;
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128;
};

const LIGHT_SAFE_FOREGROUND = '38;2;31;35;40';
// WebGL 透明画布会把 SGR 2 的 DIM 属性误当成非默认背景并绘制黑色单元格。
// 用 ANSI bright black 作为浅色主题的次级文字色，颜色仍由各皮肤调色板决定。
const LIGHT_SAFE_DIM_FOREGROUND = '22;90';
// 白板模式下的中性块背景（输入框/消息块/选中高亮）。映射后的文字前景是接近黑的
// #1F2328(31,35,40)，背景若用蓝色（曾经的中浅蓝 #A8CBFF）会与黑字色相冲突、看着别扭；
// 改用中性浅灰 #D3D8DF(211,216,223)——与深色文字同属无彩色系、天然协调，也正是浅色 UI
// (GitHub Light / VS Code Light) 输入框与选中项的标准做法。亮度上不能太浅：早先
// #DEECFF(222,236,255,亮度≈232) 几乎与白底(#FFFFFF)融为一体、看不出选中哪一条；
// #D3D8DF 亮度≈215，与白底差约 40，选中项清晰可辨，又仍是轻盈的浅色、不致成为沉色块。
const LIGHT_SAFE_NEUTRAL_BACKGROUND = '48;2;211;216;223';
const LIGHT_SAFE_ADD_BACKGROUND = '48;2;241;255;245';
const LIGHT_SAFE_DELETE_BACKGROUND = '48;2;255;244;245';

const rgbBrightness = (r: number, g: number, b: number) => (r * 299 + g * 587 + b * 114) / 1000;
const isNearWhiteRgb = (r: number, g: number, b: number) => r >= 235 && g >= 235 && b >= 235;
const isGrayRgb = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b) <= 16;
const isRedBgRgb = (r: number, g: number, b: number) => r > g * 1.25 && r > b * 1.25;
const isGreenBgRgb = (r: number, g: number, b: number) => g > r * 1.15 && g > b * 1.15;

const mapLightBackgroundColor = (r: number, g: number, b: number): string | null => {
  if (isGreenBgRgb(r, g, b)) return LIGHT_SAFE_ADD_BACKGROUND;
  if (isRedBgRgb(r, g, b)) return LIGHT_SAFE_DELETE_BACKGROUND;
  // 亮度 < 128（与 isLightBackground 同一套阈值，视为偏暗）或灰色 → 中性浅灰，
  // 覆盖深蓝/深紫/深青等中深色背景，避免白板模式下漏出任何深色块。
  if (rgbBrightness(r, g, b) < 128 || isGrayRgb(r, g, b)) return LIGHT_SAFE_NEUTRAL_BACKGROUND;
  return null;
};

/**
 * 浅色终端兜底：把深色终端专用的前景/背景 ANSI 改成白底可读版本。
 *
 * 有些程序会输出「白色文字 + 无背景」或「黑色/深灰背景」的 ANSI，这在深色
 * 终端没问题，但白底下会出现白字消失、黑色输入框、diff 行灰底不协调等问题。
 * xterm 的 theme 只能覆盖 16 色表，minimumContrastRatio 在部分 truecolor/WebGL
 * 场景也可能不生效，所以这里在写入前做一次较窄的修正。
 */
export const normalizeAnsiForLightBackground = (data: string, lightBackground: boolean): string => {
  if (!lightBackground || !data.includes('\x1b[')) return data;
  return data.replace(/\x1b\[([0-9;]*)m/g, (match, raw: string) => {
    if (!raw) return match;
    const parts = raw.split(';').filter(Boolean);
    const out: string[] = [];
    let changed = false;

    for (let i = 0; i < parts.length; i++) {
      const n = Number(parts[i]);

      if (n === 2) {
        out.push(LIGHT_SAFE_DIM_FOREGROUND);
        changed = true;
        continue;
      }

      // ANSI white / bright white foreground
      if (n === 37 || n === 97) {
        out.push(LIGHT_SAFE_FOREGROUND);
        changed = true;
        continue;
      }

      // ANSI background: black/bright black -> neutral, red/green -> diff colors
      if (n === 40 || n === 100) {
        out.push(LIGHT_SAFE_NEUTRAL_BACKGROUND);
        changed = true;
        continue;
      }
      if (n === 41 || n === 101) {
        out.push(LIGHT_SAFE_DELETE_BACKGROUND);
        changed = true;
        continue;
      }
      if (n === 42 || n === 102) {
        out.push(LIGHT_SAFE_ADD_BACKGROUND);
        changed = true;
        continue;
      }

      // 38/48 后面可能跟 truecolor(2;r;g;b) 或 256 色(5;idx) 子序列。无论是否命中
      // 改写，都必须把整段参数消费掉——否则颜色分量（如 102/101/100）会被当成
      // 独立的 16 色 SGR 码二次处理，破坏整串：白板下 claude code 等输出的彩色
      // 文字、/ui 选中高亮会因此错乱看不清。命中→替换；不命中→原样保留整段。
      if (n === 38 || n === 48) {
        const isBg = n === 48;

        // truecolor: 38/48;2;r;g;b
        if (parts[i + 1] === '2') {
          const r = Number(parts[i + 2]);
          const g = Number(parts[i + 3]);
          const b = Number(parts[i + 4]);
          if ([r, g, b].every((v) => Number.isFinite(v))) {
            if (!isBg && isNearWhiteRgb(r, g, b)) {
              out.push(LIGHT_SAFE_FOREGROUND);
              changed = true;
              i += 4;
              continue;
            }
            if (isBg) {
              const mapped = mapLightBackgroundColor(r, g, b);
              if (mapped) {
                out.push(mapped);
                changed = true;
                i += 4;
                continue;
              }
            }
          }
          // 不命中：原样保留 38/48;2;r;g;b（由 xterm minimumContrastRatio 兜底前景对比）
          out.push(parts[i], parts[i + 1], parts[i + 2], parts[i + 3], parts[i + 4]);
          i += 4;
          continue;
        }

        // 256 色: 38/48;5;idx
        if (parts[i + 1] === '5') {
          const idx = Number(parts[i + 2]);
          if (Number.isFinite(idx)) {
            // 前景：15/231 常见为白色或近白色
            if (!isBg && (idx === 15 || idx === 231)) {
              out.push(LIGHT_SAFE_FOREGROUND);
              changed = true;
              i += 2;
              continue;
            }
            // 背景：232-246 是 xterm 256 色里的黑到中灰阶，很多 TUI 用它画输入框/消息块
            if (isBg && (idx === 0 || idx === 8 || (idx >= 232 && idx <= 246))) {
              out.push(LIGHT_SAFE_NEUTRAL_BACKGROUND);
              changed = true;
              i += 2;
              continue;
            }
            if (isBg && (idx === 1 || idx === 9 || idx === 52 || idx === 88 || idx === 124 || idx === 160 || idx === 196)) {
              out.push(LIGHT_SAFE_DELETE_BACKGROUND);
              changed = true;
              i += 2;
              continue;
            }
            if (isBg && (idx === 2 || idx === 10 || idx === 22 || idx === 28 || idx === 34 || idx === 40 || idx === 46)) {
              out.push(LIGHT_SAFE_ADD_BACKGROUND);
              changed = true;
              i += 2;
              continue;
            }
          }
          // 不命中：原样保留 38/48;5;idx
          out.push(parts[i], parts[i + 1], parts[i + 2]);
          i += 2;
          continue;
        }

        // 38/48 后面不是 2/5（异常序列）：保留单码
        out.push(parts[i]);
        continue;
      }

      out.push(parts[i]);
    }

    return changed ? `\x1b[${out.join(';')}m` : match;
  });
};

/**
 * 终端配色。background/foreground 必填，其余 ANSI 16 色与光标/选中色为可选——
 * 缺省时由 xterm.js 使用其默认深色调色板，浅色场景下我们会显式填充一套适配白底的调色板。
 */
export interface TerminalColors {
  background: string;
  foreground: string;
  /** 透明画布的 RGB 基色，用于让渲染器按实际皮肤背景计算文字对比度。 */
  canvasBackground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
  /** 仅自动白板模式使用：开启 ANSI 输出修正与最低对比度增强 */
  lightOptimized?: boolean;
}

const DARK_COLORS: TerminalColors = { background: '#1E1E1E', foreground: '#CCCCCC' };

// 浅色（白底）调色板：参考 GitHub Light 终端配色。
// 关键点：绿色/黄色/亮绿等在纯白底(#FFFFFF)上天生对比度低，
// VS Code Light+ 那套(#00BC00/#949800/#14CE14)在白底仅 2~3:1，会看不清；
// GitHub Light 这套每个颜色在白底对比度都 ≥4.5:1(WCAG AA)，
// git status / ls / log 等彩色输出在白底下也能清晰阅读。
const LIGHT_COLORS: TerminalColors = {
  background: '#FFFFFF',
  foreground: '#1F2328',
  lightOptimized: true,
  cursor: '#1F2328',
  cursorAccent: '#FFFFFF',
  selectionBackground: '#ADD6FF',
  black: '#24292F',
  red: '#CF222E',
  green: '#116329',
  yellow: '#4D2D00',
  blue: '#0969DA',
  magenta: '#8250DF',
  cyan: '#1B7C83',
  white: '#6E7781',
  brightBlack: '#57606A',
  brightRed: '#A40E26',
  brightGreen: '#1A7F37',
  brightYellow: '#633C01',
  brightBlue: '#218BFF',
  brightMagenta: '#A475F9',
  brightCyan: '#3192AA',
  brightWhite: '#8C959F',
};

const CARTOON_COLORS: TerminalColors = {
  background: 'rgba(255, 253, 248, 0)',
  foreground: '#71475C',
  lightOptimized: true,
  cursor: '#EF6F9B',
  cursorAccent: '#FFFDF8',
  selectionBackground: '#FFD5E2',
  black: '#5F3B4C',
  red: '#C73F69',
  green: '#467F3A',
  yellow: '#85570F',
  blue: '#377FC1',
  magenta: '#A95AB5',
  cyan: '#397F84',
  white: '#A87D8F',
  brightBlack: '#846173',
  brightRed: '#DE5E83',
  brightGreen: '#5B994C',
  brightYellow: '#A36D19',
  brightBlue: '#4C92D2',
  brightMagenta: '#C379CA',
  brightCyan: '#57989C',
  brightWhite: '#C09AAB',
};

const STARRY_COLORS: TerminalColors = {
  background: 'rgba(22, 24, 81, 0)',
  foreground: '#E8E3FF',
  cursor: '#C08AFF',
  cursorAccent: '#161851',
  selectionBackground: '#554A91',
  black: '#20235F',
  red: '#FF829F',
  green: '#9EDD70',
  yellow: '#FFE08A',
  blue: '#78D8FF',
  magenta: '#C08AFF',
  cyan: '#75E1E9',
  white: '#E8E3FF',
  brightBlack: '#8F87BD',
  brightRed: '#FFA3B8',
  brightGreen: '#BBED91',
  brightYellow: '#FFEDB3',
  brightBlue: '#A8E7FF',
  brightMagenta: '#D7B3FF',
  brightCyan: '#A6F1F5',
  brightWhite: '#FFF9FF',
};

const CYBER_COLORS: TerminalColors = {
  background: 'rgba(3, 5, 16, 0)',
  foreground: '#D9C8E8',
  cursor: '#FF2DBA',
  cursorAccent: '#030510',
  selectionBackground: '#58204E',
  black: '#11152B',
  red: '#FF5B7F',
  green: '#9CEB50',
  yellow: '#FFD95D',
  blue: '#00D9FF',
  magenta: '#FF2DBA',
  cyan: '#39E6DE',
  white: '#D9C8E8',
  brightBlack: '#877893',
  brightRed: '#FF82A0',
  brightGreen: '#B9F17E',
  brightYellow: '#FFE68F',
  brightBlue: '#6BE9FF',
  brightMagenta: '#FF73D4',
  brightCyan: '#7AF2EC',
  brightWhite: '#F8E9FF',
};

const SAKURA_COLORS: TerminalColors = {
  background: 'rgba(255, 251, 241, 0)',
  canvasBackground: 'rgba(255, 253, 248, 0)',
  foreground: '#453238',
  lightOptimized: true,
  cursor: '#B94758',
  cursorAccent: '#FFF9F5',
  selectionBackground: '#D99EAA',
  black: '#453238',
  red: '#B23A4D',
  green: '#4E7049',
  yellow: '#755A25',
  blue: '#426675',
  magenta: '#76586D',
  cyan: '#4E6E6B',
  white: '#78666A',
  brightBlack: '#735F64',
  brightRed: '#BE4658',
  brightGreen: '#5A7953',
  brightYellow: '#80672E',
  brightBlue: '#527382',
  brightMagenta: '#87677C',
  brightCyan: '#5A7773',
  brightWhite: '#856F73',
};

const DECORATIVE_THEME_BACKGROUND_RGB: Record<DecorativeThemeSkin, readonly [number, number, number]> = {
  // 与各皮肤的 --bg-secondary 完全一致，确保终端与左右主分栏在同一
  // 不透明度下呈现相同的合成深浅，而不是看起来像用了不同档位。
  cartoon: [255, 253, 251],
  starry: [28, 31, 91],
  cyber: [6, 8, 24],
  sakura: [255, 253, 248],
};

const appOpacityThemeCache = new WeakMap<TerminalColors, Map<string, TerminalColors>>();

const withAppOpacity = (
  colors: TerminalColors,
  skin: DecorativeThemeSkin,
  opacity: number,
): TerminalColors => {
  const normalized = Math.min(MAX_APP_OPACITY, Math.max(0, Math.round(opacity)));
  const cacheKey = `${skin}:${normalized}`;
  let colorCache = appOpacityThemeCache.get(colors);
  if (!colorCache) {
    colorCache = new Map<string, TerminalColors>();
    appOpacityThemeCache.set(colors, colorCache);
  }
  const cached = colorCache.get(cacheKey);
  if (cached) return cached;
  const [red, green, blue] = DECORATIVE_THEME_BACKGROUND_RGB[skin];
  const result = {
    ...colors,
    background: `rgba(${red}, ${green}, ${blue}, ${normalized / 100})`,
  };
  colorCache.set(cacheKey, result);
  return result;
};

// preset 分支按 themeId 缓存返回值，保证同一 profile 多次解析得到稳定引用，
// 避免 TerminalInstance 的 useEffect 因引用变化而误触发 xterm 重新设置 theme。
const presetCache = new Map<string, TerminalColors>();

/**
 * 解析终端实际使用的配色。
 *
 * 终端配色（profile.colorTheme）与应用皮肤是两套独立系统，
 * 切换浅色模式时终端默认不会跟着变。本函数统一处理跟随逻辑：
 * - 开启「终端跟随应用主题」且 profile 未显式指定非默认配色时，
 *   终端配色随应用皮肤切换，动漫皮肤使用各自的深色或浅色安全调色板。
 * - 否则使用 profile 自身配置的配色（默认为深色）。
 */
export const resolveTerminalColors = (
  profile: Pick<Profile, 'colorTheme'> | undefined,
  appTheme: ThemeSkin,
  followEnabled: boolean,
  appOpacity = 0,
): TerminalColors => {
  const themeId = profile?.colorTheme;
  let colors: TerminalColors;
  // 跟随开关开启且未显式指定非默认配色 → 跟随应用主题
  if (followEnabled && (!themeId || themeId === 'dark-default')) {
    if (appTheme === 'cartoon') colors = CARTOON_COLORS;
    else if (appTheme === 'starry') colors = STARRY_COLORS;
    else if (appTheme === 'cyber') colors = CYBER_COLORS;
    else if (appTheme === 'sakura') colors = SAKURA_COLORS;
    else colors = appTheme === 'light' ? LIGHT_COLORS : DARK_COLORS;
  } else {
    const key = themeId || '__default__';
    const cached = presetCache.get(key);
    if (cached) colors = cached;
    else {
      const preset = PRESET_THEMES.find((t) => t.id === themeId);
      colors = preset
        ? { background: preset.background, foreground: preset.foreground }
        : DARK_COLORS;
      presetCache.set(key, colors);
    }
  }
  return isDecorativeThemeSkin(appTheme) ? withAppOpacity(colors, appTheme, appOpacity) : colors;
};
