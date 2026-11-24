/**
 * 側邊欄搜尋列的比對邏輯（純函式，不依賴 vscode，方便單元測試）。
 *
 * 寫法：
 * - 一般文字：不分大小寫、部分比對；空白隔開的每個字都要符合（任一欄位即可）
 * - `#標籤`：只比對標籤；寫多個時每個都要有
 * - `@來源`：只找那個人匯入的書籤；寫多個時符合任一個即可（一個書籤只有一個來源）
 */
export interface BookmarkQuery {
  text: string[];
  tags: string[];
  authors: string[];
}

/** 一個書籤可被搜尋的欄位。 */
export interface SearchFields {
  /** 顯示的名稱，以及其他名稱（例如自訂名稱底下的原本函式名稱）。 */
  names: string[];
  tags: string[];
  /** 來源（匯入時的註記）；自己的書籤為空字串。 */
  author: string;
  /** 相對路徑。 */
  file: string;
  /** 多資料夾工作區時的資料夾名稱（單資料夾時省略）。 */
  folder?: string;
  /** 所在函式（或函式書籤本身）的名稱路徑。 */
  func?: string;
  /** 那一行的程式碼。 */
  line?: string;
  note?: string;
}

export function parseQuery(query: string): BookmarkQuery {
  const q: BookmarkQuery = { text: [], tags: [], authors: [] };
  for (const token of query.trim().toLowerCase().split(/\s+/)) {
    if (!token) {
      continue;
    }
    if (token.startsWith('#')) {
      if (token.length > 1) {
        q.tags.push(token.slice(1));
      }
    } else if (token.startsWith('@')) {
      if (token.length > 1) {
        q.authors.push(token.slice(1));
      }
    } else {
      q.text.push(token);
    }
  }
  return q;
}

export function isEmptyQuery(q: BookmarkQuery): boolean {
  return q.text.length === 0 && q.tags.length === 0 && q.authors.length === 0;
}

const has = (value: string | undefined, term: string) => !!value && value.toLowerCase().includes(term);

export function matchesQuery(q: BookmarkQuery, f: SearchFields): boolean {
  if (!q.tags.every((t) => f.tags.some((tag) => has(tag, t)))) {
    return false;
  }
  if (q.authors.length && !q.authors.some((a) => has(f.author, a))) {
    return false;
  }
  return q.text.every(
    (t) =>
      f.names.some((n) => has(n, t)) ||
      f.tags.some((tag) => has(tag, t)) ||
      has(f.file, t) ||
      has(f.folder, t) ||
      has(f.func, t) ||
      has(f.line, t) ||
      has(f.note, t),
  );
}

/**
 * 文字裡符合搜尋字的位置（[開始, 結束)，已排序並合併重疊），給側邊欄標亮用。
 * 轉小寫後長度會改變的文字（少數特殊字母）不標亮，避免位置錯開。
 */
export function highlightRanges(text: string, terms: string[]): [number, number][] {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) {
    return [];
  }
  const ranges: [number, number][] = [];
  for (const term of terms) {
    if (!term) {
      continue;
    }
    // 從下一個字元繼續找：重疊的出現位置（例如 aaa 裡的 aa）也要標到
    for (let i = lower.indexOf(term); i >= 0; i = lower.indexOf(term, i + 1)) {
      ranges.push([i, i + term.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}
