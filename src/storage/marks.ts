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
  /** 最後已知的名稱所在行（0 起算），找不到函式時的退路。 */
  line?: number;
  addedAt?: string;
}

export interface StoreData {
  version: 1;
  symbols: SymbolMark[];
}

export interface MarkKey {
  file: string;
  path: string;
  kind: SymbolKindName;
}

export function emptyStore(): StoreData {
  return { version: 1, symbols: [] };
}

const KINDS = new Set<string>(['function', 'method', 'class', 'block', 'partial', 'macro', 'reference']);

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
      if (typeof m.line === 'number' && m.line >= 0) {
        mark.line = Math.floor(m.line);
      }
      if (typeof m.addedAt === 'string') {
        mark.addedAt = m.addedAt;
      }
      symbols.push(mark);
    }
  }
  return { version: 1, symbols: prune(symbols) };
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
      if (m.line !== undefined) {
        o.line = m.line;
      }
      if (m.addedAt) {
        o.addedAt = m.addedAt;
      }
      return o;
    });
  return `${JSON.stringify({ version: 1, symbols }, null, 2)}\n`;
}

function same(m: MarkKey, k: MarkKey): boolean {
  return m.file === k.file && m.path === k.path && m.kind === k.kind;
}

/** 沒有收藏也沒有自訂名稱的項目不必保存。 */
function prune(list: SymbolMark[]): SymbolMark[] {
  return list.filter((m) => m.favorite || m.alias);
}

export function findMark(data: StoreData, key: MarkKey): SymbolMark | undefined {
  return data.symbols.find((m) => same(m, key));
}

function upsert(data: StoreData, key: MarkKey, patch: (m: SymbolMark) => SymbolMark): StoreData {
  const existing = findMark(data, key);
  const next = patch(existing ? { ...existing } : { ...key });
  const others = data.symbols.filter((m) => !same(m, key));
  return { version: 1, symbols: prune([...others, next]) };
}

export function setFavorite(data: StoreData, key: MarkKey, favorite: boolean, line?: number, now = new Date()): StoreData {
  return upsert(data, key, (m) => {
    if (favorite) {
      m.favorite = true;
      m.addedAt = m.addedAt ?? now.toISOString();
    } else {
      delete m.favorite;
      delete m.addedAt;
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
  return changed ? { version: 1, symbols } : data;
}

export function favorites(data: StoreData): SymbolMark[] {
  return data.symbols.filter((m) => m.favorite);
}
