import * as vscode from 'vscode';
import { BookmarkEntry, MarkStore } from '../storage/store';
import { FavoritesModel, ResolvedFavorite } from '../symbols/favorites';
import { LineBookmark } from './model';

/**
 * 統一的書籤：一種書籤、兩種對象。
 * - symbol：函式書籤（原本的收藏），跟著名稱路徑走
 * - line：行號書籤，跟著那一行走
 * 側邊欄、上下跳轉、快速搜尋都透過這裡同時取得兩種。
 */
export type BookmarkItem =
  | { kind: 'line'; folder: vscode.WorkspaceFolder; uri: vscode.Uri; file: string; line: number; entry: BookmarkEntry }
  | { kind: 'symbol'; folder: vscode.WorkspaceFolder; uri: vscode.Uri; file: string; line?: number; fav: ResolvedFavorite };

export function allBookmarkItems(store: MarkStore, favorites: FavoritesModel): BookmarkItem[] {
  const items: BookmarkItem[] = [];
  for (const e of store.allBookmarks()) {
    items.push({ kind: 'line', folder: e.folder, uri: e.uri, file: e.bookmark.file, line: e.bookmark.line, entry: e });
  }
  for (const fav of favorites.all) {
    // 函式找不到時沒有行號，排序時放在同檔案的最後
    items.push({ kind: 'symbol', folder: fav.folder, uri: fav.uri, file: fav.mark.file, line: fav.symbol?.nameLine, fav });
  }
  return items;
}

/**
 * 畫面上顯示的書籤（側邊欄、標題計數、跳轉、搜尋、狀態列共用）：套用來源篩選，
 * 行號書籤排除只屬於別的分支的；「不在此分支」的只有 `includeNotOnBranch` 時列出（側邊欄以灰色顯示）。
 */
export function shownBookmarkItems(
  store: MarkStore,
  favorites: FavoritesModel,
  options: { includeNotOnBranch?: boolean } = {},
): BookmarkItem[] {
  const items: BookmarkItem[] = [];
  for (const e of store.shownBookmarks(options)) {
    items.push({ kind: 'line', folder: e.folder, uri: e.uri, file: e.bookmark.file, line: e.bookmark.line, entry: e });
  }
  if (store.favoritesShown) {
    for (const fav of favorites.all) {
      items.push({ kind: 'symbol', folder: fav.folder, uri: fav.uri, file: fav.mark.file, line: fav.symbol?.nameLine, fav });
    }
  }
  return items;
}

export function itemTags(i: BookmarkItem): string[] {
  return (i.kind === 'line' ? i.entry.bookmark.tags : i.fav.mark.tags) ?? [];
}

/** 同一檔案內依行號排序；找不到行號的（函式不見了）排最後。 */
export function compareItems(a: BookmarkItem, b: BookmarkItem): number {
  return (
    a.file.localeCompare(b.file) ||
    (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
    (a.kind === b.kind ? 0 : a.kind === 'symbol' ? -1 : 1)
  );
}

export function lineBookmarkOf(i: BookmarkItem): LineBookmark | undefined {
  return i.kind === 'line' ? i.entry.bookmark : undefined;
}

/** 書籤的來源：自己的（含函式書籤）為空字串。 */
export function itemSource(i: BookmarkItem): string {
  return i.kind === 'line' ? (i.entry.bookmark.source?.author ?? '') : '';
}
