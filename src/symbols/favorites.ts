import * as vscode from 'vscode';
import { FileEvents } from '../util/fileEvents';
import { uriKey } from '../util/uris';
import { DetectedSymbol } from '../detection/types';
import { updateLine } from '../storage/marks';
import { reconcileFile } from '../storage/reconcile';
import { FavoriteEntry, MarkStore } from '../storage/store';
import { FileSymbols, SymbolService } from './symbolService';

import { FavoriteStatus, favoriteLineUpdates, resolveFavorite } from '../core/resolve';

export type { FavoriteStatus };

export interface ResolvedFavorite extends FavoriteEntry {
  symbol?: DetectedSymbol;
  status: FavoriteStatus;
}

/** 有限並發執行非同步工作，避免啟動或大批檔案更新時串行等待或一次開太多檔。 */
async function mapConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (!items.length) {
    return;
  }
  let next = 0;
  const workers = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    }),
  );
}

/**
 * 收藏區的資料：不必開啟檔案，在背景讀取收藏所在的檔案，確認函式還在、取得最新行號。
 * 建構時先用已儲存的資料立即建立清單，讓側邊欄不必等磁碟掃描或語言伺服器即可顯示。
 */
export class FavoritesModel implements vscode.Disposable {
  private items: ResolvedFavorite[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private rerun = false;
  /** 自己批次寫回 reconcile／行號更新期間，避免 store.onDidChange 再次觸發整輪重掃。 */
  private updatingStore = false;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: MarkStore,
    private readonly service: SymbolService,
    files: FileEvents,
  ) {
    this.seedFromStore();
    const onFs = (uri: vscode.Uri) => {
      if (this.involves(uri)) {
        this.service.invalidate(uri);
        this.schedule();
      }
    };
    this.disposables.push(
      files.onDidChange(onFs),
      files.onDidCreate(onFs),
      files.onDidDelete(onFs),
      store.onDidChange((e) => {
        // 只有行號書籤變了（打字造成的行號平移、新增行號書籤等）：函式書籤不受影響，不必重新確認
        if (e && !e.symbolsChanged) {
          return;
        }
        this.seedFromStore();
        this.changed.fire();
        if (!this.updatingStore) {
          this.schedule(0);
        }
      }),
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

  /** 等目前背景驗證完成（測試與啟動量測用）。 */
  async whenReady(): Promise<void> {
    while (this.timer || this.running) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
        void this.refresh();
      }
      if (this.running) {
        await this.running;
      }
    }
  }

  private itemKey(e: FavoriteEntry): string {
    return `${uriKey(e.uri)}::${e.mark.kind}:${e.mark.path}`;
  }

  /** 用 store 裡的既有資料立刻同步清單（保留上次解析到的 symbol 與 status），不必等 I/O 就能顯示。 */
  private seedFromStore(): void {
    const prev = new Map(this.items.map((r) => [this.itemKey(r), r]));
    this.items = this.store.allFavorites().map((entry) => {
      const old = prev.get(this.itemKey(entry));
      return old ? { ...old, ...entry } : { ...entry, status: 'ok' };
    });
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
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
  }

  /** 重新確認所有收藏；同時只跑一次，期間又有變動就再跑一次。 */
  refresh(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
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
    const initial = this.store.allFavorites();
    // 按檔案去重，並將純規則檔案排在前面、需要語言伺服器的檔案排在後面
    const uniqueFiles = new Map<string, { folder: vscode.WorkspaceFolder; rel: string; uri: vscode.Uri }>();
    for (const entry of initial) {
      const key = uriKey(entry.uri);
      if (!uniqueFiles.has(key)) {
        uniqueFiles.set(key, { folder: entry.folder, rel: entry.mark.file, uri: entry.uri });
      }
    }
    const fastFiles: { key: string; folder: vscode.WorkspaceFolder; rel: string; uri: vscode.Uri }[] = [];
    const slowFiles: { key: string; folder: vscode.WorkspaceFolder; rel: string; uri: vscode.Uri }[] = [];
    for (const [key, info] of uniqueFiles) {
      if (this.service.needsLanguageServer(info.uri)) {
        slowFiles.push({ key, ...info });
      } else {
        fastFiles.push({ key, ...info });
      }
    }

    const byFile = new Map<string, FileSymbols | undefined>();
    const reconcileBatch = async (batch: typeof fastFiles, concurrency: number) => {
      const byFolder = new Map<vscode.WorkspaceFolder, { rel: string; symbols: DetectedSymbol[] }[]>();
      await mapConcurrent(batch, concurrency, async (item) => {
        const file = await this.service.getForUri(item.uri);
        byFile.set(item.key, file);
        if (file) {
          const list = byFolder.get(item.folder) ?? [];
          list.push({ rel: item.rel, symbols: file.symbols });
          byFolder.set(item.folder, list);
        }
      });
      // 每個資料夾合併為一次 store.update，避免逐檔寫磁碟與重複觸發刷新風暴
      if (byFolder.size) {
        this.updatingStore = true;
        try {
          for (const [folder, updates] of byFolder) {
            await this.store.update(folder, (d) => updates.reduce((acc, u) => reconcileFile(acc, u.rel, u.symbols), d));
          }
        } finally {
          this.updatingStore = false;
        }
      }
    };

    const buildResolved = (partial: boolean): ResolvedFavorite[] => {
      const prev = new Map(this.items.map((r) => [this.itemKey(r), r]));
      const resolved: ResolvedFavorite[] = [];
      for (const entry of this.store.allFavorites()) {
        const key = uriKey(entry.uri);
        if (!byFile.has(key)) {
          if (partial) {
            const old = prev.get(this.itemKey(entry));
            resolved.push(old ? { ...old, ...entry } : { ...entry, status: 'ok' });
            continue;
          }
          resolved.push({ ...entry, status: 'noFile' });
          continue;
        }
        const file = byFile.get(key);
        if (!file) {
          resolved.push({ ...entry, status: 'noFile' });
          continue;
        }
        resolved.push({ ...entry, ...resolveFavorite(entry.mark, file.symbols) });
      }
      return resolved;
    };

    if (fastFiles.length) {
      await reconcileBatch(fastFiles, 8);
      if (slowFiles.length) {
        // 純規則檔案先更新到畫面，不必等慢的語言伺服器檔案
        this.items = buildResolved(true);
        this.changed.fire();
      }
    }
    if (slowFiles.length) {
      // 需要語言伺服器的檔案放低並發，避免啟動初期塞滿擴充主機影響使用者指令反應
      await reconcileBatch(slowFiles, 2);
    }

    const resolved = buildResolved(false);
    this.items = resolved;
    this.changed.fire();

    // 記住最新行號（每個資料夾合併成一次更新），函式之後找不到時還能跳到大概的位置
    const lineUpdates = new Map<vscode.WorkspaceFolder, { mark: FavoriteEntry['mark']; line: number }[]>();
    for (const { item, line } of favoriteLineUpdates(resolved)) {
      const list = lineUpdates.get(item.folder) ?? [];
      list.push({ mark: item.mark, line });
      lineUpdates.set(item.folder, list);
    }
    if (lineUpdates.size) {
      this.updatingStore = true;
      try {
        for (const [folder, updates] of lineUpdates) {
          await this.store.update(folder, (d) => updates.reduce((acc, u) => updateLine(acc, u.mark, u.line), d));
        }
      } finally {
        this.updatingStore = false;
      }
    }
  }
}
