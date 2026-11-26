import * as vscode from 'vscode';
import { SECTION } from '../config';
import { findInnermost } from '../detection/engine';
import { addBookmark, updateBookmarksInFile } from '../storage/marks';
import { MarkStore } from '../storage/store';
import { SymbolService } from '../symbols/symbolService';
import { applyChanges, isWholeDocumentReplace, LineBookmark, LineChange, makeAnchor, OnLineDelete, shiftLine } from './model';
import { DeletionMemory, DeletionRecord } from './undoMemory';

export function onLineDeleteSetting(scope?: vscode.ConfigurationScope): OnLineDelete {
  return vscode.workspace.getConfiguration(SECTION, scope).get<OnLineDelete>('bookmarks.onLineDelete', 'moveToNext');
}

export interface LineChangeBatch {
  changes: LineChange[];
  lineCount: number;
  /** 這批變更來自復原（Undo）。 */
  undo?: boolean;
}

/** 刪行後復原時把書籤放回原位用的紀錄（每個檔案最近幾次刪行）。 */
const deletions = new DeletionMemory();

/** 書籤所在的行是否在這批變更中被刪除。 */
function deletedBy(line: number, changes: LineChange[]): boolean {
  const ordered = [...changes].sort((a, b) => b.startLine - a.startLine || b.startChar - a.startChar);
  let deleted = false;
  for (const c of ordered) {
    const r = shiftLine(line, c);
    line = r.line;
    deleted = deleted || r.deleted;
  }
  return deleted;
}

/** 依序把一或多批編輯器內變更套用到該檔案的行號書籤（一般編輯與乾淨檔案第一次編輯重播共用）。 */
export async function applyLineChangeBatches(
  store: MarkStore,
  doc: vscode.TextDocument,
  batches: LineChangeBatch[],
): Promise<void> {
  if (!batches.length) {
    return;
  }
  const loc = store.locate(doc.uri);
  if (!loc) {
    return;
  }
  const hasMarks = store.bookmarksFor(doc.uri).length > 0;
  // 只有一筆變更的單次編輯才記錄／比對刪行與復原（多游標、合併重播的情況照一般平移）
  const single = batches.length === 1 && batches[0].changes.length === 1 ? batches[0] : undefined;
  if (!hasMarks && !single?.undo) {
    return;
  }
  const key = doc.uri.toString();
  const undoOf = single?.undo ? deletions.takeUndo(key, single.changes[0]) : undefined;
  // 檔案裡已經沒有書籤時，只有「復原刪掉書籤的那次刪行」需要處理
  if (!hasMarks && !undoOf?.removed.length) {
    return;
  }
  const mode = onLineDeleteSetting(doc.uri);
  const restore = new Map(undoOf?.moved.map((m) => [m.id, m]));
  const record: DeletionRecord | undefined =
    single && !single.undo ? { change: single.changes[0], moved: [], removed: [] } : undefined;
  await store.update(
    loc.folder,
    (d) => {
      let next = updateBookmarksInFile(d, loc.rel, (b) => {
        // 只屬於別的分支（目前隱藏）的書籤不跟著這個分支的編輯移動
        if (!store.isVisible(loc.folder, b)) {
          return b;
        }
        // 復原剛才的刪行：書籤還在刪行後被移到的那一行，就放回原本那一行與狀態
        const back = restore.get(b.id);
        if (back && b.line === back.afterLine) {
          const restored: LineBookmark = { ...b, line: back.line };
          if (back.status) {
            restored.status = back.status;
          } else {
            delete restored.status;
          }
          return restored;
        }
        const deleted = record ? deletedBy(b.line, [record.change]) : false;
        // 不在此分支：行號只是在這個分支上的大概位置（切回原分支時由分支快照換算），
        // 跟著平移，但刪到那一行時不刪除、也不改狀態
        const away = b.status === 'notOnBranch';
        let cur = b;
        for (const batch of batches) {
          const last = Math.max(0, batch.lineCount - 1);
          const r = applyChanges(cur, batch.changes, away ? 'moveToNext' : mode);
          if (!r) {
            if (deleted) {
              record?.removed.push(b);
            }
            return undefined;
          }
          const moved = { ...cur, line: Math.min(r.line, last) };
          if (r.status) {
            moved.status = r.status;
          } else {
            delete moved.status;
          }
          cur = moved;
        }
        if (deleted) {
          record?.moved.push({ id: b.id, line: b.line, status: b.status, afterLine: cur.line });
        }
        return cur;
      });
      // 復原 onLineDelete = remove 刪掉的書籤：整筆放回去
      for (const b of undoOf?.removed ?? []) {
        if (!(next.bookmarks ?? []).some((x) => x.id === b.id)) {
          next = addBookmark(next, b);
        }
      }
      return next;
    },
    { deferSave: true },
  );
  if (record) {
    deletions.remember(key, record);
  }
}


/**
 * 方式 A：在編輯器裡打字、貼上、刪行時即時平移書籤；存檔時更新 anchor（該行內容、前後行、所在函式）。
 */
export class BookmarkTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  /** 由 ExternalChangeWatcher 設定：回答 true 的編輯改用差異換算，這裡不平移。 */
  handledByDiff?: (e: vscode.TextDocumentChangeEvent, changes: LineChange[]) => boolean;
  /**
   * 由 ExternalChangeWatcher 設定：存檔更新 anchor 前先結算待處理的編輯器變更
   * （VS Code 在乾淨文件第一次編輯觸發 change 時 isDirty 尚未更新，可能暫留在 pendingReload 尚未換算）。
   */
  beforeRefreshAnchors?: (doc: vscode.TextDocument) => Promise<void>;

  constructor(
    private readonly store: MarkStore,
    private readonly service: SymbolService,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => void this.onChange(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => void this.refreshAnchors(doc)),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  private async onChange(e: vscode.TextDocumentChangeEvent): Promise<void> {
    if (!e.contentChanges.length) {
      return;
    }
    const loc = this.store.locate(e.document.uri);
    const undo = e.reason === vscode.TextDocumentChangeReason.Undo;
    // 沒有書籤的檔案不必處理；復原例外（可能要放回刪行時一起刪掉的書籤）
    if (!loc || (this.store.bookmarksFor(e.document.uri).length === 0 && !undo)) {
      return;
    }
    const changes: LineChange[] = e.contentChanges.map((c) => ({
      startLine: c.range.start.line,
      startChar: c.range.start.character,
      endLine: c.range.end.line,
      endChar: c.range.end.character,
      text: c.text.replace(/\r\n/g, '\n'),
    }));
    if (isWholeDocumentReplace(changes, e.document.lineCount) || this.handledByDiff?.(e, changes)) {
      return;
    }
    await applyLineChangeBatches(this.store, e.document, [
      { changes, lineCount: e.document.lineCount, undo },
    ]);
  }

  /** 存檔時更新書籤的 anchor，之後的 git 換算與後備定位會用到。 */
  async refreshAnchors(doc: vscode.TextDocument): Promise<void> {
    await this.beforeRefreshAnchors?.(doc);
    const loc = this.store.locate(doc.uri);
    if (!loc || this.store.bookmarksFor(doc.uri).length === 0) {
      return;
    }
    const lines = doc.getText().split(/\r?\n/);
    const symbols = (await this.service.getSymbols(doc)).symbols;
    await this.store.update(
      loc.folder,
      (d) =>
        updateBookmarksInFile(d, loc.rel, (b) => {
          // 需確認的書籤保留原本的 anchor，之後內容回來（例如衝突解決、復原）還能找回
          if (b.status === 'lost' || b.status === 'notOnBranch' || !this.store.isVisible(loc.folder, b)) {
            return b;
          }
          const sym = findInnermost(symbols, b.line);
          return { ...b, anchor: makeAnchor(lines, b.line, sym?.path, sym?.startLine) };
        }),
      { deferSave: true },
    );
  }
}
