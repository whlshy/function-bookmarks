/** 書籤項目的搜尋欄位、排序與不重複計數（側邊欄與快速搜尋共用）。 */
import { bookmarkTitle } from '../bookmarks/commands';
import { SearchFields } from '../bookmarks/filter';
import { compareByCreated, compareByTitle, lineBookmarkTitle, symbolBookmarkTitle } from '../bookmarks/sort';
import { BookmarkItem } from '../bookmarks/unified';

/** 同檔案內的書籤依側邊欄顯示名稱正序排序（函式書籤與行號書籤混排，不含圈號前綴）。 */
export function compareBookmarkItemsByTitle(a: BookmarkItem, b: BookmarkItem): number {
  return compareByTitle(
    a.kind === 'line'
      ? { kind: 'line', title: lineBookmarkTitle(a.entry.bookmark), line: a.line }
      : { kind: 'symbol', title: symbolBookmarkTitle(a.fav.mark), line: a.line },
    b.kind === 'line'
      ? { kind: 'line', title: lineBookmarkTitle(b.entry.bookmark), line: b.line }
      : { kind: 'symbol', title: symbolBookmarkTitle(b.fav.mark), line: b.line },
  );
}

/** 同檔案內的書籤依建立時間由舊到新排序（沒有建立時間排最後，相同時依行號）。 */
export function compareBookmarkItemsByCreated(a: BookmarkItem, b: BookmarkItem): number {
  return compareByCreated(
    a.kind === 'line'
      ? { kind: 'line', line: a.line, createdAt: a.entry.bookmark.createdAt }
      : { kind: 'symbol', line: a.line, createdAt: a.fav.mark.addedAt },
    b.kind === 'line'
      ? { kind: 'line', line: b.line, createdAt: b.entry.bookmark.createdAt }
      : { kind: 'symbol', line: b.line, createdAt: b.fav.mark.addedAt },
  );
}

/** 搜尋列比對的欄位：名稱、標籤、檔名、所在函式、那一行的程式碼、備註、來源。 */
export function searchFields(i: BookmarkItem): SearchFields {
  if (i.kind === 'line') {
    const b = i.entry.bookmark;
    return {
      names: [bookmarkTitle(b)],
      tags: b.tags ?? [],
      author: b.source?.author ?? '',
      file: b.file,
      func: b.anchor?.symbolPath ?? b.symbol?.path,
      line: b.anchor?.text,
      note: b.note,
    };
  }
  const m = i.fav.mark;
  const name = m.path.split('.').pop() ?? m.path;
  return {
    names: m.alias ? [m.alias, name] : [name],
    tags: m.tags ?? [],
    author: '',
    file: m.file,
    func: m.path,
    note: m.note,
  };
}

/** 依標籤分組時同一個書籤會出現在多個分組：計數只算一次。 */
export function distinctCount(items: BookmarkItem[]): number {
  return new Set(items.map((i) => (i.kind === 'line' ? `l:${i.entry.bookmark.id}` : `f:${i.fav.uri.toString()}::${i.fav.mark.kind}:${i.fav.mark.path}`))).size;
}
