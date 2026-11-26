/** 跨資料夾的書籤統計：來源、標籤、標籤顏色與號碼（MarkStore 的查詢用）。 */
import type * as vscode from 'vscode';
import type { BookmarkEntry, FavoriteEntry, NumberedEntry } from './store';
import type { StoreData } from './marks';

/** 一個工作區資料夾與它的書籤資料（依工作區資料夾順序）。 */
export interface FolderData {
  folder: vscode.WorkspaceFolder;
  data: StoreData | undefined;
}

/** 所有出現過的匯入來源（不含自己），依名稱排序。 */
export function collectSources(datas: Iterable<StoreData>): string[] {
  const out = new Set<string>();
  for (const d of datas) {
    for (const b of d.bookmarks ?? []) {
      if (b.source) {
        out.add(b.source.author);
      }
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** 行號書籤與函式書籤使用過的標籤，去重並排序。 */
export function collectTags(bookmarks: BookmarkEntry[], favorites: FavoriteEntry[]): string[] {
  const out = new Set<string>();
  for (const e of bookmarks) {
    for (const t of e.bookmark.tags ?? []) {
      out.add(t);
    }
  }
  for (const f of favorites) {
    for (const t of f.mark.tags ?? []) {
      out.add(t);
    }
  }
  return [...out].sort();
}

/** 所有資料夾的標籤顏色（同一個標籤在不同資料夾設了不同顏色時，以第一個資料夾為準）。 */
export function collectTagColors(folders: FolderData[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { data } of folders) {
    for (const [tag, color] of Object.entries(data?.tagColors ?? {})) {
      if (!out.has(tag)) {
        out.set(tag, color);
      }
    }
  }
  return out;
}

/** 已經用掉的號碼：號碼 → 書籤（行號書籤或函式書籤）。包含目前隱藏的書籤（號碼仍被佔用）。 */
export function collectNumbered(
  folders: FolderData[],
  uriOf: (folder: vscode.WorkspaceFolder, rel: string) => vscode.Uri,
): Map<number, NumberedEntry> {
  const out = new Map<number, NumberedEntry>();
  for (const { folder, data } of folders) {
    for (const bookmark of data?.bookmarks ?? []) {
      if (bookmark.number && !out.has(bookmark.number)) {
        out.set(bookmark.number, { kind: 'line', folder, uri: uriOf(folder, bookmark.file), bookmark });
      }
    }
    for (const mark of data?.symbols ?? []) {
      if (mark.favorite && mark.number && !out.has(mark.number)) {
        out.set(mark.number, { kind: 'symbol', folder, uri: uriOf(folder, mark.file), mark });
      }
    }
  }
  return out;
}
