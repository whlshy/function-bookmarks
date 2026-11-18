import * as vscode from 'vscode';
import { normalizeUri, sameUri, uriKey } from '../util/uris';
import { relativeUnder } from '../util/paths';
import { SECTION, storageMode } from '../config';
import { DetectedSymbol } from '../detection/types';
import { BOOKMARKS_FILE } from './gitExclude';
import { ensureBookmarksFileExcluded } from './gitExcludeFs';
import { emptyStore, favorites, findMark, MarkKey, parseStore, renamePath, serializeStore, StoreData, SymbolMark } from './marks';

export interface Located {
  folder: vscode.WorkspaceFolder;
  rel: string;
}

export interface FavoriteEntry {
  folder: vscode.WorkspaceFolder;
  uri: vscode.Uri;
  mark: SymbolMark;
}

const STATE_KEY = 'marks:';

/**
 * 每個工作區資料夾一份資料：預設存在 `.vscode/function-bookmarks.json`，
 * 也可設定改存 workspace state（不產生檔案）。
 */
export class MarkStore implements vscode.Disposable {
  private data = new Map<string, StoreData>();
  /** 檔案內容壞掉的資料夾：不覆寫，避免把使用者手動修改的內容蓋掉。 */
  private broken = new Set<string>();
  private lastWritten = new Map<string, string>();
  private excludedChecked = new Set<string>();
  private watchers: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  async init(): Promise<void> {
    await this.reloadAll();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.reloadAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.storage`)) {
          void this.reloadAll();
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => void this.onRename(e)),
    );
  }

  dispose(): void {
    [...this.watchers, ...this.disposables, this.changed].forEach((d) => d.dispose());
  }

  locate(uri: vscode.Uri): Located | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    const rel = relativeUnder(folder.uri.path, uri.path);
    return rel ? { folder, rel } : undefined;
  }

  uriOf(folder: vscode.WorkspaceFolder, rel: string): vscode.Uri {
    return normalizeUri(vscode.Uri.joinPath(folder.uri, ...rel.split('/')));
  }

  keyFor(uri: vscode.Uri, symbol: Pick<DetectedSymbol, 'path' | 'kind'>): (MarkKey & Located) | undefined {
    const loc = this.locate(uri);
    return loc ? { ...loc, file: loc.rel, path: symbol.path, kind: symbol.kind } : undefined;
  }

  get(uri: vscode.Uri, symbol: Pick<DetectedSymbol, 'path' | 'kind'>): SymbolMark | undefined {
    const k = this.keyFor(uri, symbol);
    return k ? findMark(this.data.get(uriKey(k.folder.uri)) ?? emptyStore(), k) : undefined;
  }

  allFavorites(): FavoriteEntry[] {
    const out: FavoriteEntry[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const mark of favorites(this.data.get(uriKey(folder.uri)) ?? emptyStore())) {
        out.push({ folder, mark, uri: this.uriOf(folder, mark.file) });
      }
    }
    return out;
  }

  isBroken(folder: vscode.WorkspaceFolder): boolean {
    return this.broken.has(uriKey(folder.uri));
  }

  /** 修改某個資料夾的資料；回傳同一個物件代表沒有變化，不會存檔。 */
  async update(folder: vscode.WorkspaceFolder, fn: (data: StoreData) => StoreData): Promise<boolean> {
    const key = uriKey(folder.uri);
    if (this.broken.has(key)) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('{0} is not valid JSON. Fix or delete it before making changes.', BOOKMARKS_FILE),
      );
      return false;
    }
    const before = this.data.get(key) ?? emptyStore();
    const after = fn(before);
    if (after === before) {
      return false;
    }
    this.data.set(key, after);
    await this.save(folder, after);
    this.changed.fire();
    return true;
  }

  private fileUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, ...BOOKMARKS_FILE.split('/'));
  }

  private async reloadAll(): Promise<void> {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    this.data.clear();
    this.broken.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await this.load(folder);
      if (storageMode() === 'file') {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, BOOKMARKS_FILE));
        const reload = () => void this.load(folder).then((changed) => changed && this.changed.fire());
        w.onDidChange(reload);
        w.onDidCreate(reload);
        w.onDidDelete(reload);
        this.watchers.push(w);
      }
    }
    this.changed.fire();
  }

  /** 讀取資料；回傳是否有變化。自己剛寫入的內容不重複載入。 */
  private async load(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const key = uriKey(folder.uri);
    if (storageMode() === 'workspaceState') {
      const raw = this.context.workspaceState.get<string>(STATE_KEY + key);
      this.data.set(key, (raw && parseStore(raw)) || emptyStore());
      return true;
    }
    let text: string | undefined;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.fileUri(folder)));
    } catch {
      text = undefined;
    }
    if (text !== undefined && text === this.lastWritten.get(key)) {
      return false;
    }
    if (text === undefined || text.trim() === '') {
      this.broken.delete(key);
      this.data.set(key, emptyStore());
      return true;
    }
    const parsed = parseStore(text);
    if (!parsed) {
      if (!this.broken.has(key)) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('{0} is not valid JSON. Fix or delete it before making changes.', BOOKMARKS_FILE),
        );
      }
      this.broken.add(key);
      return false;
    }
    this.broken.delete(key);
    this.data.set(key, parsed);
    return true;
  }

  private async save(folder: vscode.WorkspaceFolder, data: StoreData): Promise<void> {
    const key = uriKey(folder.uri);
    const text = serializeStore(data);
    if (storageMode() === 'workspaceState') {
      await this.context.workspaceState.update(STATE_KEY + key, text);
      return;
    }
    const file = this.fileUri(folder);
    if (data.symbols.length === 0) {
      // 沒有任何資料時不主動建立檔案；已存在的檔案則更新為空清單
      const exists = await vscode.workspace.fs.stat(file).then(
        () => true,
        () => false,
      );
      if (!exists) {
        return;
      }
    }
    this.lastWritten.set(key, text);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
    if (!this.excludedChecked.has(key)) {
      this.excludedChecked.add(key);
      await ensureBookmarksFileExcluded(folder.uri).catch(() => undefined);
    }
  }

  private async onRename(e: vscode.FileRenameEvent): Promise<void> {
    for (const { oldUri, newUri } of e.files) {
      const from = this.locate(oldUri);
      const to = this.locate(newUri);
      if (!from || !to || !sameUri(from.folder.uri, to.folder.uri)) {
        continue;
      }
      await this.update(from.folder, (d) => renamePath(d, from.rel, to.rel));
    }
  }
}
