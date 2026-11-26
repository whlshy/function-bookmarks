/** 數字快速書籤、導覽與顏色的指令。 */
import * as vscode from 'vscode';
import { bookmarkNumberArg, booleanArg, nullableStringArg } from '../util/commandArgs';
import { extrasArg, numberArg } from '../util/editorArgs';
import { BookmarkExtras } from './extras';

export function registerExtrasCommands(extras: BookmarkExtras): vscode.Disposable[] {
  const reg = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  return [
    // 行號區右鍵會傳第二參數 `{ preserveFocus: false }`、側邊欄右鍵會傳選取清單：未通過驗證的值一律當成沒傳
    reg('functionBookmarks.setBookmarkNumber', (node?: unknown, value?: unknown, confirmed?: unknown) =>
      extras.setNumber(extrasArg(node), bookmarkNumberArg(value), booleanArg(confirmed)),
    ),
    reg('functionBookmarks.toggleNumberedBookmark', (arg?: unknown, confirmed?: unknown) => {
      const n = numberArg(arg);
      return n === undefined ? extras.setNumber(undefined) : extras.toggleNumber(n, booleanArg(confirmed));
    }),
    reg('functionBookmarks.goToNumberedBookmark', (arg?: unknown) => extras.goToNumber(numberArg(arg))),
    reg('functionBookmarks.tourNext', () => extras.tour(1)),
    reg('functionBookmarks.tourPrevious', () => extras.tour(-1)),
    reg('functionBookmarks.setBookmarkColor', (node?: unknown, value?: unknown) =>
      extras.setColor(extrasArg(node), nullableStringArg(value)),
    ),
    // 標題列（…）與命令選擇區：只接受標籤名稱字串，選取中的樹節點不算（先選標籤）
    reg('functionBookmarks.setTagColor', (arg?: unknown, value?: unknown) =>
      extras.setTagColor(typeof arg === 'string' ? arg : undefined, nullableStringArg(value)),
    ),
    // 側邊欄標籤列（行內按鈕與右鍵）：直接設定該標籤
    reg('functionBookmarks.setColorOfTag', (arg?: unknown, value?: unknown) =>
      extras.setTagColor(arg, nullableStringArg(value)),
    ),
  ];
}
