import { findByPath } from '../detection/engine';
import { DetectedSymbol } from '../detection/types';
import { StoreData, SymbolMark } from './marks';

/** 改名後最多往上下找幾行。 */
export const RENAME_LINE_WINDOW = 3;

function flatten(list: DetectedSymbol[], out: DetectedSymbol[] = []): DetectedSymbol[] {
  for (const s of list) {
    out.push(s);
    flatten(s.children, out);
  }
  return out;
}

const keyOf = (path: string, kind: string) => `${kind}\u0000${path}`;

/**
 * 依最新偵測結果整理某個檔案的函式標記（書籤、自訂名稱、備註、標籤）：
 * - 用名稱路徑找得到：更新最後已知行號
 * - 找不到（程式碼中改了名稱）：在最後已知行號找同種類的符號（同一行優先，其次上下 3 行內），
 *   只有唯一候選、且新路徑沒被其他標記占用時，把標記轉到新路徑
 * 沒有變化時回傳原物件。
 */
export function reconcileFile(data: StoreData, file: string, symbols: DetectedSymbol[]): StoreData {
  const marks = data.symbols.filter((m) => m.file === file);
  if (marks.length === 0) {
    return data;
  }
  const all = flatten(symbols).filter((s) => s.kind !== 'reference');
  const used = new Set(marks.map((m) => keyOf(m.path, m.kind)));
  const updates = new Map<SymbolMark, Partial<SymbolMark>>();

  // 先處理找得到的，記下它們占用的符號，改名比對時不會搶到
  const missing: SymbolMark[] = [];
  for (const m of marks) {
    const hit = findByPath(symbols, m.path, m.kind);
    if (hit && hit.kind === m.kind) {
      if (m.line !== hit.nameLine) {
        updates.set(m, { line: hit.nameLine });
      }
    } else {
      missing.push(m);
    }
  }

  for (const m of missing) {
    if (m.line === undefined) {
      continue;
    }
    const near = all.filter(
      (s) => s.kind === m.kind && Math.abs(s.nameLine - m.line!) <= RENAME_LINE_WINDOW && !used.has(keyOf(s.path, s.kind)),
    );
    const sameLine = near.filter((s) => s.nameLine === m.line);
    const candidates = sameLine.length ? sameLine : near;
    if (candidates.length !== 1) {
      continue; // 沒有或有好幾個候選：不猜，維持「找不到函式」
    }
    const target = candidates[0];
    used.delete(keyOf(m.path, m.kind));
    used.add(keyOf(target.path, target.kind));
    updates.set(m, { path: target.path, line: target.nameLine });
  }

  if (updates.size === 0) {
    return data;
  }
  return {
    ...data,
    symbols: data.symbols.map((m) => {
      const u = updates.get(m);
      return u ? { ...m, ...u } : m;
    }),
  };
}
