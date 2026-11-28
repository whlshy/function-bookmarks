/**
 * 游標跟隨的目標判斷（純函式，不依賴 vscode，方便單元測試）。
 */
import { findEnclosing } from '../detection/engine';
import { DetectedSymbol } from '../detection/types';

export type FollowSection = 'currentFile' | 'bookmarks';

/** 依目前的篩選模式與「目前檔案」區段展開狀態，決定游標跟隨要標示哪一區。 */
export function chooseFollowSection(
  filterMode: 'all' | 'bookmarks',
  currentFileExpanded: boolean | undefined,
): FollowSection {
  if (filterMode === 'bookmarks' || currentFileExpanded === false) {
    return 'bookmarks';
  }
  return 'currentFile';
}

export type CursorBookmarkTarget =
  | { kind: 'line'; id: string }
  | { kind: 'symbol'; symbol: DetectedSymbol };

export interface CursorBookmarkInput {
  /** 游標這一行的可見行號書籤 id（沒有或被篩選隱藏時為 undefined）。 */
  lineBookmarkId: string | undefined;
  /** 目前檔案偵測到的符號樹。 */
  symbols: DetectedSymbol[];
  /** 游標所在行（0 起算）。 */
  line: number;
  /** 函式書籤目前是否顯示（受來源篩選控制）。 */
  favoritesShown: boolean;
  /** 該符號是否設有函式書籤。 */
  isFavorite: (symbol: DetectedSymbol) => boolean;
}

/**
 * 決定「書籤」區游標跟隨要標示哪一筆書籤：
 * 1. 游標這一行有可見的行號書籤 → 選它
 * 2. 否則由最內層往外層找包住游標的函式（略過 reference），第一個有函式書籤的 → 選它
 * 3. 都沒有 → undefined（不變更選取）
 */
export function chooseCursorBookmarkTarget(input: CursorBookmarkInput): CursorBookmarkTarget | undefined {
  if (input.lineBookmarkId !== undefined) {
    return { kind: 'line', id: input.lineBookmarkId };
  }
  if (!input.favoritesShown) {
    return undefined;
  }
  for (const sym of findEnclosing(input.symbols, input.line)) {
    if (sym.kind === 'reference') {
      continue;
    }
    if (input.isFavorite(sym)) {
      return { kind: 'symbol', symbol: sym };
    }
  }
  return undefined;
}
