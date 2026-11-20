import * as vscode from 'vscode';
import { uriKey } from '../util/uris';
import { findByPath } from '../detection/engine';
import { DetectedSymbol } from '../detection/types';
import { updateLine } from '../storage/marks';
import { reconcileFile } from '../storage/reconcile';
import { FavoriteEntry, MarkStore } from '../storage/store';
import { SymbolService } from './symbolService';

export type FavoriteStatus = 'ok' | 'missing' | 'noFile';

export interface ResolvedFavorite extends FavoriteEntry {
  symbol?: DetectedSymbol;
  status: FavoriteStatus;
}

/**
 * 收藏區的資料：不必開啟檔案，在背景讀取收藏所在的檔案，確認函式還在、取得最新行號。
 */
export class FavoritesModel implements vscode.Disposable {
  private items: ResolvedFavorite[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private rerun = false;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: MarkStore,
    private readonly service: SymbolService,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFs = (uri: vscode.Uri) => {
      if (this.involves(uri)) {
        this.service.invalidate(uri);
        this.schedule();
      }
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(onFs),
      watcher.onDidCreate(onFs),
      watcher.onDidDelete(onFs),
      store.onDidChange(() => this.schedule(0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length && this.involves(e.document.uri)) {
          this.schedule();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.involves(d.uri) && this.schedule()),
    );
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    [...this.disposables, this.changed].forEach((d) => d.dispose());
  }

  get all(): ResolvedFavorite[] {
    return this.items;
  }

  private involves(uri: vscode.Uri): boolean {
    const key = uriKey(uri);
    // 資料夾被刪除或改名時，底下的檔案也算
    return this.store.allFavorites().some((f) => {
      const u = uriKey(f.uri);
      return u === key || u.startsWith(`${key}/`);
    });
  }

  schedule(delay = 300): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  /** 重新確認所有收藏；同時只跑一次，期間又有變動就再跑一次。 */
  refresh(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        await this.resolveAll();
      } while (this.rerun);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async resolveAll(): Promise<void> {
    const byFile = new Map<string, Awaited<ReturnType<SymbolService['getForUri']>>>();
    // 先讀取各檔案的函式，並處理程式碼中改名的情況（把標記轉到新名稱）
    for (const entry of this.store.allFavorites()) {
      const key = uriKey(entry.uri);
      if (byFile.has(key)) {
        continue;
      }
      const file = await this.service.getForUri(entry.uri);
      byFile.set(key, file);
      if (file) {
        await this.store.update(entry.folder, (d) => reconcileFile(d, entry.mark.file, file.symbols));
      }
    }
    const entries = this.store.allFavorites();
    const resolved: ResolvedFavorite[] = [];
    for (const entry of entries) {
      const key = uriKey(entry.uri);
      if (!byFile.has(key)) {
        byFile.set(key, await this.service.getForUri(entry.uri));
      }
      const file = byFile.get(key);
      if (!file) {
        resolved.push({ ...entry, status: 'noFile' });
        continue;
      }
      const symbol = findByPath(file.symbols, entry.mark.path, entry.mark.kind);
      resolved.push({ ...entry, symbol, status: symbol ? 'ok' : 'missing' });
    }
    this.items = resolved;
    this.changed.fire();
    // 記住最新行號，函式之後找不到時還能跳到大概的位置
    for (const r of resolved) {
      if (r.symbol && r.mark.line !== r.symbol.nameLine) {
        const line = r.symbol.nameLine;
        await this.store.update(r.folder, (d) => updateLine(d, r.mark, line));
      }
    }
  }
}
