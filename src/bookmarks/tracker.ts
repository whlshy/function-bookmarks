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
    if (isWholeDocumentReplace(changes, e.document.lineCount)) {
      return;
    }
    const mode = onLineDeleteSetting(e.document.uri);
    const last = Math.max(0, e.document.lineCount - 1);
    await this.store.update(
      loc.folder,
      (d) =>
        updateBookmarksInFile(d, loc.rel, (b) => {
          const r = applyChanges(b, changes, mode);
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
          const sym = findInnermost(symbols, b.line);
          return { ...b, anchor: makeAnchor(lines, b.line, sym?.path, sym?.startLine) };
        }),
      { deferSave: true },
    );
  }
}
