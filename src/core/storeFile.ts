/**
 * 共用核心：書籤檔（.vscode/function-bookmarks.json）的內容判讀與寫入前檢查。
 * 不依賴編輯器：套件與 CLI 讀寫同一個檔案，判斷規則必須一致。
 */
import { emptyStore, hasStoreData, parseStore, serializeStore, StoreData } from '../storage/marks';

export { BOOKMARKS_FILE } from '../storage/gitExclude';

/** 讀到的書籤檔內容：沒有檔案或空白、內容壞掉（不是合法 JSON）、正常。 */
export type StoreText = { kind: 'empty'; data: StoreData } | { kind: 'broken' } | { kind: 'ok'; data: StoreData };

/** 判讀書籤檔的文字；`text` 為 undefined 表示沒有這個檔案。 */
export function decodeStoreText(text: string | undefined): StoreText {
  if (text === undefined || text.trim() === '') {
    return { kind: 'empty', data: emptyStore() };
  }
  const data = parseStore(text);
  return data ? { kind: 'ok', data } : { kind: 'broken' };
}

/**
 * 要寫入的內容；沒有任何資料、而且檔案原本不存在時回傳 undefined（不主動建立檔案）。
 * 檔案已存在時仍寫入空清單，否則刪光書籤後重開又會出現。
 */
export function storeTextToWrite(data: StoreData, fileExists: boolean): string | undefined {
  if (!hasStoreData(data) && !fileExists) {
    return undefined;
  }
  return serializeStore(data);
}
