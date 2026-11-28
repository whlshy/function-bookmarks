/**
 * 共用核心：偵測一個檔案的函式，並算出書籤現在在哪、狀態為何。
 * 不依賴編輯器：套件在背景確認函式書籤時用，CLI 在編輯器外查書籤時也用同一套規則。
 */
import { relocateBookmarks } from '../bookmarks/relocate';
import { LineBookmark, makeAnchor, newBookmarkId } from '../bookmarks/model';
import { detectSymbols, findByPath, findInnermost } from '../detection/engine';
import { DetectedSymbol, DetectionResult } from '../detection/types';
import { StoreData, SymbolMark, updateLine } from '../storage/marks';
import { reconcileFile } from '../storage/reconcile';
import { applicableRules, ruleAppliesTo, Settings } from './settings';

/** 函式書籤的狀態：找得到、檔案在但找不到函式、檔案不在（或讀不到）。 */
export type FavoriteStatus = 'ok' | 'missing' | 'noFile';

/** 這個檔案在目前設定下，內建或自訂規則能不能偵測（不能的話套件會改問語言伺服器）。 */
export function rulesCover(settings: Settings, languageId: string | undefined, rel: string, fullPath: string): boolean {
  if (!languageId || settings.source !== 'rules') {
    return false;
  }
  return applicableRules(settings.rules, languageId, rel, fullPath).length > 0;
}

/** 用規則偵測一個檔案的函式（不含語言伺服器）。 */
export function detectWithRules(text: string, languageId: string, settings: Settings, rel: string, fullPath: string): DetectionResult {
  return detectSymbols(text, languageId, settings.rules, { isApplicable: (rule) => ruleAppliesTo(rule, rel, fullPath) });
}

/** 名稱剛好在這一行的符號（函式、類別、block…）；同一行有多個時取最內層。新增書籤時有就建立函式書籤。 */
export function symbolAtNameLine(symbols: DetectedSymbol[], line: number): DetectedSymbol | undefined {
  let hit: DetectedSymbol | undefined;
  const walk = (list: DetectedSymbol[]) => {
    for (const s of list) {
      if (s.nameLine === line && s.kind !== 'reference') {
        hit = s;
      }
      walk(s.children);
    }
  };
  walk(symbols);
  return hit;
}

/** 建立一筆新的行號書籤（含記得的內容與所在函式，之後檔案改動時靠它們找回位置）。 */
export function newLineBookmark(lines: string[], symbols: DetectedSymbol[], file: string, line: number, label?: string, now = new Date()): LineBookmark {
  const sym = findInnermost(symbols, line);
  const bm: LineBookmark = {
    id: newBookmarkId(),
    file,
    line,
    anchor: makeAnchor(lines, line, sym?.path, sym?.startLine),
    createdAt: now.toISOString(),
  };
  if (label?.trim()) {
    bm.label = label.trim();
  }
  return bm;
}

/** 依名稱路徑找函式書籤目前的位置；`symbols` 為 undefined 表示讀不到檔案。 */
export function resolveFavorite(
  mark: Pick<SymbolMark, 'path' | 'kind'>,
  symbols: DetectedSymbol[] | undefined,
): { symbol?: DetectedSymbol; status: FavoriteStatus } {
  if (!symbols) {
    return { status: 'noFile' };
  }
  const symbol = findByPath(symbols, mark.path, mark.kind);
  return symbol ? { symbol, status: 'ok' } : { status: 'missing' };
}

/** 函式找得到、但記錄的行號已經不同的標記（記住最新行號，之後找不到時還能跳到大概的位置）。 */
export function favoriteLineUpdates<T extends { mark: SymbolMark; symbol?: DetectedSymbol }>(resolved: T[]): { item: T; line: number }[] {
  return resolved.filter((r) => r.symbol && r.mark.line !== r.symbol.nameLine).map((r) => ({ item: r, line: r.symbol!.nameLine }));
}

/**
 * 依一個檔案最新的偵測結果整理書籤資料：函式改名接回（reconcileFile），找得到的函式更新最後已知行號。
 * 沒有變化時回傳原物件。
 */
export function syncFileMarks(data: StoreData, file: string, symbols: DetectedSymbol[]): StoreData {
  let next = reconcileFile(data, file, symbols);
  for (const mark of next.symbols.filter((m) => m.file === file)) {
    const { symbol } = resolveFavorite(mark, symbols);
    if (symbol && mark.line !== symbol.nameLine) {
      next = updateLine(next, mark, symbol.nameLine);
    }
  }
  return next;
}

/**
 * 沒有檔案前後版本可比對時（例如 CLI 在編輯器外讀取），用記得的內容確認行號書籤的位置：
 * 記錄的行內容相同就不動；不同就在附近找記得的內容，找不到標成需確認。
 * 沒有記得內容（anchor）的書籤只把行號限制在檔案範圍內。
 */
export function checkLineBookmarks(
  bookmarks: Pick<LineBookmark, 'id' | 'line' | 'anchor' | 'status'>[],
  lines: string[],
  symbols: DetectedSymbol[] = [],
): { id: string; line: number; status?: 'lost' }[] {
  const symbolStart = (p: string) => findByPath(symbols, p)?.startLine;
  const withAnchor = bookmarks.filter((b) => b.anchor);
  const found = new Map(relocateBookmarks(withAnchor, undefined, lines, symbolStart).map((r) => [r.id, r]));
  const last = Math.max(0, lines.length - 1);
  return bookmarks.map((b) => found.get(b.id) ?? { id: b.id, line: Math.min(Math.max(0, b.line), last) });
}
