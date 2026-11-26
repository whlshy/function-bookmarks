import * as path from 'path';
import * as vscode from 'vscode';
import { uriKey } from '../util/uris';
import { diffLines, hashLine, splitLines } from './relocate';

/** 候選檔案超過這個大小就不讀進來比對。 */
const MAX_RENAME_COMPARE_BYTES = 2 * 1024 * 1024;
/** 新出現多久以內的檔案才算改名候選。 */
const RECENT_MS = 120_000;
/** 最多記住幾個新出現的檔案；超過時丟掉最舊的一批。 */
const MAX_RECENT = 500;
const DROP_OLDEST = 100;
/** 每次最多比對幾個候選檔案。 */
const MAX_CANDIDATES = 30;
/** 至少要有幾成的行相同才算同一個檔案。 */
const MIN_COMMON_RATIO = 0.6;

/** 檔案內容的行雜湊。 */
export function hashText(text: string): number[] {
  return splitLines(text).map(hashLine);
}

export function sameHashes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}

/** 兩份內容有幾成的行相同（判斷是不是同一個檔案被改名）。 */
export function commonRatio(a: number[], b: number[]): number {
  const max = Math.max(a.length, b.length);
  if (!max) {
    return 1;
  }
  const removed = diffLines(a, b).reduce((n, h) => n + (h.oldEnd - h.oldStart), 0);
  return (a.length - removed) / max;
}

/**
 * 有書籤的檔案不見時，從最近新出現的檔案裡找出它改名後的位置：
 * 內容和記住的內容最相近的（同名、同副檔名優先），六成以上相同才算改名。
 */
export class RenameDetector {
  private recentCreates = new Map<string, { uri: vscode.Uri; at: number }>();

  /** 記下新出現的檔案（之後判斷改名用）。 */
  noteCreated(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') {
      return;
    }
    this.recentCreates.set(uriKey(uri), { uri, at: Date.now() });
    if (this.recentCreates.size > MAX_RECENT) {
      const oldest = [...this.recentCreates.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, DROP_OLDEST);
      oldest.forEach(([k]) => this.recentCreates.delete(k));
    }
  }

  /**
   * 找 `uri` 改名後的檔案；`old` 是記住的內容。
   * `hasBookmarks` 為 true 的候選略過（已經有自己的書籤，不會是改名對象）。
   */
  async find(uri: vscode.Uri, old: number[], hasBookmarks: (candidate: vscode.Uri) => boolean): Promise<vscode.Uri | undefined> {
    const now = Date.now();
    const ext = path.posix.extname(uri.path);
    const base = path.posix.basename(uri.path);
    const candidates = [...this.recentCreates.values()]
      .filter((c) => now - c.at < RECENT_MS && uriKey(c.uri) !== uriKey(uri) && path.posix.extname(c.uri.path) === ext)
      .sort((a, b) => Number(path.posix.basename(b.uri.path) === base) - Number(path.posix.basename(a.uri.path) === base) || b.at - a.at)
      .slice(0, MAX_CANDIDATES);
    let best: vscode.Uri | undefined;
    let bestScore = MIN_COMMON_RATIO;
    for (const c of candidates) {
      if (hasBookmarks(c.uri)) {
        continue;
      }
      let text: string;
      try {
        // 太大的檔案不讀進來比對（改名偵測只是輔助，避免一次讀好幾個大檔）
        if ((await vscode.workspace.fs.stat(c.uri)).size > MAX_RENAME_COMPARE_BYTES) {
          continue;
        }
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(c.uri));
      } catch {
        continue;
      }
      const score = commonRatio(old, hashText(text));
      if (score >= bestScore) {
        bestScore = score;
        best = c.uri;
      }
    }
    return best;
  }
}
