import * as vscode from 'vscode';
import { SECTION } from '../config';
import { findInnermost } from '../detection/engine';
import { updateBookmarksInFile } from '../storage/marks';
import { MarkStore } from '../storage/store';
import { SymbolService } from '../symbols/symbolService';
import { applyChanges, isWholeDocumentReplace, LineChange, makeAnchor, OnLineDelete } from './model';

export function onLineDeleteSetting(scope?: vscode.ConfigurationScope): OnLineDelete {
  return vscode.workspace.getConfiguration(SECTION, scope).get<OnLineDelete>('bookmarks.onLineDelete', 'moveToNext');
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
    if (!loc || this.store.bookmarksFor(e.document.uri).length === 0) {
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
    const mode = onLineDeleteSetting(e.document.uri);
    const last = Math.max(0, e.document.lineCount - 1);
    await this.store.update(
      loc.folder,
      (d) =>
        updateBookmarksInFile(d, loc.rel, (b) => {
          // 只屬於別的分支（目前隱藏）的書籤不跟著這個分支的編輯移動
          if (!this.store.isVisible(loc.folder, b)) {
            return b;
          }
          // 不在此分支：行號只是在這個分支上的大概位置（切回原分支時由分支快照換算），
          // 跟著平移，但刪到那一行時不刪除、也不改狀態
          const away = b.status === 'notOnBranch';
          const r = applyChanges(b, changes, away ? 'moveToNext' : mode);
          if (!r) {
            return undefined;
          }
          const next = { ...b, line: Math.min(r.line, last) };
          if (r.status) {
            next.status = r.status;
          } else {
            delete next.status;
          }
          return next;
        }),
      { deferSave: true },
    );
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
