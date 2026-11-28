import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { normalizeUri, sameUri, uriKey } from '../util/uris';
import { relativeUnder } from '../util/paths';
import { SECTION, settingStorageMode, StorageMode, storageMode, WORKSPACE_STORAGE_KEY, WorkspaceStorageChoice, workspaceStorageOverride } from '../config';
import { DetectedSymbol } from '../detection/types';
import { BOOKMARKS_FILE } from './gitExclude';
import { decodeStoreText, storeTextToWrite } from '../core/storeFile';
import { ensureBookmarksFileExcluded } from './gitExcludeFs';
import { LineBookmark, visibleOnBranch } from '../bookmarks/model';
import { emptyStore, favorites, findMark, hasStoreData, MarkKey, mergeStoreData, parseStore, renamePath, serializeStore, StoreData, SymbolMark } from './marks';
import { HandledOppositeRecords, hashesOfDataMap, hashStoreData, oppositeStorageMode } from './storageMode';
import { SnapshotProtection } from './snapshotProtection';
import { collectNumbered, collectSources, collectTagColors, collectTags, FolderData } from './storeQueries';
import { askCopyFromOpposite, askMigration, pickStorageChoice, showStorageUnchanged, StoragePickItem, storagePickItems } from './storagePrompts';

export type { StoragePickItem };

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

/** 啟動或切換後在背景偵測到另一端存放位置有書籤的結果。 */
export interface OppositeStorageFound {
  from: StorageMode;
  to: StorageMode;
  data: Map<string, StoreData>;
}

/** 書籤資料變動通知：`symbolsChanged` 為 false 表示函式書籤（含標籤顏色）沒變，只有行號書籤變了。 */
export interface StoreChange {
  symbolsChanged: boolean;
}
const ALL_CHANGED: StoreChange = { symbolsChanged: true };

const STATE_KEY = 'marks:';
/** 檔案監看器略過「自己剛寫入的同一份最新內容」的時間視窗（毫秒）；逾時或改為不同版本時一律視為外部變更。 */
const RECENT_WRITE_TTL_MS = 5000;

/**
 * 每個工作區資料夾一份資料：預設存在 `.vscode/function-bookmarks.json`，
 * 也可改存編輯器的工作區儲存空間（不產生檔案）；個別工作區可透過指令覆寫全域設定。
 */
export class MarkStore implements vscode.Disposable {
  private data = new Map<string, StoreData>();
  /** 檔案內容壞掉的資料夾：不覆寫，避免把使用者手動修改的內容蓋掉。 */
  private broken = new Set<string>();
  /** 每個資料夾最近一次自己寫入的內容與時間戳：只略過短時間內同一份最新內容的重覆通知，手動還原成舊版不會被忽略。 */
  private lastWrite = new Map<string, { text: string; at: number }>();
  /** 每個資料夾的寫入序號：用來丟棄與寫入重疊的過期讀檔。 */
  private writeSeq = new Map<string, number>();
  /** 每次 reloadAll 遞增：用來丟棄切換儲存模式或工作區重載前尚未完成的舊讀檔。 */
  private reloadGen = 0;
  /** 每個資料夾進行中的單軌寫入迴圈（確保同一資料夾依序寫檔、不重疊）。 */
  private saveInFlight = new Map<string, Promise<void>>();
  /** 標記寫入途中又有更新的資料夾：目前寫入完成後自動補寫最新 `this.data`。 */
  private saveDirty = new Map<string, vscode.WorkspaceFolder>();
  /** 延後寫入中的資料夾（連同 folder 參考一起保存，資料夾移出工作區後 dispose 也能清乾淨）。 */
  private pendingSaves = new Map<string, { folder: vscode.WorkspaceFolder; timer: NodeJS.Timeout }>();
  private excludedChecked = new Set<string>();
  private watchers: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<StoreChange>();
  readonly onDidChange = this.changed.event;
  /** 切換存放位置或等待搬移決定期間，不可清除的分支快照（啟動檢查完成前也保護空白資料夾）。 */
  private readonly protection = new SnapshotProtection((folder) => this.hasData(folder));
  /** 快照保護範圍縮小（例如啟動檢查結束或使用者點了「保持空白」）：讓外部監看補清理不再需要的快照。 */
  readonly onDidChangeSnapshotProtection = this.protection.onDidChange;
  /** 已處理過的另一端來源資料（雜湊）。 */
  private readonly handledOpposite: HandledOppositeRecords;
  private oppositeCheckInFlight: Promise<OppositeStorageFound | undefined> | undefined;
  private disposables: vscode.Disposable[] = [];
  private mode: StorageMode;
  private oppositePromptActive = false;
  /** 給測試用：最近一次切換儲存模式時準備搬移的資訊（來源有資料時才記錄）。 */
  lastStorageSwitch?: { from: StorageMode; to: StorageMode; targetHadData: boolean; prevData: Map<string, StoreData> };
  /** 給測試用：最近一次背景檢查另一端存放位置時發現的可複製資料。 */
  lastOppositeCheck?: OppositeStorageFound;
  /** 給測試用：停用互動通知避免測試中殘留提示。 */
  suppressStoragePrompt = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.handledOpposite = new HandledOppositeRecords(context.workspaceState);
    this.mode = this.effectiveStorageMode();
  }

  /** 目前這個工作區生效的存放模式：個別選擇優先，否則使用設定（全系統單一來源）。 */
  effectiveStorageMode(): StorageMode {
    return storageMode(this.context.workspaceState);
  }

  /** 目前這個工作區個別選擇的存放模式；undefined 代表跟隨設定。 */
  workspaceStorageOverride(): StorageMode | undefined {
    return workspaceStorageOverride(this.context.workspaceState);
  }

  /** 這個檔案（uriKey）是否正在等待搬移決定，暫時不可清除其分支快照。 */
  isSnapshotProtected(fileUriKey: string): boolean {
    return this.protection.isProtected(fileUriKey);
  }

  /** 等目前進行中的另一端存放背景檢查完成（供外部監看與測試同步用）。 */
  async waitOppositeCheck(): Promise<void> {
    if (this.oppositeCheckInFlight) {
      await this.oppositeCheckInFlight;
    }
  }

  /** 兩條路徑是否指向同一份書籤檔（Windows 忽略大小寫）。 */
  private sameBookmarksFile(folder: vscode.WorkspaceFolder, uri: vscode.Uri): boolean {
    const active = this.fileUri(folder);
    if (process.platform === 'win32' && active.scheme === 'file' && uri.scheme === 'file') {
      return active.fsPath.toLowerCase() === uri.fsPath.toLowerCase();
    }
    return sameUri(active, uri);
  }

  /** 指定檔案是不是這個資料夾目前正在使用的書籤檔（存放模式為 file 且路徑相同）。 */
  isActiveBookmarksFile(folder: vscode.WorkspaceFolder, uri: vscode.Uri): boolean {
    return this.effectiveStorageMode() === 'file' && this.sameBookmarksFile(folder, uri);
  }

  /**
   * 透過「匯入書籤」匯入書籤檔後呼叫：若匯入的內容與另一端存放位置相同（或正是該資料夾的 `.vscode/function-bookmarks.json`），
   * 記為已處理（handledOppositeStorage）並解除快照保護，避免之後重開又重複提示複製。
   */
  async markOppositeHandledIfMatches(
    folder: vscode.WorkspaceFolder,
    importedData: StoreData,
    sourceUri?: vscode.Uri,
  ): Promise<boolean> {
    const mode = this.effectiveStorageMode();
    const opposite = oppositeStorageMode(mode);
    const other = await this.readFromStorage(folder, opposite);
    if (!hasStoreData(other)) {
      return false;
    }
    const otherHash = hashStoreData(other!);
    const matchesContent = hashStoreData(importedData) === otherHash;
    const matchesOppositeFile = mode === 'workspaceState' && !!sourceUri && this.sameBookmarksFile(folder, sourceUri);
    if (!matchesContent && !matchesOppositeFile) {
      return false;
    }
    const fkey = uriKey(folder.uri);
    await this.markOppositeHandled(mode, { [fkey]: otherHash });
    this.protection.release(this.collectBookmarkFileKeys(new Map([[fkey, other!]])));
    if (this.lastOppositeCheck?.to === mode && this.lastOppositeCheck.data.has(fkey)) {
      this.lastOppositeCheck.data.delete(fkey);
      if (this.lastOppositeCheck.data.size === 0) {
        this.lastOppositeCheck = undefined;
      }
    }
    return true;
  }

  async init(): Promise<void> {
    this.mode = this.effectiveStorageMode();
    await this.reloadAll();
    // 若有空白資料夾，啟動背景檢查另一端存放完成前先保護快照（避免 activate 期間的 onDidChange 提前清光）
    this.protection.beginStartupCheck((vscode.workspace.workspaceFolders ?? []).some((f) => !this.hasData(f) && !this.isBroken(f)));
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.flush().then(() => this.reloadAll()).then(() => this.checkOppositeStorage());
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.storage`)) {
          void this.onStorageModeChanged();
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => void this.onRename(e)),
    );
  }

  /** 建立「選擇這個專案的書籤存放位置」QuickPick 項目：標出目前選項與實際生效的存放端。 */
  storagePickItems(): StoragePickItem[] {
    return storagePickItems({ override: this.workspaceStorageOverride(), setting: settingStorageMode(), effective: this.effectiveStorageMode() });
  }

  /**
   * 讓使用者為這個工作區個別選擇書籤存放位置，或恢復跟隨設定。
   * 選擇存在 workspaceState（不寫進專案任何檔案）；實際存放模式改變時沿用既有搬移流程。
   */
  async chooseStorage(choice?: WorkspaceStorageChoice): Promise<StorageMode | undefined> {
    const effective = this.effectiveStorageMode();
    let picked = choice;
    if (picked === undefined) {
      picked = await pickStorageChoice(this.storagePickItems(), effective);
      if (picked === undefined) {
        return undefined;
      }
    }
    const nextOverride: StorageMode | undefined = picked === 'setting' ? undefined : picked;
    await this.context.workspaceState.update(WORKSPACE_STORAGE_KEY, nextOverride);
    const prevMode = this.mode;
    await this.onStorageModeChanged();
    const nextMode = this.effectiveStorageMode();
    if (prevMode === nextMode && !this.suppressStoragePrompt) {
      showStorageUnchanged(nextOverride === undefined, nextMode);
    }
    return nextMode;
  }

  /** 切換 storage（file ↔ workspaceState）時載入新目標並提示是否搬移書籤，絕不悄悄覆蓋目標端既有資料。 */
  private async onStorageModeChanged(): Promise<void> {
    const nextMode = this.effectiveStorageMode();
    if (nextMode === this.mode) {
      return;
    }
    const prevMode = this.mode;
    await this.flush();
    const prevData = new Map(this.data);
    const sourceKeys = [...prevData.entries()].filter(([, d]) => hasStoreData(d)).map(([k]) => k);
    // 在 reloadAll 觸發外部監看 seed() 前先保護來源端檔案的分支快照，避免等待搬移決定時被清空
    this.protection.set(sourceKeys.length ? this.collectBookmarkFileKeys(prevData) : new Set());
    this.mode = nextMode;
    await this.reloadAll();
    // 主動切到新模式時，清掉該模式先前已處理過的紀錄，讓這次切換可以正常提示
    await this.clearHandledOpposite(nextMode);
    if (!sourceKeys.length) {
      return;
    }
    const targetHadData = sourceKeys.some((k) => hasStoreData(this.data.get(k)));
    this.lastStorageSwitch = { from: prevMode, to: nextMode, targetHadData, prevData };
    if (!this.suppressStoragePrompt) {
      void this.promptStorageMigration(prevMode, nextMode, prevData, targetHadData);
    }
  }

  /** 把切換前的書籤資料複製、合併或取代到目前的儲存端（供互動提示與測試使用）。 */
  async migrateStorageData(prevData: Map<string, StoreData>, action: 'copy' | 'merge' | 'replace'): Promise<void> {
    const handledHashes: Record<string, string> = {};
    const releaseFiles = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const fkey = uriKey(folder.uri);
      const src = prevData.get(fkey);
      if (!hasStoreData(src)) {
        continue;
      }
      handledHashes[fkey] = hashStoreData(src!);
      for (const b of src!.bookmarks ?? []) {
        releaseFiles.add(uriKey(this.uriOf(folder, b.file)));
      }
      await this.update(folder, (cur) => {
        if (action === 'merge') {
          return mergeStoreData(cur, src!);
        }
        // 使用者在通知開著的期間若已新增書籤，選複製時合併而非覆蓋
        if (action === 'copy' && hasStoreData(cur)) {
          return mergeStoreData(cur, src!);
        }
        return src!;
      });
    }
    await this.markOppositeHandled(this.mode, handledHashes);
    this.protection.release(releaseFiles);
  }

  /** 檢查目前存放端空白、但另一端存放位置有這個資料夾書籤的情況（啟動背景呼叫，不阻擋啟動）。 */
  checkOppositeStorage(): Promise<OppositeStorageFound | undefined> {
    const run = this.runCheckOppositeStorage();
    this.oppositeCheckInFlight = run;
    void run.finally(() => {
      if (this.oppositeCheckInFlight === run) {
        this.oppositeCheckInFlight = undefined;
      }
    });
    return run;
  }

  private async runCheckOppositeStorage(): Promise<OppositeStorageFound | undefined> {
    const wasPending = this.protection.startupPending;
    try {
      const currentMode = this.effectiveStorageMode();
      const opposite = oppositeStorageMode(currentMode);
      const candidates = (vscode.workspace.workspaceFolders ?? []).filter((folder) => !this.hasData(folder) && !this.isBroken(folder));
      if (!candidates.length) {
        this.lastOppositeCheck = undefined;
        return undefined;
      }
      const entries = await Promise.all(
        candidates.map(async (folder) => [folder, await this.readFromStorage(folder, opposite)] as const),
      );
      // 讀取期間若已切換模式，放棄這次結果
      if (this.effectiveStorageMode() !== currentMode) {
        return undefined;
      }
      const foundData = new Map<string, StoreData>();
      for (const [folder, other] of entries) {
        if (!hasStoreData(other) || this.hasData(folder)) {
          continue;
        }
        // 另一端內容雜湊與上次處理過（複製／合併／取代／保持空白）相同時不再提示，避免把刻意清光的書籤復活
        if (this.isOppositeSourceHandled(folder, currentMode, hashStoreData(other!))) {
          continue;
        }
        foundData.set(uriKey(folder.uri), other!);
      }
      if (!foundData.size) {
        this.lastOppositeCheck = undefined;
        return undefined;
      }
      this.protection.add(this.collectBookmarkFileKeys(foundData));
      const found: OppositeStorageFound = { from: opposite, to: currentMode, data: foundData };
      this.lastOppositeCheck = found;
      if (!this.suppressStoragePrompt && !this.oppositePromptActive) {
        void this.promptOppositeStorage(found);
      }
      return found;
    } finally {
      this.protection.finishStartupCheck(wasPending);
    }
  }

  /** 套用使用者對「另一端有書籤」提示的選擇（複製過來或保持空白並記住）。 */
  async applyOppositeStorageChoice(found: OppositeStorageFound, choice: 'copy' | 'keep'): Promise<void> {
    if (this.effectiveStorageMode() !== found.to) {
      return;
    }
    if (choice === 'copy') {
      await this.migrateStorageData(found.data, 'copy');
    } else {
      await this.markOppositeHandled(found.to, hashesOfDataMap(found.data));
      this.protection.release(this.collectBookmarkFileKeys(found.data));
    }
    this.lastOppositeCheck = undefined;
  }

  isOppositeSourceHandled(folder: vscode.WorkspaceFolder, mode: StorageMode, sourceHash: string): boolean {
    return this.handledOpposite.isHandled(uriKey(folder.uri), mode, sourceHash);
  }

  markOppositeHandled(mode: StorageMode, hashes: Record<string, string>): Promise<void> {
    return this.handledOpposite.mark(mode, hashes);
  }

  clearHandledOpposite(mode: StorageMode, folderKeys?: string[]): Promise<void> {
    return this.handledOpposite.clear(mode, folderKeys);
  }

  private collectBookmarkFileKeys(dataMap: Map<string, StoreData>): Set<string> {
    const out = new Set<string>();
    const folders = new Map((vscode.workspace.workspaceFolders ?? []).map((f) => [uriKey(f.uri), f]));
    for (const [fkey, data] of dataMap) {
      const folder = folders.get(fkey);
      if (!folder) {
        continue;
      }
      for (const b of data.bookmarks ?? []) {
        out.add(uriKey(this.uriOf(folder, b.file)));
      }
    }
    return out;
  }

  private async promptOppositeStorage(found: OppositeStorageFound): Promise<void> {
    this.oppositePromptActive = true;
    try {
      const choice = await askCopyFromOpposite(found.from, found.to);
      // 沒點任何選項（關掉或重開）：不記住已處理、保留快照保護，下次啟動會再提示
      if (choice) {
        await this.applyOppositeStorageChoice(found, choice);
      }
    } finally {
      this.oppositePromptActive = false;
    }
  }

  private async promptStorageMigration(
    from: StorageMode,
    to: StorageMode,
    prevData: Map<string, StoreData>,
    targetHadData: boolean,
  ): Promise<void> {
    const choice = await askMigration(from, to, targetHadData);
    // 通知開著的期間已經又切換到別的存放位置：這個選擇作廢
    if (!choice || this.effectiveStorageMode() !== to) {
      return;
    }
    if (choice === 'keep') {
      // 明確選擇保持空白／保留現有資料：記住來源雜湊並解除快照保護，避免之後清光書籤時把舊來源復活
      await this.markOppositeHandled(to, hashesOfDataMap(prevData));
      this.protection.release(this.collectBookmarkFileKeys(prevData));
      return;
    }
    await this.migrateStorageData(prevData, choice);
  }

  dispose(): void {
    // 立刻清掉所有延遲存檔 timer（包含已移出工作區的資料夾），並觸發寫入
    void this.flush().catch(() => undefined);
    [...this.watchers, ...this.disposables, this.changed, this.protection].forEach((d) => d.dispose());
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
    this.changed.fire(ALL_CHANGED);
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
    return collectSources(this.data.values());
  }

  /** 所有書籤（行號書籤與函式書籤）使用過的標籤，去重並排序。 */
  allTags(): string[] {
    return collectTags(this.allBookmarks(), this.allFavorites());
  }

  /** 所有資料夾的標籤顏色（同一個標籤在不同資料夾設了不同顏色時，以第一個資料夾為準）。 */
  tagColors(): Map<string, string> {
    return collectTagColors(this.folderData());
  }

  /** 已經用掉的號碼：號碼 → 書籤（行號書籤或函式書籤）。包含目前隱藏的書籤（號碼仍被佔用）。 */
  numbered(): Map<number, NumberedEntry> {
    return collectNumbered(this.folderData(), (folder, rel) => this.uriOf(folder, rel));
  }

  /** 依工作區資料夾順序列出各資料夾的資料。 */
  private folderData(): FolderData[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ folder, data: this.data.get(uriKey(folder.uri)) }));
  }

  /** 通知畫面重新整理（例如切換分支後，顯示的書籤不同了）。 */
  notifyChanged(): void {
    this.changed.fire(ALL_CHANGED);
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
      await this.enqueueSave(folder);
    }
    // 只有行號書籤變了（例如打字造成的行號平移）時，函式書籤不必重新確認
    this.changed.fire({ symbolsChanged: after.symbols !== before.symbols || after.tagColors !== before.tagColors });
    return true;
  }

  private scheduleSave(folder: vscode.WorkspaceFolder): void {
    const key = uriKey(folder.uri);
    this.cancelScheduledSave(key);
    const timer = setTimeout(() => {
      this.pendingSaves.delete(key);
      if (this.data.has(key)) {
        void this.enqueueSave(folder).catch(() => undefined);
      }
    }, 800);
    this.pendingSaves.set(key, { folder, timer });
  }

  private cancelScheduledSave(key: string): void {
    const entry = this.pendingSaves.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.pendingSaves.delete(key);
    }
  }

  /**
   * 同一資料夾的寫入排成單軌（single-flight + coalescing）：
   * 正在寫檔時只標記 dirty，目前這趟寫完後自動再寫最新一份 `this.data`，避免並發覆蓋或亂序。
   */
  private enqueueSave(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = uriKey(folder.uri);
    this.saveDirty.set(key, folder);
    const existing = this.saveInFlight.get(key);
    if (existing) {
      return existing;
    }
    const loop = (async () => {
      while (this.saveDirty.has(key)) {
        const target = this.saveDirty.get(key)!;
        this.saveDirty.delete(key);
        const latest = this.data.get(key);
        if (latest) {
          await this.writeNow(target, latest);
        }
      }
    })().finally(() => {
      if (this.saveInFlight.get(key) === loop) {
        this.saveInFlight.delete(key);
      }
    });
    this.saveInFlight.set(key, loop);
    return loop;
  }

  /** 立刻寫入所有延後中的變更並等待進行中的寫入全部完成（停用擴充套件、切換儲存端、測試時用）。 */
  async flush(): Promise<void> {
    const pending = [...this.pendingSaves.entries()];
    this.pendingSaves.clear();
    for (const [key, entry] of pending) {
      clearTimeout(entry.timer);
      if (this.data.has(key)) {
        void this.enqueueSave(entry.folder);
      }
    }
    while (this.saveInFlight.size) {
      await Promise.all([...this.saveInFlight.values()]);
    }
  }

  private fileUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, ...BOOKMARKS_FILE.split('/'));
  }

  private async readFromStorage(folder: vscode.WorkspaceFolder, targetMode: StorageMode): Promise<StoreData | undefined> {
    const key = uriKey(folder.uri);
    if (targetMode === 'workspaceState') {
      const raw = this.context.workspaceState.get<string>(STATE_KEY + key);
      return raw ? parseStore(raw) : undefined;
    }
    const file = this.fileUri(folder);
    try {
      const text =
        file.scheme === 'file'
          ? await fs.readFile(file.fsPath, 'utf8')
          : new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
      return text.trim() ? parseStore(text) : undefined;
    } catch {
      return undefined;
    }
  }

  private async reloadAll(): Promise<void> {
    const gen = ++this.reloadGen;
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    this.data.clear();
    this.broken.clear();
    this.lastWrite.clear();
    const mode = this.mode;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await this.load(folder, true, gen);
      if (this.reloadGen !== gen) {
        return;
      }
      if (mode === 'file') {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, BOOKMARKS_FILE));
        const reload = () => {
          if (this.mode !== 'file' || this.reloadGen !== gen) {
            return;
          }
          void this.load(folder, false, gen).then((changed) => changed && this.changed.fire(ALL_CHANGED));
        };
        w.onDidChange(reload);
        w.onDidCreate(reload);
        w.onDidDelete(reload);
        this.watchers.push(w);
      }
    }
    this.changed.fire(ALL_CHANGED);
  }

  /** 讀取資料；回傳是否有變化。非強制載入時，自己剛寫入或過期的讀檔不重複載入。 */
  private async load(folder: vscode.WorkspaceFolder, force = false, expectedGen = this.reloadGen): Promise<boolean> {
    const key = uriKey(folder.uri);
    if (this.mode === 'workspaceState') {
      const raw = this.context.workspaceState.get<string>(STATE_KEY + key);
      this.data.set(key, (raw && parseStore(raw)) || emptyStore());
      return true;
    }
    const seqBefore = this.writeSeq.get(key) ?? 0;
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
    if (this.reloadGen !== expectedGen) {
      return false;
    }
    if (!force && (this.mode !== 'file' || this.saveInFlight.has(key) || this.pendingSaves.has(key) || (this.writeSeq.get(key) ?? 0) !== seqBefore)) {
      return false;
    }
    if (!force && text !== undefined) {
      const recent = this.lastWrite.get(key);
      if (recent) {
        if (Date.now() - recent.at > RECENT_WRITE_TTL_MS) {
          this.lastWrite.delete(key);
        } else if (recent.text === text) {
          return false;
        }
      }
    }
    // 讀到外部變更：清掉自己最近寫入紀錄，確保之後若再改回舊內容也會正常載入
    this.lastWrite.delete(key);
    const decoded = decodeStoreText(text);
    if (decoded.kind === 'empty') {
      this.broken.delete(key);
      this.data.set(key, decoded.data);
      return true;
    }
    if (decoded.kind === 'broken') {
      if (!this.broken.has(key)) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('{0} is not valid JSON. Fix or delete it before making changes.', BOOKMARKS_FILE),
        );
      }
      this.broken.add(key);
      return false;
    }
    this.broken.delete(key);
    this.data.set(key, decoded.data);
    return true;
  }

  private async writeNow(folder: vscode.WorkspaceFolder, data: StoreData): Promise<void> {
    const key = uriKey(folder.uri);
    const text = serializeStore(data);
    if (this.mode === 'workspaceState') {
      await this.context.workspaceState.update(STATE_KEY + key, text);
      return;
    }
    const file = this.fileUri(folder);
    // 沒有任何資料時不主動建立檔案；已存在的檔案則更新為空清單（規則在 core/storeFile，CLI 共用）
    // 有資料時一定寫入，不必查檔案是否存在
    const exists = hasStoreData(data) || (await vscode.workspace.fs.stat(file).then(() => true, () => false));
    if (storeTextToWrite(data, exists) === undefined) {
      return;
    }
    this.writeSeq.set(key, (this.writeSeq.get(key) ?? 0) + 1);
    this.lastWrite.set(key, { text, at: Date.now() });
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
    } catch (err) {
      this.lastWrite.delete(key);
      throw err;
    } finally {
      this.writeSeq.set(key, (this.writeSeq.get(key) ?? 0) + 1);
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
