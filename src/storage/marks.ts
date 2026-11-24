import { LineBookmark } from '../bookmarks/model';
import { SymbolKindName } from '../detection/types';

/**
 * 函式層級的標記：收藏、自訂顯示名稱。
 * 以「檔案（相對路徑）＋名稱路徑＋種類」辨識，不依賴行號。
 */
export interface SymbolMark {
  /** 相對於工作區資料夾、以 / 分隔的路徑。 */
  file: string;
  /** 名稱路徑，例如 `ArticleView.get`、`content.form`。 */
  path: string;
  kind: SymbolKindName;
  favorite?: boolean;
  alias?: string;
  /** 多行備註（Markdown），滑鼠移上去時顯示。 */
  note?: string;
  /** 函式書籤的標籤。 */
  tags?: string[];
  /** 數字快速書籤 1～9。 */
  number?: number;
  /** 書籤顏色（色盤 id）。 */
  color?: string;
  /** 最後已知的名稱所在行（0 起算），找不到函式時的退路。 */
  line?: number;
  addedAt?: string;
}

export interface StoreData {
  version: 1;
  symbols: SymbolMark[];
  /** 行號書籤（M3）。 */
  bookmarks: LineBookmark[];
  /** 標籤顏色：標籤 → 色盤 id。 */
  tagColors?: Record<string, string>;
}

export interface MarkKey {
  file: string;
  path: string;
  kind: SymbolKindName;
}

export function emptyStore(): StoreData {
  return { version: 1, symbols: [], bookmarks: [] };
}

/** 這份資料有沒有任何書籤、函式標記或標籤顏色。 */
export function hasStoreData(data: StoreData | undefined): boolean {
  return !!data && (data.symbols.length > 0 || (data.bookmarks ?? []).length > 0 || Object.keys(data.tagColors ?? {}).length > 0);
}

/**
 * 合併兩份書籤資料：以 target 為主，補進 source 裡 target 沒有的函式標記、行號書籤與標籤顏色。
 * 若號碼（1～9）衝突，保留 target 的號碼並移除 source 衝突的號碼，避免產生重複號碼。
 */
export function mergeStoreData(target: StoreData, source: StoreData): StoreData {
  const usedNumbers = new Set<number>();
  for (const m of target.symbols) {
    if (m.favorite && m.number) {
      usedNumbers.add(m.number);
    }
  }
  for (const b of target.bookmarks ?? []) {
    if (b.number) {
      usedNumbers.add(b.number);
    }
  }

  const symbols = [...target.symbols];
  for (const m of source.symbols) {
    if (findMark(target, m)) {
      continue;
    }
    const copy = { ...m };
    if (copy.favorite && copy.number) {
      if (usedNumbers.has(copy.number)) {
        delete copy.number;
      } else {
        usedNumbers.add(copy.number);
      }
    }
    symbols.push(copy);
  }

  const existingIds = new Set((target.bookmarks ?? []).map((b) => b.id));
  const existingLines = new Set(
    (target.bookmarks ?? []).map((b) => `${b.file}\u0000${b.line}\u0000${b.source?.author ?? ''}`),
  );
  const bookmarks = [...(target.bookmarks ?? [])];
  for (const b of source.bookmarks ?? []) {
    const lineKey = `${b.file}\u0000${b.line}\u0000${b.source?.author ?? ''}`;
    if (existingIds.has(b.id) || existingLines.has(lineKey)) {
      continue;
    }
    const copy = { ...b };
    if (copy.number) {
      if (usedNumbers.has(copy.number)) {
        delete copy.number;
      } else {
        usedNumbers.add(copy.number);
      }
    }
    bookmarks.push(copy);
    existingIds.add(copy.id);
    existingLines.add(lineKey);
  }

  const tagColors = { ...(source.tagColors ?? {}), ...(target.tagColors ?? {}) };
  const out: StoreData = { version: 1, symbols: prune(symbols), bookmarks };
  if (Object.keys(tagColors).length) {
    out.tagColors = tagColors;
  }
  return out;
}

const KINDS = new Set<string>(['function', 'method', 'class', 'block', 'partial', 'macro', 'event', 'request', 'heading', 'reference']);

/** 解析書籤檔；格式不對的項目略過，整份壞掉時回傳 undefined。 */
export function parseStore(text: string): StoreData | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const list = (raw as { symbols?: unknown }).symbols;
  const symbols: SymbolMark[] = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const m = item as Record<string, unknown>;
      if (typeof m.file !== 'string' || typeof m.path !== 'string' || typeof m.kind !== 'string' || !KINDS.has(m.kind)) {
        continue;
      }
      const mark: SymbolMark = { file: m.file, path: m.path, kind: m.kind as SymbolKindName };
      if (m.favorite === true) {
        mark.favorite = true;
      }
      if (typeof m.alias === 'string' && m.alias.trim()) {
        mark.alias = m.alias;
      }
      if (typeof m.note === 'string' && m.note.trim()) {
        mark.note = m.note;
      }
      if (Array.isArray(m.tags)) {
        const tags = m.tags.filter((t): t is string => typeof t === 'string' && !!t.trim());
        if (tags.length) {
          mark.tags = tags;
        }
      }
      if (validNumber(m.number)) {
        mark.number = m.number;
      }
      if (typeof m.color === 'string' && m.color) {
        mark.color = m.color;
      }
      if (typeof m.line === 'number' && m.line >= 0) {
        mark.line = Math.floor(m.line);
      }
      if (typeof m.addedAt === 'string') {
        mark.addedAt = m.addedAt;
      }
      symbols.push(mark);
    }
  }
  const out: StoreData = { version: 1, symbols: prune(symbols), bookmarks: parseBookmarks((raw as { bookmarks?: unknown }).bookmarks) };
  const tc = parseTagColors((raw as { tagColors?: unknown }).tagColors);
  if (tc) {
    out.tagColors = tc;
  }
  return out;
}

function validNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 9;
}

function parseTagColors(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [tag, color] of Object.entries(v as Record<string, unknown>)) {
    if (tag && typeof color === 'string' && color) {
      out[tag] = color;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** 輸出時依檔案、路徑排序，讓檔案內容穩定、好比對。 */
export function serializeStore(data: StoreData): string {
  const symbols = [...prune(data.symbols)]
    .sort((a, b) => a.file.localeCompare(b.file) || a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind))
    .map((m) => {
      // 固定欄位順序，避免同樣的資料輸出成不同的檔案內容
      const o: SymbolMark = { file: m.file, path: m.path, kind: m.kind };
      if (m.favorite) {
        o.favorite = true;
      }
      if (m.alias) {
        o.alias = m.alias;
      }
      if (m.note) {
        o.note = m.note;
      }
      if (m.tags?.length) {
        o.tags = m.tags;
      }
      if (m.number) {
        o.number = m.number;
      }
      if (m.color) {
        o.color = m.color;
      }
      if (m.line !== undefined) {
        o.line = m.line;
      }
      if (m.addedAt) {
        o.addedAt = m.addedAt;
      }
      return o;
    });
  const bookmarks = serializeBookmarks(data.bookmarks ?? []);
  const out: Record<string, unknown> = bookmarks.length ? { version: 1, symbols, bookmarks } : { version: 1, symbols };
  const tagColors = Object.entries(data.tagColors ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (tagColors.length) {
    out.tagColors = Object.fromEntries(tagColors);
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

function same(m: MarkKey, k: MarkKey): boolean {
  return m.file === k.file && m.path === k.path && m.kind === k.kind;
}

/** 沒有收藏、自訂名稱、備註的項目不必保存。 */
function prune(list: SymbolMark[]): SymbolMark[] {
  return list.filter((m) => m.favorite || m.alias || m.note);
}

export function findMark(data: StoreData, key: MarkKey): SymbolMark | undefined {
  return data.symbols.find((m) => same(m, key));
}

function upsert(data: StoreData, key: MarkKey, patch: (m: SymbolMark) => SymbolMark): StoreData {
  const existing = findMark(data, key);
  const next = patch(existing ? { ...existing } : { ...key });
  const others = data.symbols.filter((m) => !same(m, key));
  return { ...data, symbols: prune([...others, next]) };
}

export function setFavorite(data: StoreData, key: MarkKey, favorite: boolean, line?: number, now = new Date()): StoreData {
  return upsert(data, key, (m) => {
    if (favorite) {
      m.favorite = true;
      m.addedAt = m.addedAt ?? now.toISOString();
    } else {
      // 取消書籤時標籤、號碼、顏色一併移除（自訂名稱與備註保留）
      delete m.favorite;
      delete m.addedAt;
      delete m.tags;
      delete m.number;
      delete m.color;
    }
    if (line !== undefined) {
      m.line = line;
    }
    return m;
  });
}

/** 設定自訂顯示名稱；空白或與原名相同視為清除。 */
export function setAlias(data: StoreData, key: MarkKey, alias: string | undefined, originalName: string, line?: number): StoreData {
  const value = alias?.trim();
  return upsert(data, key, (m) => {
    if (value && value !== originalName) {
      m.alias = value;
    } else {
      delete m.alias;
    }
    if (line !== undefined) {
      m.line = line;
    }
    return m;
  });
}

/** 設定函式書籤的標籤；空陣列即清除。 */
export function setTags(data: StoreData, key: MarkKey, tags: string[]): StoreData {
  return upsert(data, key, (m) => {
    if (tags.length) {
      m.tags = tags;
    } else {
      delete m.tags;
    }
    return m;
  });
}

/** 取消某個檔案（或全部檔案）的函式書籤；自訂名稱與備註保留。 */
export function unfavoriteFiles(data: StoreData, file?: string): StoreData {
  let changed = false;
  const symbols = data.symbols.map((m) => {
    if (!m.favorite || (file !== undefined && m.file !== file)) {
      return m;
    }
    changed = true;
    const next = { ...m };
    delete next.favorite;
    delete next.addedAt;
    delete next.tags;
    delete next.number;
    delete next.color;
    return next;
  });
  return changed ? { ...data, symbols: prune(symbols) } : data;
}

/** 設定函式書籤的號碼與顏色（null 表示清除；undefined 表示不變）。 */
export function setSymbolExtras(data: StoreData, key: MarkKey, patch: { number?: number | null; color?: string | null }): StoreData {
  return upsert(data, key, (m) => {
    if (patch.number === null) {
      delete m.number;
    } else if (patch.number !== undefined) {
      m.number = patch.number;
    }
    if (patch.color === null) {
      delete m.color;
    } else if (patch.color !== undefined) {
      m.color = patch.color;
    }
    return m;
  });
}

/** 從這份資料拿掉某個號碼（交給別的書籤之前先清掉）；`except` 是要保留號碼的那個書籤。 */
export function clearNumber(data: StoreData, n: number, except?: { bookmarkId?: string; key?: MarkKey }): StoreData {
  let changed = false;
  const symbols = data.symbols.map((m) => {
    if (m.number !== n || (except?.key && same(m, except.key))) {
      return m;
    }
    changed = true;
    const next = { ...m };
    delete next.number;
    return next;
  });
  const bookmarks = (data.bookmarks ?? []).map((b) => {
    if (b.number !== n || b.id === except?.bookmarkId) {
      return b;
    }
    changed = true;
    const next = { ...b };
    delete next.number;
    return next;
  });
  return changed ? { ...data, symbols, bookmarks } : data;
}

/** 設定標籤顏色；color 為 undefined 表示清除。 */
export function setTagColor(data: StoreData, tag: string, color: string | undefined): StoreData {
  const next = { ...(data.tagColors ?? {}) };
  if (color) {
    next[tag] = color;
  } else {
    delete next[tag];
  }
  if (JSON.stringify(next) === JSON.stringify(data.tagColors ?? {})) {
    return data;
  }
  const out: StoreData = { ...data, tagColors: next };
  if (!Object.keys(next).length) {
    delete out.tagColors;
  }
  return out;
}

/** 設定備註；去掉頭尾空白後是空的就清除。保留內部的換行與縮排。 */
export function setNote(data: StoreData, key: MarkKey, note: string | undefined, line?: number): StoreData {
  const value = note?.replace(/\r\n/g, '\n').replace(/^\s*\n/, '').trimEnd();
  return upsert(data, key, (m) => {
    if (value && value.trim()) {
      m.note = value;
    } else {
      delete m.note;
    }
    if (line !== undefined) {
      m.line = line;
    }
    return m;
  });
}

/** 更新最後已知行號；沒有變化時回傳原物件，方便判斷是否需要存檔。 */
export function updateLine(data: StoreData, key: MarkKey, line: number): StoreData {
  const m = findMark(data, key);
  if (!m || m.line === line) {
    return data;
  }
  return upsert(data, key, (x) => ({ ...x, line }));
}

/** 檔案或資料夾改名：`old` 可以是檔案，也可以是資料夾（底下的檔案一起更新）。 */
export function renamePath(data: StoreData, oldRel: string, newRel: string): StoreData {
  let changed = false;
  const symbols = data.symbols.map((m) => {
    if (m.file === oldRel) {
      changed = true;
      return { ...m, file: newRel };
    }
    if (m.file.startsWith(`${oldRel}/`)) {
      changed = true;
      return { ...m, file: newRel + m.file.slice(oldRel.length) };
    }
    return m;
  });
  let bmChanged = false;
  const bookmarks = (data.bookmarks ?? []).map((b) => {
    if (b.file === oldRel) {
      bmChanged = true;
      return { ...b, file: newRel };
    }
    if (b.file.startsWith(`${oldRel}/`)) {
      bmChanged = true;
      return { ...b, file: newRel + b.file.slice(oldRel.length) };
    }
    return b;
  });
  return changed || bmChanged ? { ...data, symbols, bookmarks } : data;
}

export function favorites(data: StoreData): SymbolMark[] {
  return data.symbols.filter((m) => m.favorite);
}

// ---------------- 行號書籤 ----------------

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function parsePositions(v: unknown): LineBookmark['positions'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return undefined;
  }
  const out: NonNullable<LineBookmark['positions']> = {};
  for (const [branch, p] of Object.entries(v as Record<string, unknown>)) {
    const pos = p as Record<string, unknown> | undefined;
    if (!branch || !pos || typeof pos.line !== 'number' || pos.line < 0) {
      continue;
    }
    out[branch] = { line: Math.floor(pos.line) };
    if (pos.status === 'lost' || pos.status === 'notOnBranch') {
      out[branch].status = pos.status;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function parseBookmarks(list: unknown): LineBookmark[] {
  const out: LineBookmark[] = [];
  if (!Array.isArray(list)) {
    return out;
  }
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const b = item as Record<string, unknown>;
    if (typeof b.id !== 'string' || typeof b.file !== 'string' || typeof b.line !== 'number' || b.line < 0) {
      continue;
    }
    const bm: LineBookmark = { id: b.id, file: b.file, line: Math.floor(b.line) };
    if (typeof b.label === 'string' && b.label.trim()) {
      bm.label = b.label;
    }
    const tags = strings(b.tags).filter((t) => t.trim());
    if (tags.length) {
      bm.tags = tags;
    }
    if (typeof b.note === 'string' && b.note.trim()) {
      bm.note = b.note;
    }
    const a = b.anchor as Record<string, unknown> | undefined;
    if (a && typeof a === 'object' && typeof a.text === 'string') {
      bm.anchor = {
        text: a.text,
        before: strings(a.before),
        after: strings(a.after),
        symbolPath: typeof a.symbolPath === 'string' ? a.symbolPath : undefined,
        symbolOffset: typeof a.symbolOffset === 'number' ? a.symbolOffset : undefined,
      };
    }
    if (b.status === 'lost' || b.status === 'notOnBranch') {
      bm.status = b.status;
    }
    const positions = parsePositions(b.positions);
    if (positions) {
      bm.positions = positions;
    }
    if (b.scope === 'branch' && typeof b.homeBranch === 'string' && b.homeBranch) {
      bm.scope = 'branch';
      bm.homeBranch = b.homeBranch;
    }
    const src = b.source as Record<string, unknown> | undefined;
    if (src && typeof src === 'object' && typeof src.author === 'string' && src.author.trim()) {
      bm.source = {
        author: src.author.trim(),
        importId: typeof src.importId === 'string' ? src.importId : '',
        originalId: typeof src.originalId === 'string' ? src.originalId : '',
        importedAt: typeof src.importedAt === 'string' ? src.importedAt : '',
      };
    }
    const sym = b.symbol as Record<string, unknown> | undefined;
    if (sym && typeof sym === 'object' && typeof sym.path === 'string' && typeof sym.kind === 'string') {
      bm.symbol = { path: sym.path, kind: sym.kind };
    }
    if (validNumber(b.number)) {
      bm.number = b.number;
    }
    if (typeof b.color === 'string' && b.color) {
      bm.color = b.color;
    }
    if (typeof b.createdAt === 'string') {
      bm.createdAt = b.createdAt;
    }
    out.push(bm);
  }
  return out;
}

function serializeBookmarks(list: LineBookmark[]): LineBookmark[] {
  return [...list]
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id))
    .map((b) => {
      const o: LineBookmark = { id: b.id, file: b.file, line: b.line };
      if (b.label) {
        o.label = b.label;
      }
      if (b.tags?.length) {
        o.tags = b.tags;
      }
      if (b.note) {
        o.note = b.note;
      }
      if (b.status === 'lost' || b.status === 'notOnBranch') {
        o.status = b.status;
      }
      if (b.scope === 'branch' && b.homeBranch) {
        o.scope = 'branch';
        o.homeBranch = b.homeBranch;
      }
      if (b.source) {
        o.source = { ...b.source };
      }
      if (b.symbol) {
        o.symbol = { ...b.symbol };
      }
      if (b.number) {
        o.number = b.number;
      }
      if (b.color) {
        o.color = b.color;
      }
      if (b.positions && Object.keys(b.positions).length) {
        o.positions = Object.fromEntries(Object.entries(b.positions).sort(([x], [y]) => x.localeCompare(y)));
      }
      if (b.anchor) {
        const a: LineBookmark['anchor'] = { text: b.anchor.text, before: b.anchor.before, after: b.anchor.after };
        if (b.anchor.symbolPath !== undefined) {
          a.symbolPath = b.anchor.symbolPath;
          a.symbolOffset = b.anchor.symbolOffset;
        }
        o.anchor = a;
      }
      if (b.createdAt) {
        o.createdAt = b.createdAt;
      }
      return o;
    });
}

export function findBookmark(data: StoreData, id: string): LineBookmark | undefined {
  return (data.bookmarks ?? []).find((b) => b.id === id);
}

export function addBookmark(data: StoreData, bookmark: LineBookmark): StoreData {
  return { ...data, bookmarks: [...(data.bookmarks ?? []), bookmark] };
}

export function removeBookmarks(data: StoreData, ids: string[]): StoreData {
  const set = new Set(ids);
  const bookmarks = (data.bookmarks ?? []).filter((b) => !set.has(b.id));
  return bookmarks.length === (data.bookmarks ?? []).length ? data : { ...data, bookmarks };
}

/** 修改一個書籤；patch 回傳 undefined 表示刪除。沒有變化時回傳原物件。 */
export function updateBookmark(
  data: StoreData,
  id: string,
  patch: (b: LineBookmark) => LineBookmark | undefined,
): StoreData {
  let changed = false;
  const bookmarks: LineBookmark[] = [];
  for (const b of data.bookmarks ?? []) {
    if (b.id !== id) {
      bookmarks.push(b);
      continue;
    }
    const next = patch({ ...b });
    if (!next) {
      changed = true;
      continue;
    }
    if (JSON.stringify(next) !== JSON.stringify(b)) {
      changed = true;
    }
    bookmarks.push(next);
  }
  return changed ? { ...data, bookmarks } : data;
}

/** 一次修改同一個檔案的所有書籤（編輯時平移行號用）。 */
export function updateBookmarksInFile(
  data: StoreData,
  file: string,
  patch: (b: LineBookmark) => LineBookmark | undefined,
): StoreData {
  let changed = false;
  const bookmarks: LineBookmark[] = [];
  for (const b of data.bookmarks ?? []) {
    if (b.file !== file) {
      bookmarks.push(b);
      continue;
    }
    const next = patch({ ...b });
    if (!next) {
      changed = true;
      continue;
    }
    if (
      next.line !== b.line ||
      next.status !== b.status ||
      next.scope !== b.scope ||
      next.homeBranch !== b.homeBranch ||
      JSON.stringify(next.anchor) !== JSON.stringify(b.anchor) ||
      JSON.stringify(next.positions) !== JSON.stringify(b.positions)
    ) {
      changed = true;
    }
    bookmarks.push(next);
  }
  return changed ? { ...data, bookmarks } : data;
}
