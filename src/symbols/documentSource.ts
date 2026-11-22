import * as vscode from 'vscode';
import { uriKey } from '../util/uris';
import { languageForPath } from '../util/paths';

/** 偵測用的文件內容。沒開啟的檔案直接讀磁碟，不會在編輯器多開分頁。 */
export interface SourceDoc {
  uri: vscode.Uri;
  languageId: string;
  text: string;
  /** 快取用：開啟中的文件用編輯版本，磁碟檔案用修改時間＋大小。 */
  version: string;
  document?: vscode.TextDocument;
}

export function fromDocument(doc: vscode.TextDocument): SourceDoc {
  // 編輯器沒有這個語言的擴充（例如沒裝 Kotlin）時會是純文字：改用副檔名判斷，規則才套得上
  const languageId = doc.languageId === 'plaintext' ? (languageForPath(doc.uri.path) ?? doc.languageId) : doc.languageId;
  return { uri: doc.uri, languageId, text: doc.getText(), version: `v${doc.version}`, document: doc };
}

export function openDocumentFor(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uriKey(uri);
  return vscode.workspace.textDocuments.find((d) => uriKey(d.uri) === key);
}

export async function loadSource(uri: vscode.Uri): Promise<SourceDoc | undefined> {
  const open = openDocumentFor(uri);
  if (open) {
    return fromDocument(open);
  }
  const lang = languageForPath(uri.path);
  if (lang) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const bytes = await vscode.workspace.fs.readFile(uri);
      return { uri, languageId: lang, text: new TextDecoder().decode(bytes), version: `m${stat.mtime}:${stat.size}` };
    } catch {
      return undefined;
    }
  }
  // 副檔名猜不到語言：交給編輯器開啟（不顯示）以取得語言，之後可能走語言伺服器
  try {
    return fromDocument(await vscode.workspace.openTextDocument(uri));
  } catch {
    return undefined;
  }
}
