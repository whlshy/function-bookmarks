import { BookmarkStatus, LineBookmark, LineChange } from './model';

/** 刪行時被影響的書籤：刪除前的位置與狀態，以及刪除後被移到的行。 */
export interface MovedByDelete {
  id: string;
  line: number;
  status?: BookmarkStatus;
  afterLine: number;
}

/** 一次刪行編輯，以及因此移動或被刪掉的書籤。 */
export interface DeletionRecord {
  /** 刪除這次編輯（編輯前的座標）。 */
  change: LineChange;
  moved: MovedByDelete[];
  /** onLineDelete = remove 時被刪掉的書籤（整筆保留，復原時放回去）。 */
  removed: LineBookmark[];
}

const MAX_RECORDS = 30;

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      n++;
    }
  }
  return n;
}

/** `undo` 是不是剛好還原 `del` 這次刪行：在同一個位置插回同樣行數的內容。 */
export function isUndoOf(undo: LineChange, del: LineChange): boolean {
  const removedLines = del.endLine - del.startLine;
  return (
    removedLines > 0 &&
    undo.startLine === del.startLine &&
    undo.startChar === del.startChar &&
    undo.endLine === undo.startLine &&
    undo.endChar === undo.startChar &&
    countNewlines(undo.text) === removedLines
  );
}

/**
 * 記住每個檔案最近幾次「刪掉書籤所在行」的編輯，讓復原（Undo）時能把書籤放回原本那一行。
 * 刪行時書籤依 onLineDelete 移到下一行、標成需要檢查或被刪除；單純照行號平移的話，
 * 復原插回那一行時書籤會停在下一行，不會自己回來。
 */
export class DeletionMemory {
  private readonly records = new Map<string, DeletionRecord[]>();

  remember(key: string, record: DeletionRecord): void {
    if (!record.moved.length && !record.removed.length) {
      return;
    }
    const list = this.records.get(key) ?? [];
    list.push(record);
    if (list.length > MAX_RECORDS) {
      list.splice(0, list.length - MAX_RECORDS);
    }
    this.records.set(key, list);
  }

  /**
   * 找出這次復原還原的是哪一次刪行（取最近的一筆）並取出。
   * 比它更新的紀錄代表那些刪除已用別的方式還原或不再適用，一併丟掉。
   */
  takeUndo(key: string, undo: LineChange): DeletionRecord | undefined {
    const list = this.records.get(key);
    if (!list) {
      return undefined;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (isUndoOf(undo, list[i].change)) {
        const [record] = list.splice(i);
        if (!list.length) {
          this.records.delete(key);
        }
        return record;
      }
    }
    return undefined;
  }

  forget(key: string): void {
    this.records.delete(key);
  }
}
