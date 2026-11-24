import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { normalizeUri, sameUri, uriKey } from '../util/uris';
import { relativeUnder } from '../util/paths';
import { SECTION, StorageMode, storageMode } from '../config';
import { DetectedSymbol } from '../detection/types';
import { BOOKMARKS_FILE } from './gitExclude';
import { ensureBookmarksFileExcluded } from './gitExcludeFs';
import { LineBookmark, visibleOnBranch } from '../bookmarks/model';
import { emptyStore, favorites, findMark, hasStoreData, MarkKey, mergeStoreData, parseStore, renamePath, serializeStore, StoreData, SymbolMark } from './marks';

export interface Located {
  folder: vscode.WorkspaceFolder;
  rel: string;
}

export interface BookmarkEntry {
  folder: vscode.WorkspaceFolder;
  uri: vscode.Uri;
  bookmark: LineBookmark;
}

export interface FavoriteEntry {
  folder: vscode.WorkspaceFolder;
  uri: vscode.Uri;
  mark: SymbolMark;
}

/** 有號碼的書籤。 */
export type NumberedEntry =
  | { kind: 'line'; folder: vscode.WorkspaceFolder; uri: vscode.Uri; bookmark: LineBookmark }
  | { kind: 'symbol'; folder: vscode.WorkspaceFolder; uri: vscode.Uri; mark: SymbolMark };

const STATE_KEY = 'marks:';

/**
 * 每個工作區資料夾一份資料：預設存在 `.vscode/function-bookmarks.json`，
 * 也可設定改存 workspace state（不產生檔案）。
 */
export class MarkStore implements vscode.Disposable {
  private data = new Map<string, StoreData>();
  /** 檔案內容壞掉的資料夾：不覆寫，避免把使用者手動修改的內容蓋掉。 */
  private broken = new Set<string>();
  /** 最近幾次自己寫入的內容：檔案變更通知可能晚到，讀到這些內容時不重新載入。 */
  private recentWrites = new Map<string, string[]>();
  /** 正在寫入的資料夾：寫入途中讀檔可能讀到被截斷的內容，這段期間不重新載入。 */
  private saving = new Map<string, number>();
  /** 延後寫入中的資料夾：這段期間記憶體裡的資料比較新，不從檔案重新載入。 */
  private pendingSaves = new Map<string, NodeJS.Timeout>();
  private excludedChecked = new Set<string>();
  private watchers: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private disposables: vscode.Disposable[] = [];
  private mode: StorageMode = storageMode();
  /** 給測試用：最近一次切換儲存模式時準備搬移的資訊（來源有資料時才記錄）。 */
  lastStorageSwitch?: { from: StorageMode; to: StorageMode; targetHadData: boolean; prevData: Map<string, StoreData> };
  /** 給測試用：停用互動通知避免測試中殘留提示。 */
  suppressStoragePrompt = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async init(): Promise<void> {
    this.mode = storageMode();
    await this.reloadAll();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.reloadAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.storage`)) {
          void this.onStorageModeChanged();
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => void this.onRename(e)),
    );
  }

  /** 切換 storage（file ↔ workspaceState）時載入新目標並提示是否搬移書籤，絕不悄悄覆蓋目標端既有資料。 */
  private async onStorageModeChanged(): Promise<void> {
    const nextMode = storageMode();
    if (nextMode === this.mode) {
      return;
    }
    const prevMode = this.mode;
    await this.flush();
    const prevData = new Map(this.data);
    this.mode = nextMode;
    await this.reloadAll();
    if (![...prevData.values()].some((d) => hasStoreData(d))) {
      return;
    }
    const targetHadData = [...this.data.values()].some((d) => hasStoreData(d));
    this.lastStorageSwitch = { from: prevMode, to: nextMode, targetHadData, prevData };
    if (!this.suppressStoragePrompt) {
      void this.promptStorageMigration(prevMode, nextMode, prevData, targetHadData);
    }
  }

  /** 把切換前的書籤資料複製、合併或取代到目前的儲存端（供互動提示與測試使用）。 */
  async migrateStorageData(prevData: Map<string, StoreData>, action: 'copy' | 'merge' | 'replace'): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const src = prevData.get(uriKey(folder.uri));
      if (!hasStoreData(src)) {
        continue;
      }
      await this.update(folder, (cur) => (action === 'merge' ? mergeStoreData(cur, src!) : src!));
    }
  }

  private storageLabel(mode: StorageMode): string {
    return mode === 'file' ? BOOKMARKS_FILE : vscode.l10n.t('VS Code workspace storage');
  }

  private async promptStorageMigration(
    from: StorageMode,
    to: StorageMode,
    prevData: Map<string, StoreData>,
    targetHadData: boolean,
  ): Promise<void> {
    const fromLabel = this.storageLabel(from);
    const toLabel = this.storageLabel(to);
    if (!targetHadData) {
      const copy = vscode.l10n.t('Copy bookmarks');
      const keep = vscode.l10n.t('Keep empty');
      const pick = await vscode.window.showInformationMessage(
        vscode.l10n.t('Storage changed to {0}. Copy your bookmarks from {1}?', toLabel, fromLabel),
        copy,
        keep,
      );
      if (pick === copy) {
        await this.migrateStorageData(prevData, 'copy');
      }
      return;
    }
    const merge = vscode.l10n.t('Merge');
    const replace = vscode.l10n.t('Replace');
    const keep = vscode.l10n.t('Keep existing');
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t('Storage changed to {0}, which already has bookmarks. What would you like to do with bookmarks from {1}?', toLabel, fromLabel),
      merge,
      replace,
      keep,
    );
    if (pick === merge) {
      await this.migrateStorageData(prevData, 'merge');
    } else if (pick === replace) {
      await this.migrateStorageData(prevData, 'replace');
    }
  }

  dispose(): void {
    void this.flush();
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

  /** 目前分支名稱（由 BranchService 提供），決定「只屬於某分支」的書籤要不要顯示。 */
  branchOf: (folder: vscode.WorkspaceFolder) => string | undefined = () => undefined;

  isVisible(folder: vscode.WorkspaceFolder, b: LineBookmark): boolean {
    return visibleOnBranch(b, this.branchOf(folder));
  }

  /** 來源篩選：被隱藏的來源（自己的為空字串）。只影響顯示，書籤仍會跟著程式碼移動。 */
  private hiddenSources = new Set<string>();
  /** 篩選變了：由 extension 存進 workspace state。 */
  onSourceFilterChanged: (hidden: string[]) => void = () => undefined;

  get hiddenSourceList(): string[] {
    return [...this.hiddenSources];
  }

  setHiddenSources(list: string[]): void {
    this.hiddenSources = new Set(list);
    this.onSourceFilterChanged(this.hiddenSourceList);
    this.changed.fire();
  }

  /** 匯入後確保看得到這些來源。 */
  showSources(sources: string[]): void {
    if (sources.some((s) => this.hiddenSources.has(s))) {
      this.setHiddenSources(this.hiddenSourceList.filter((s) => !sources.includes(s)));
    }
  }

  /** 依來源篩選，這筆書籤要不要顯示（行號書籤、函式書籤都適用；函式書籤一律是自己的）。 */
  shownBySource(b: { source?: { author: string } }): boolean {
    return !this.hiddenSources.has(b.source?.author ?? '');
  }

  /** 函式書籤（一律是自己的）目前要不要顯示。 */
  get favoritesShown(): boolean {
    return !this.hiddenSources.has('');
  }

  /** 行號書籤在目前分支上：不是只屬於別的分支，也不是「不在此分支」（那時行號對應的是別的分支的內容）。 */
  isPresent(folder: vscode.WorkspaceFolder, b: LineBookmark): boolean {
    return this.isVisible(folder, b) && b.status !== 'notOnBranch';
  }

  /** 畫面上顯示的行號書籤：在目前分支上，且來源沒被篩選掉。行號旁圖示、搜尋、跳轉與游標所在行的操作都以此為準。 */
  isShown(folder: vscode.WorkspaceFolder, b: LineBookmark): boolean {
    return this.isPresent(folder, b) && this.shownBySource(b);
  }

  /** 某個檔案畫面上顯示的行號書籤（依行號排序）。 */
  shownBookmarksFor(uri: vscode.Uri): LineBookmark[] {
    const loc = this.locate(uri);
    return loc ? this.bookmarksFor(uri).filter((b) => this.isShown(loc.folder, b)) : [];
  }

  /** 所有畫面上顯示的行號書籤。`includeNotOnBranch`：側邊欄沒有隱藏「不在此分支」時也列出（灰色）。 */
  shownBookmarks(options: { includeNotOnBranch?: boolean } = {}): BookmarkEntry[] {
    return this.allBookmarks().filter(
      (e) => this.shownBySource(e.bookmark) && (options.includeNotOnBranch || e.bookmark.status !== 'notOnBranch'),
    );
  }

  /** 所有出現過的匯入來源（不含自己），依名稱排序。 */
  sources(): string[] {
    const out = new Set<string>();
    for (const d of this.data.values()) {
      for (const b of d.bookmarks ?? []) {
        if (b.source) {
          out.add(b.source.author);
        }
      }
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  /** 所有書籤（行號書籤與函式書籤）使用過的標籤，去重並排序。 */
  allTags(): string[] {
    const out = new Set<string>();
    for (const e of this.allBookmarks()) {
      for (const t of e.bookmark.tags ?? []) {
        out.add(t);
      }
    }
    for (const f of this.allFavorites()) {
      for (const t of f.mark.tags ?? []) {
        out.add(t);
      }
    }
    return [...out].sort();
  }

  /** 所有資料夾的標籤顏色（同一個標籤在不同資料夾設了不同顏色時，以第一個資料夾為準）。 */
  tagColors(): Map<string, string> {
    const out = new Map<string, string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const [tag, color] of Object.entries(this.data.get(uriKey(folder.uri))?.tagColors ?? {})) {
        if (!out.has(tag)) {
          out.set(tag, color);
        }
      }
    }
    return out;
  }

  /** 已經用掉的號碼：號碼 → 書籤（行號書籤或函式書籤）。包含目前隱藏的書籤（號碼仍被佔用）。 */
  numbered(): Map<number, NumberedEntry> {
    const out = new Map<number, NumberedEntry>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const d = this.data.get(uriKey(folder.uri));
      for (const bookmark of d?.bookmarks ?? []) {
        if (bookmark.number && !out.has(bookmark.number)) {
          out.set(bookmark.number, { kind: 'line', folder, uri: this.uriOf(folder, bookmark.file), bookmark });
        }
      }
      for (const mark of d?.symbols ?? []) {
        if (mark.favorite && mark.number && !out.has(mark.number)) {
          out.set(mark.number, { kind: 'symbol', folder, uri: this.uriOf(folder, mark.file), mark });
        }
      }
    }
    return out;
  }

  /** 通知畫面重新整理（例如切換分支後，顯示的書籤不同了）。 */
  notifyChanged(): void {
    this.changed.fire();
  }

  /** 所有書籤；預設不含只屬於別的分支（目前隱藏）的書籤。 */
  allBookmarks(options: { includeHidden?: boolean } = {}): BookmarkEntry[] {
    const out: BookmarkEntry[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const bookmark of this.data.get(uriKey(folder.uri))?.bookmarks ?? []) {
        if (!options.includeHidden && !this.isVisible(folder, bookmark)) {
          continue;
        }
        out.push({ folder, bookmark, uri: this.uriOf(folder, bookmark.file) });
      }
    }
    return out;
  }

  /** 這個檔案有沒有函式標記（書籤、自訂名稱、備註）。 */
  hasSymbolMarks(uri: vscode.Uri): boolean {
    const loc = this.locate(uri);
    return !!loc && (this.data.get(uriKey(loc.folder.uri))?.symbols ?? []).some((m) => m.file === loc.rel);
  }

  /** 這個資料夾目前有沒有任何書籤資料（函式標記、行號書籤或標籤顏色）。 */
  hasData(folder: vscode.WorkspaceFolder): boolean {
    const d = this.data.get(uriKey(folder.uri));
    return !!d && (d.symbols.length > 0 || (d.bookmarks ?? []).length > 0 || Object.keys(d.tagColors ?? {}).length > 0);
  }

  /** 這個資料夾的 tagColors 裡有沒有這個標籤的顏色設定。 */
  hasTagColor(folder: vscode.WorkspaceFolder, tag: string): boolean {
    const tc = this.data.get(uriKey(folder.uri))?.tagColors;
    return !!tc && Object.prototype.hasOwnProperty.call(tc, tag);
  }

  /** 某個檔案的書籤（依行號排序）。 */
  bookmarksFor(uri: vscode.Uri, options: { includeHidden?: boolean } = {}): LineBookmark[] {
    const loc = this.locate(uri);
    if (!loc) {
      return [];
    }
    return (this.data.get(uriKey(loc.folder.uri))?.bookmarks ?? [])
      .filter((b) => b.file === loc.rel && (options.includeHidden || this.isVisible(loc.folder, b)))
      .sort((a, b) => a.line - b.line);
  }

  isBroken(folder: vscode.WorkspaceFolder): boolean {
    return this.broken.has(uriKey(folder.uri));
  }

  /**
   * 修改某個資料夾的資料；回傳同一個物件代表沒有變化，不會存檔。
   * `deferSave`：編輯時頻繁變動（例如行號平移）用，稍後再一次寫檔。
   */
  async update(
    folder: vscode.WorkspaceFolder,
    fn: (data: StoreData) => StoreData,
    options: { deferSave?: boolean } = {},
  ): Promise<boolean> {
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
    if (options.deferSave) {
      this.scheduleSave(folder);
    } else {
      this.cancelScheduledSave(key);
      await this.save(folder, after);
    }
    this.changed.fire();
    return true;
  }

  private scheduleSave(folder: vscode.WorkspaceFolder): void {
    const key = uriKey(folder.uri);
    this.cancelScheduledSave(key);
    this.pendingSaves.set(
      key,
      setTimeout(() => {
        this.pendingSaves.delete(key);
        const data = this.data.get(key);
        if (data) {
          void this.save(folder, data);
        }
      }, 800),
    );
  }

  private cancelScheduledSave(key: string): void {
    const t = this.pendingSaves.get(key);
    if (t) {
      clearTimeout(t);
      this.pendingSaves.delete(key);
    }
  }

  /** 立刻寫入延後中的變更（關閉編輯器、測試時用）。 */
  async flush(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const key = uriKey(folder.uri);
      if (this.pendingSaves.has(key)) {
        this.cancelScheduledSave(key);
        const data = this.data.get(key);
        if (data) {
          await this.save(folder, data);
        }
      }
    }
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
      await this.load(folder, true);
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

  /** 讀取資料；回傳是否有變化。非強制載入時，自己剛寫入的內容不重複載入。 */
  private async load(folder: vscode.WorkspaceFolder, force = false): Promise<boolean> {
    const key = uriKey(folder.uri);
    if (storageMode() === 'workspaceState') {
      const raw = this.context.workspaceState.get<string>(STATE_KEY + key);
      this.data.set(key, (raw && parseStore(raw)) || emptyStore());
      return true;
    }
    let text: string | undefined;
    const file = this.fileUri(folder);
    try {
      // 本機檔案直接用 fs 讀取，避免啟動時走 VS Code FS IPC 排隊
      text =
        file.scheme === 'file'
          ? await fs.readFile(file.fsPath, 'utf8')
          : new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    } catch {
      text = undefined;
    }
    if (!force && (this.saving.get(key) || this.pendingSaves.has(key))) {
      return false;
    }
    if (!force && text !== undefined && this.recentWrites.get(key)?.includes(text)) {
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
    if (data.symbols.length === 0 && !(data.bookmarks ?? []).length && !Object.keys(data.tagColors ?? {}).length) {
      // 沒有任何資料時不主動建立檔案；已存在的檔案則更新為空清單
      // （之前只看函式書籤：專案裡只有行號書籤時不會建立檔案，重開後書籤就不見了）
      const exists = await vscode.workspace.fs.stat(file).then(
        () => true,
        () => false,
      );
      if (!exists) {
        return;
      }
    }
    this.recentWrites.set(key, [...(this.recentWrites.get(key) ?? []), text].slice(-3));
    this.saving.set(key, (this.saving.get(key) ?? 0) + 1);
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
    } finally {
      this.saving.set(key, (this.saving.get(key) ?? 1) - 1);
    }
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
