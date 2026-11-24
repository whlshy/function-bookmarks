/**
 * 側邊欄「書籤」依檔案分組的排序邏輯（純函式，不依賴 vscode，方便單元測試）。
 */
import { LineBookmark } from './model';

/** 單一檔案底下書籤的排序方式：依行號（預設）或依標題正序。 */
export type FileBookmarkSort = 'line' | 'title';

/** 可參與同檔案內排序的書籤資訊。 */
export interface SortableBookmark {
  kind: 'line' | 'symbol';
  /** 側邊欄顯示的名稱（有自訂名稱用自訂名稱；不含數字書籤的圈號前綴）。 */
  title: string;
  /** 0 起算的行號；函式書籤找不到時為 undefined。 */
  line?: number;
}

/** 自然排序（數字依大小，如 item2 在 item10 前）、不分大小寫、支援中英文。 */
const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** 取得行號書籤的顯示名稱（有自訂名稱用自訂名稱，不含數字書籤的圈號前綴）。 */
export function lineBookmarkTitle(b: Pick<LineBookmark, 'label' | 'symbol' | 'anchor' | 'line'>): string {
  return b.label ?? (b.symbol ? (b.symbol.path.split('.').pop() ?? b.symbol.path) : undefined) ?? (b.anchor?.text || `#${b.line + 1}`);
}

/** 取得函式書籤的顯示名稱（有自訂名稱用自訂名稱，不含數字書籤的圈號前綴）。 */
export function symbolBookmarkTitle(mark: { path: string; alias?: string }): string {
  return mark.alias ?? (mark.path.split('.').pop() ?? mark.path);
}

/**
 * 同檔案內依標題正序比較：
 * - 自然排序、不分大小寫、支援中英文
 * - 名稱相同時依行號（找不到行號的排最後）
 * - 行號也相同時函式書籤排在行號書籤前（與 compareItems 一致）
 */
export function compareByTitle(a: SortableBookmark, b: SortableBookmark): number {
  return (
    titleCollator.compare(a.title, b.title) ||
    (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
    (a.kind === b.kind ? 0 : a.kind === 'symbol' ? -1 : 1)
  );
}
