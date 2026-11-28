/**
 * 行號書籤（M3）。位置以行號記錄，另存 anchor（該行內容、前後幾行、所在函式），
 * 給之後的 git 換算與後備定位（M4、M5）使用。
 */

export interface BookmarkAnchor {
  /** 該行內容（去掉頭尾空白）。 */
  text: string;
  before: string[];
  after: string[];
  /** 所在函式的名稱路徑與距離函式開頭的行數。 */
  symbolPath?: string;
  symbolOffset?: number;
}

export interface LineBookmark {
  id: string;
  /** 相對於工作區資料夾、以 / 分隔的路徑。 */
  file: string;
  /** 0 起算。 */
  line: number;
  label?: string;
  tags?: string[];
  /** 多行備註（Markdown）。 */
  note?: string;
  anchor?: BookmarkAnchor;
  /**
   * lost：找不到原本那一行（被刪除、改動太多、在合併衝突範圍內），需要確認。
   * notOnBranch：切換分支後，這段程式碼（或整個檔案）不在目前的分支；切回去會自動恢復。
   */
  status?: BookmarkStatus;
  /** 各分支最後確認的位置（離開該分支時記下，切回來時以那時的內容換算）。鍵為分支名稱。 */
  positions?: Record<string, BranchPosition>;
  /** `branch`：只屬於 `homeBranch`，在其他分支隱藏。沒有設定即所有分支都顯示。 */
  scope?: 'branch';
  homeBranch?: string;
  /** 從別人匯入的書籤：來源註記。自己的書籤沒有。 */
  source?: BookmarkSource;
  /** 從別人的「函式書籤」匯入：函式的名稱路徑與種類（顯示用；位置照行號書籤跟隨）。 */
  symbol?: { path: string; kind: string };
  /** 數字快速書籤 1～9（整個視窗內不重複）。 */
  number?: number;
  /** 書籤顏色（色盤 id，見 decor.ts）；沒有設定時用標籤的顏色。 */
  color?: string;
  createdAt?: string;
}

export type BookmarkStatus = 'ok' | 'lost' | 'notOnBranch';

/** 從別人匯入的書籤的來源註記。 */
export interface BookmarkSource {
  /** 匯入時輸入的來源註記（例如 alex.chen）；同一個註記視為同一個來源。 */
  author: string;
  /** 這次匯入的批次。 */
  importId: string;
  /** 對方的書籤 id（合併時用來比對）。 */
  originalId: string;
  importedAt: string;
}

/** 書籤屬於哪個來源：自己的為空字串。 */
export function sourceOf(b: { source?: BookmarkSource }): string {
  return b.source?.author ?? '';
}

export interface BranchPosition {
  line: number;
  status?: 'lost' | 'notOnBranch';
}

/** 書籤在目前分支是否顯示（只屬於別的分支的書籤隱藏）。`branch` 為 undefined：不是 git 專案或 detached HEAD。 */
export function visibleOnBranch(b: Pick<LineBookmark, 'scope' | 'homeBranch'>, branch: string | undefined): boolean {
  return b.scope !== 'branch' || !b.homeBranch || b.homeBranch === branch;
}

export type OnLineDelete = 'moveToNext' | 'markLost' | 'remove';

/** 一次編輯（與 VS Code 的 TextDocumentContentChangeEvent 相同，座標為編輯前的文件）。 */
export interface LineChange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  text: string;
  /** 插入點之前（同一行）只有空白：例如游標在縮排後面按 Enter。由呼叫端依文件內容判斷。 */
  blankBefore?: boolean;
}

export interface ShiftResult {
  line: number;
  /** 書籤所在的行在這次編輯中被刪除。 */
  deleted: boolean;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      n++;
    }
  }
  return n;
}

/**
 * 依一次編輯換算書籤行號：
 * - 編輯範圍之前：不變
 * - 編輯範圍之後：加上增減的行數
 * - 在該行開頭插入整行（例如在行首按 Enter），或插入點前只有縮排（在縮排後面按 Enter）：書籤跟著原本的內容往下
 * - 該行被整行刪除：移到刪除範圍之後的那一行，並標記 deleted
 */
export function shiftLine(line: number, change: LineChange): ShiftResult {
  const inserted = countNewlines(change.text);
  const removed = change.endLine - change.startLine;
  const delta = inserted - removed;
  if (line < change.startLine) {
    return { line, deleted: false };
  }
  if (line > change.endLine || (line === change.endLine && change.endChar === 0 && change.endLine > change.startLine)) {
    return { line: line + delta, deleted: false };
  }
  if (line === change.startLine) {
    const pureInsert = change.startLine === change.endLine && change.startChar === change.endChar;
    // 插入的文字以換行（可再接自動縮排）結尾，原本這一行的內容整個被推到下一行
    if (pureInsert && (change.startChar === 0 || change.blankBefore) && /\n[ \t]*$/.test(change.text)) {
      return { line: line + inserted, deleted: false };
    }
    // 整行刪除（例如 Ctrl+Shift+K，範圍從該行第 0 欄到下一行以上且替換為空字串）：視為刪除這一行
    if (change.startChar === 0 && change.endLine > change.startLine && change.text === '') {
      return { line, deleted: true };
    }
    return { line, deleted: false };
  }
  // startLine < line <= endLine：這一行整行在刪除範圍內
  return { line: change.startLine + inserted, deleted: true };
}

/**
 * 套用一批編輯（多游標時會有多筆）。由下往上套用，座標才不會互相影響。
 * 回傳 undefined 表示書籤應被移除（onLineDelete = remove）。
 */
export function applyChanges(
  bookmark: Pick<LineBookmark, 'line' | 'status'>,
  changes: LineChange[],
  onDelete: OnLineDelete,
): { line: number; status?: BookmarkStatus } | undefined {
  let line = bookmark.line;
  let deleted = false;
  const ordered = [...changes].sort((a, b) => b.startLine - a.startLine || b.startChar - a.startChar);
  for (const c of ordered) {
    const r = shiftLine(line, c);
    line = r.line;
    deleted = deleted || r.deleted;
  }
  if (deleted) {
    if (onDelete === 'remove') {
      return undefined;
    }
    return { line, status: onDelete === 'markLost' ? 'lost' : bookmark.status };
  }
  return { line, status: bookmark.status };
}

export function sortBookmarks<T extends Pick<LineBookmark, 'file' | 'line'>>(list: T[]): T[] {
  return [...list].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** 上下跳轉沒有候選目標時的空狀態原因（供狀態列提示使用）。 */
export type NavigationEmptyReason = 'noMatch' | 'noBookmarksInFile' | 'noBookmarks';

export interface NavigationFilterOptions<T> {
  /** 取得項目所屬檔案的識別鍵（例如 folderIndex/rel）。 */
  fileKey: (item: T) => string;
  /** 目前作用中檔案的識別鍵；未開啟或不在工作區內時為 undefined。 */
  currentFile?: string;
  /** 是否限制只在目前檔案內跳轉（navigationScope = currentFile 且有作用中編輯器）。 */
  currentFileOnly?: boolean;
  /** 側邊欄搜尋列的比對函式；沒有搜尋時為 undefined。 */
  searchMatch?: (item: T) => boolean;
}

export interface NavigationPool<T> {
  /** 符合所有條件（有行號、搜尋篩選、檔案範圍）的候選書籤。 */
  items: T[];
  /** 側邊欄搜尋篩選是否啟用。 */
  searchActive: boolean;
  /** items 為空時的提示原因；有候選時為 undefined。 */
  emptyReason?: NavigationEmptyReason;
}

/**
 * 篩選「下一個／上一個書籤」的候選清單：
 * 1. 排除沒有行號的項目（例如找不到的函式書籤）。
 * 2. 搜尋啟用時套用與側邊欄相同的比對函式。
 * 3. currentFileOnly 為 true 時同時限制在目前檔案。
 */
export function filterNavigationItems<T extends { line?: number }>(
  all: readonly T[],
  options: NavigationFilterOptions<T>,
): NavigationPool<T & { line: number }> {
  const withLine = all.filter((i): i is T & { line: number } => i.line !== undefined);
  const searchActive = options.searchMatch !== undefined;
  const matched = options.searchMatch ? withLine.filter(options.searchMatch) : withLine;
  const currentFileOnly = Boolean(options.currentFileOnly);
  const items = currentFileOnly
    ? options.currentFile !== undefined
      ? matched.filter((i) => options.fileKey(i) === options.currentFile)
      : []
    : matched;
  if (items.length > 0) {
    return { items, searchActive };
  }
  let emptyReason: NavigationEmptyReason;
  if (searchActive) {
    const hasInCurrentFile =
      currentFileOnly && options.currentFile !== undefined && withLine.some((i) => options.fileKey(i) === options.currentFile);
    // currentFile 模式下，其他檔案有符合搜尋但目前檔案本身完全沒有書籤時提示目前檔案無書籤；
    // 若目前檔案有書籤但不符合搜尋（或整個專案都沒有符合搜尋的書籤），提示沒有符合搜尋的書籤
    emptyReason = currentFileOnly && matched.length > 0 && !hasInCurrentFile ? 'noBookmarksInFile' : 'noMatch';
  } else {
    emptyReason = currentFileOnly ? 'noBookmarksInFile' : 'noBookmarks';
  }
  return { items, searchActive, emptyReason };
}

/**
 * 下一個／上一個書籤（跨檔案，依檔名、行號排序，預設頭尾相接）。
 * `file`、`line` 是目前游標位置；沒有開檔時從第一個（或最後一個）開始。
 * `wrap` 為 `false` 時，到最後一個（或第一個）不再循環，改回傳 `undefined`。
 */
export function neighbor<T extends Pick<LineBookmark, 'file' | 'line'>>(
  list: T[],
  file: string | undefined,
  line: number,
  direction: 1 | -1,
  wrap = true,
): T | undefined {
  const sorted = sortBookmarks(list);
  if (sorted.length === 0) {
    return undefined;
  }
  if (file === undefined) {
    return direction === 1 ? sorted[0] : sorted[sorted.length - 1];
  }
  const cmp = (b: T) => b.file.localeCompare(file) || b.line - line;
  if (direction === 1) {
    return sorted.find((b) => cmp(b) > 0) ?? (wrap ? sorted[0] : undefined);
  }
  return [...sorted].reverse().find((b) => cmp(b) < 0) ?? (wrap ? sorted[sorted.length - 1] : undefined);
}

/**
 * 計算依方向循環走訪步驟的候選索引順序（從起點往指定方向繞一圈，共 `length` 個）。
 * `currentIndex` 不在範圍內（例如 -1）時，正向從 0 開始、反向從最後一個開始。
 */
export function tourCandidateIndices(length: number, currentIndex: number, direction: 1 | -1): number[] {
  if (length <= 0) {
    return [];
  }
  const start =
    currentIndex < 0 || currentIndex >= length
      ? direction === 1
        ? 0
        : length - 1
      : ((currentIndex + direction) % length + length) % length;
  const order: number[] = [];
  for (let offset = 0; offset < length; offset++) {
    order.push(((start + offset * direction) % length + length) % length);
  }
  return order;
}

/**
 * 依方向在導覽步驟中找第一個可用（例如檔案仍存在於磁碟）的步驟；全部都不可用時回傳 `undefined`。
 */
export async function findAvailableTourStep<T>(
  steps: readonly T[],
  currentIndex: number,
  direction: 1 | -1,
  isAvailable: (step: T, index: number) => Promise<boolean> | boolean,
): Promise<{ step: T; index: number } | undefined> {
  for (const index of tourCandidateIndices(steps.length, currentIndex, direction)) {
    if (await isAvailable(steps[index], index)) {
      return { step: steps[index], index };
    }
  }
  return undefined;
}

/** 新增書籤時建議的名稱：選取的文字 → 游標所在單字 → 所在函式名稱 → 該行內容。 */
export function suggestName(input: {
  selection?: string;
  word?: string;
  symbolName?: string;
  lineText: string;
}): string {
  const sel = input.selection?.trim();
  if (sel && !sel.includes('\n') && sel.length <= 80) {
    return sel;
  }
  if (input.word?.trim()) {
    return input.word.trim();
  }
  if (input.symbolName) {
    return input.symbolName;
  }
  return input.lineText.trim().slice(0, 80);
}

/** 解析使用者輸入的標籤：以空白或逗號分隔，可加或不加 #，去除重複。 */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[\s,，、]+/)) {
    const t = raw.replace(/^#+/, '').trim();
    if (t && !out.includes(t)) {
      out.push(t);
    }
  }
  return out;
}

export function newBookmarkId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 從整份文字擷取書籤的 anchor（該行與前後各 2 行）。 */
export function makeAnchor(lines: string[], line: number, symbolPath?: string, symbolStartLine?: number): BookmarkAnchor {
  const get = (i: number) => (i >= 0 && i < lines.length ? lines[i].trim() : '');
  return {
    text: get(line),
    before: [get(line - 2), get(line - 1)],
    after: [get(line + 1), get(line + 2)],
    symbolPath,
    symbolOffset: symbolPath !== undefined && symbolStartLine !== undefined ? line - symbolStartLine : undefined,
  };
}

/** 整份文件被換掉（重新從磁碟載入、git pull、格式化工具）：先不平移，交給 M4 的 git 換算處理。 */
export function isWholeDocumentReplace(changes: LineChange[], newLineCount: number): boolean {
  if (changes.length !== 1) {
    return false;
  }
  const c = changes[0];
  const removed = c.endLine - c.startLine;
  const inserted = c.text.split('\n').length - 1;
  const oldLineCount = newLineCount - inserted + removed;
  return c.startLine === 0 && c.startChar === 0 && removed >= 5 && removed >= Math.floor(oldLineCount * 0.9) - 1;
}

/**
 * 多行換成多行（Cursor 套用 AI 修改、貼上覆蓋多行、Alt+↑↓ 移動行）：照行號平移會把範圍內的書籤當成被刪除，
 * 改用前後內容比對換算。
 */
export function isBlockReplace(changes: LineChange[]): boolean {
  return changes.some((c) => c.endLine > c.startLine && countNewlines(c.text) > 0);
}
