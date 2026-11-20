import * as vscode from 'vscode';
import { SymbolService } from '../symbols/symbolService';
import { reconcileFile } from './reconcile';
import { MarkStore } from './store';

/**
 * 編輯中、存檔時：檔案裡有函式標記（書籤、自訂名稱、備註）就重新整理，
 * 讓程式碼中改了函式名稱後，標記自動轉到新名稱。
 * 背景確認（git pull 等外部改檔）由 FavoritesModel 處理。
 */
export class ReconcileWatcher implements vscode.Disposable {
  private timers = new Map<string, NodeJS.Timeout>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: MarkStore,
    private readonly service: SymbolService,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) {
          this.schedule(e.document);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => void this.reconcile(doc)),
    );
  }

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
  }

  private schedule(doc: vscode.TextDocument): void {
    if (!this.store.hasSymbolMarks(doc.uri)) {
      return;
    }
    const key = doc.uri.toString();
    const t = this.timers.get(key);
    if (t) {
      clearTimeout(t);
    }
    // 打字中會有不完整的名稱，等停下來 0.5 秒再處理
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.reconcile(doc);
      }, 500),
    );
  }

  async reconcile(doc: vscode.TextDocument): Promise<boolean> {
    const loc = this.store.locate(doc.uri);
    if (!loc || !this.store.hasSymbolMarks(doc.uri)) {
      return false;
    }
    const symbols = (await this.service.getSymbols(doc)).symbols;
    return this.store.update(loc.folder, (d) => reconcileFile(d, loc.rel, symbols), { deferSave: true });
  }
}
