/** 指令從編輯器、行號右鍵、側邊欄或快捷鍵收到的參數解析。 */
import * as vscode from 'vscode';
import type { BmGroupNode, BookmarkNode } from '../views/tree';
import { uriKey } from './uris';

/** 行號右鍵選單傳入的參數：{ lineNumber（1 起算）, uri }。 */
export function lineArg(arg: unknown): { uri: vscode.Uri; line: number } | undefined {
  const a = arg as { lineNumber?: unknown; uri?: unknown } | undefined;
  return a && typeof a.lineNumber === 'number' && a.uri instanceof vscode.Uri ? { uri: a.uri, line: a.lineNumber - 1 } : undefined;
}

export function isBookmarkNode(n: unknown): n is BookmarkNode {
  return (n as BookmarkNode | undefined)?.type === 'bookmark';
}

/** 號碼、顏色指令的對象：行號右鍵選單傳入 { lineNumber, uri }；編輯器右鍵傳入檔案 Uri（改用游標所在的行）；側邊欄傳入節點。 */
export function extrasArg(arg: unknown): unknown {
  const at = lineArg(arg);
  return at ? { type: 'line', ...at } : arg instanceof vscode.Uri ? undefined : arg;
}

/** 快捷鍵傳入 { number: 1 }，也可直接傳數字。 */
export function numberArg(arg: unknown): number | undefined {
  return typeof arg === 'number' ? arg : typeof (arg as { number?: unknown } | undefined)?.number === 'number' ? (arg as { number: number }).number : undefined;
}

/** 來源指令的參數：來源名稱字串，或依來源分組的分組節點。 */
export function sourceArg(arg?: unknown): string | undefined {
  return typeof arg === 'string' ? arg : (arg as { by?: string } | undefined)?.by === 'source' ? (arg as { key: string }).key : undefined;
}

/** 依檔案分組的檔案列參數（BmGroupNode、Uri 或 uriKey 字串），回傳檔案的 uriKey。 */
export function fileGroupKey(arg?: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg instanceof vscode.Uri) {
    return uriKey(arg);
  }
  const g = arg as Partial<BmGroupNode> | undefined;
  if (g?.type === 'bmGroup' && g.by === 'file') {
    return g.uri ? uriKey(g.uri) : g.key;
  }
  return undefined;
}
