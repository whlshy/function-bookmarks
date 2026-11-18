import * as vscode from 'vscode';
import { normalizeDrive } from './paths';

/** 統一磁碟代號大小寫後的 Uri。 */
export function normalizeUri(uri: vscode.Uri): vscode.Uri {
  const p = normalizeDrive(uri.path);
  return p === uri.path ? uri : uri.with({ path: p });
}

/** 用來比對、當作 Map 鍵的字串。 */
export function uriKey(uri: vscode.Uri): string {
  return normalizeUri(uri).toString();
}

export function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return uriKey(a) === uriKey(b);
}
