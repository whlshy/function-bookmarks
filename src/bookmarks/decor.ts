/**
 * 書籤的外觀（M7）：顏色色盤、號碼、行號旁圖示。純函式，不依賴 vscode，方便單元測試。
 */

export interface PaletteColor {
  id: string;
  /** 行號旁圖示與捲軸標記用的顏色。 */
  hex: string;
  /** 側邊欄圖示用的主題顏色（跟著佈景主題調整亮度）。 */
  theme: string;
}

/** 預設顏色（青綠）：沒有設定顏色的自己的書籤。 */
export const DEFAULT_COLOR = 'teal';
/** 別人的書籤（匯入的）預設為紫色。 */
export const FOREIGN_DEFAULT = 'purple';

export const PALETTE: PaletteColor[] = [
  { id: 'red', hex: '#F14C4C', theme: 'charts.red' },
  { id: 'orange', hex: '#F59E0B', theme: 'charts.orange' },
  { id: 'yellow', hex: '#E5C100', theme: 'charts.yellow' },
  { id: 'green', hex: '#3FB950', theme: 'charts.green' },
  { id: 'teal', hex: '#2BB5A0', theme: 'terminal.ansiCyan' },
  { id: 'blue', hex: '#3794FF', theme: 'charts.blue' },
  { id: 'purple', hex: '#A371F7', theme: 'charts.purple' },
  { id: 'pink', hex: '#E86BB6', theme: 'terminal.ansiMagenta' },
  { id: 'gray', hex: '#8B949E', theme: 'disabledForeground' },
];

export function paletteColor(id: string | undefined): PaletteColor | undefined {
  return id ? PALETTE.find((c) => c.id === id) : undefined;
}

/**
 * 書籤實際使用的顏色：書籤自己的顏色 → 第一個有顏色的標籤 → 別人的書籤為紫色 → 沒有（預設）。
 * 回傳 undefined 表示用預設樣式。
 */
export function effectiveColor(
  b: { color?: string; tags?: string[]; source?: unknown },
  tagColors: ReadonlyMap<string, string> | Record<string, string>,
): string | undefined {
  if (paletteColor(b.color)) {
    return b.color;
  }
  const get = (t: string) => (tagColors instanceof Map ? tagColors.get(t) : (tagColors as Record<string, string>)[t]);
  for (const t of b.tags ?? []) {
    const c = get(t);
    if (paletteColor(c)) {
      return c;
    }
  }
  return b.source ? FOREIGN_DEFAULT : undefined;
}

const CIRCLED = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

/** 號碼的顯示文字（①～⑨）。 */
export function circled(n: number | undefined): string {
  return n && n >= 1 && n <= 9 ? CIRCLED[n] : '';
}

/** 下一個沒被用掉的號碼（1～9）；都用掉了回傳 undefined。 */
export function nextFreeNumber(used: Iterable<number | undefined>): number | undefined {
  const set = new Set(used);
  for (let n = 1; n <= 9; n++) {
    if (!set.has(n)) {
      return n;
    }
  }
  return undefined;
}

export type GutterKind = 'bookmark' | 'favorite' | 'lost';

/** 「需確認」書籤的行號旁圖示顏色（固定中性灰，不受書籤或標籤顏色影響）。 */
export const LOST_HEX = '#8a8a8a';

const SHAPE = 'M4.5 1.5h7a1 1 0 0 1 1 1v12l-4.5-3-4.5 3v-12a1 1 0 0 1 1-1z';
const STAR = 'M8 4.2l.85 1.75 1.9.27-1.38 1.33.33 1.9L8 8.55l-1.7.9.33-1.9-1.38-1.33 1.9-.27z';

/** 黃色、淺色背景上白字看不清楚，改用深色字。 */
function textColor(hex: string): string {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#1F2328' : '#FFFFFF';
}

/**
 * 行號旁的書籤圖示（16×16 SVG）：書籤形狀，函式書籤加白色星星；有號碼時改顯示號碼；
 * 需確認（lost）固定填中性灰並顯示問號（有號碼時也顯示問號）。
 */
export function gutterSvg(kind: GutterKind, hex: string, n?: number): string {
  const fill = kind === 'lost' ? LOST_HEX : hex;
  const fg = textColor(fill);
  let inner = '';
  if (kind === 'lost') {
    inner = `<text x="8" y="9.6" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="8.5" font-weight="700" fill="${fg}">?</text>`;
  } else if (n) {
    inner = `<text x="8" y="9.6" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="8.5" font-weight="700" fill="${fg}">${n}</text>`;
  } else if (kind === 'favorite') {
    inner = `<path d="${STAR}" fill="${fg}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="${SHAPE}" fill="${fill}"/>${inner}</svg>`;
}

/** 給 gutterIconPath 用的 data URI（base64，避免特殊字元被編碼）。 */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/** 捲軸（概觀尺規）書籤標記的顯示位置設定值。 */
export type ScrollbarMarker = 'left' | 'center' | 'right' | 'full' | 'off';

/** 與 vscode.OverviewRulerLane 對應的數值（純模組不匯入 vscode，方便單元測試）。 */
export const OVERVIEW_RULER_LANE = {
  left: 1,
  center: 2,
  right: 4,
  full: 7,
} as const;

export type OverviewRulerLaneValue = (typeof OVERVIEW_RULER_LANE)[keyof typeof OVERVIEW_RULER_LANE];

export interface OverviewRulerOptions {
  overviewRulerLane?: OverviewRulerLaneValue;
  overviewRulerColor?: string;
}

/**
 * 依 `functionBookmarks.bookmarks.scrollbarMarker` 設定值，轉成編輯器裝飾的概觀尺規選項。
 * - `off`：不給 `overviewRulerLane` 與 `overviewRulerColor`（捲軸不顯示標記）
 * - `left`／`center`／`right`／`full`：對應 OverviewRulerLane 的 Left / Center / Right / Full
 * - 無效值或未設定：視為預設 `left`
 */
export function overviewRulerOptions(setting: unknown, color: string): OverviewRulerOptions {
  switch (setting) {
    case 'off':
      return {};
    case 'center':
      return { overviewRulerLane: OVERVIEW_RULER_LANE.center, overviewRulerColor: color };
    case 'right':
      return { overviewRulerLane: OVERVIEW_RULER_LANE.right, overviewRulerColor: color };
    case 'full':
      return { overviewRulerLane: OVERVIEW_RULER_LANE.full, overviewRulerColor: color };
    case 'left':
    default:
      return { overviewRulerLane: OVERVIEW_RULER_LANE.left, overviewRulerColor: color };
  }
}
