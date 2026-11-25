import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { findByPath, findInnermost } from '../detection/engine';
import { DetectedSymbol } from '../detection/types';
import { BranchState } from '../git/branch';
import { BranchChange, BranchService } from '../git/branchService';
import { renamePath, updateBookmarksInFile } from '../storage/marks';
import { Located, MarkStore } from '../storage/store';
import { openDocumentFor } from '../symbols/documentSource';
import { SymbolService } from '../symbols/symbolService';
import { languageForPath } from '../util/paths';
import { FileEvents } from '../util/fileEvents';
import { uriKey } from '../util/uris';
import { BranchPosition, isBlockReplace, isWholeDocumentReplace, LineBookmark, LineChange, makeAnchor } from './model';
import { applyLineChangeBatches, LineChangeBatch, onLineDeleteSetting } from './tracker';
import {
  BranchRelocateResult,
  conflictRegions,
  diffLines,
  hashLine,
  relocate,
  relocateBookmarks,
  relocateOnBranch,
  splitLines,
  updateLineHashes,
} from './relocate';

const STATE_KEY = 'snapshots:v2';
const LEGACY_STATE_KEY = 'snapshots:v1';
/** 每個檔案最多記住幾個分支的內容。 */
const MAX_BRANCH_SNAPSHOTS = 10;
/** git 正在改檔（index.lock）時，最多等多久再處理。 */
const MAX_BUSY_RETRIES = 60;
/** 偵測檔案改名時，候選檔案超過這個大小就不讀進來比對。 */
const MAX_RENAME_COMPARE_BYTES = 2 * 1024 * 1024;

interface PersistedState {
  known?: Record<string, number[]>;
  branch?: Record<string, string>;
  snaps?: Record<string, Record<string, number[]>>;
}

function hashText(text: string): number[] {
  return splitLines(text).map(hashLine);
}

function sameHashes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}

/** 兩份內容有幾成的行相同（判斷是不是同一個檔案被改名）。 */
function commonRatio(a: number[], b: number[]): number {
  const max = Math.max(a.length, b.length);
  if (!max) {
    return 1;
  }
  const removed = diffLines(a, b).reduce((n, h) => n + (h.oldEnd - h.oldStart), 0);
  return (a.length - removed) / max;
}

function isNotFound(err: unknown): boolean {
  return (
    (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') ||
    (err as { code?: string } | undefined)?.code === 'ENOENT'
  );
}

/** 分支 id（名稱，或 detached 時的 `@commit`）轉成可記錄位置的分支名稱。 */
function branchName(id: string | undefined): string | undefined {
  return id && !id.startsWith('@') ? id : undefined;
}

/**
 * 檔案在編輯器外被修改（git pull、切換分支、合併、其他工具、AI 改檔）時，換算行號書籤的位置。
 *
 * 每個有書籤的檔案都記住「書籤行號所對應的內容」（行雜湊）與當時的分支：
 * - 開著的檔案：編輯器裡的內容，每次編輯後更新（一般打字由 BookmarkTracker 平移）
 * - 沒開著的檔案：上次讀到的磁碟內容
 * 發現內容和記住的不同時，比對兩者的差異來換算行號，找不到的用 anchor 後備定位。
 *
 * 切換分支：離開時記下各書籤在該分支的位置與檔案內容，切回來時用那時的內容換算（來回切換不累積誤差）；
 * 在目前分支找不到的書籤標成「不在此分支」，切回去自動恢復。
 */
export class ExternalChangeWatcher implements vscode.Disposable {
  private known = new Map<string, number[]>();
  /** 記住的內容屬於哪個分支（分支 id）。 */
  private knownBranch = new Map<string, string>();
  /** 各分支最後記住的內容：檔案 → 分支名稱 → 行雜湊。 */
  private snaps = new Map<string, Map<string, number[]>>();
  /** 從磁碟重新載入、還沒換算的開著的檔案：這段期間的編輯也一起暫存，確認是一般編輯時重播平移，否則走差異換算。 */
  private pendingReload = new Set<string>();
  /** pendingReload 期間收到的編輯批次；若確認是編輯器內一般打字且非整份／多行區塊取代，直接重播平移避免誤刪書籤。 */
  private pendingEditorChanges = new Map<string, { batches: LineChangeBatch[]; useDiff: boolean }>();
  /** 正在結算誤判為重新載入的編輯器變更（避免重複或並發執行）。 */
  private flushing = new Map<string, Promise<void>>();
  private busyRetries = new Map<string, number>();
  private reloadWaits = new Map<string, number>();
  /** 檔案不見、還沒找到改名對象的次數（新檔案的通知可能比較晚到，再等一下）。 */
  private renameWaits = new Map<string, number>();
  /** 最近新出現的檔案（判斷改名用）。 */
  private recentCreates = new Map<string, { uri: vscode.Uri; at: number }>();
  private pending = new Map<string, vscode.Uri>();
  private timer: NodeJS.Timeout | undefined;
  private persistTimer: NodeJS.Timeout | undefined;
  private persisting: Promise<void> | undefined;
  private conflictTimers = new Map<string, NodeJS.Timeout>();
  /** 因合併衝突標成需確認的書籤（檔案 → 書籤 id），衝突解決後重新定位。 */
  private conflictLost = new Map<string, Set<string>>();
  private running: Promise<void> | undefined;
  private seedTimer: NodeJS.Timeout | undefined;
  private retryTimers = new Set<NodeJS.Timeout>();
  private versionSeq = 0;
  /** 前一次 seed 時有書籤的檔案：切換存放位置暫時清空又複製回來時，重新排程檢查。 */
  private lastBookmarked = new Set<string>();
  /** 前一次 seed 因存放位置切換／等待搬移確認而跳過清理快照，等保護解除後再補清。 */
  private deferredPrune = false;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: MarkStore,
    private readonly service: SymbolService,
    private readonly state: vscode.Memento,
    private readonly branches: BranchService,
    files: FileEvents,
  ) {
    this.load();
    this.lastBookmarked = new Set(this.bookmarkedUris().map(uriKey));
    const onFs = (uri: vscode.Uri) => {
      if (!openDocumentFor(uri) && this.has(uri)) {
        this.schedule([uri]);
      }
    };
    this.disposables.push(
      files.onDidChange(onFs),
      files.onDidCreate((uri) => {
        this.noteCreated(uri);
        onFs(uri);
      }),
      files.onDidDelete(onFs),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.workspace.onDidOpenTextDocument((doc) => this.has(doc.uri) && this.schedule([doc.uri])),
      vscode.workspace.onDidCloseTextDocument((doc) => this.onClose(doc)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!this.has(doc.uri)) {
          return;
        }
        const key = uriKey(doc.uri);
        // VS Code 在乾淨文件第一次編輯觸發 change 時 isDirty 尚未更新，會誤加入 pendingReload；
        // 若使用者在 300ms 內立刻存檔，須先結算換算再記住新內容，避免直接 remember() 蓋掉差異導致書籤錯位。
        if (this.pendingReload.has(key) || this.flushing.has(key)) {
          void this.flushEditorChanges(doc);
        } else {
          this.remember(doc.uri, hashText(doc.getText()));
        }
      }),
      vscode.window.onDidChangeWindowState((s) => s.focused && this.checkAll()),
      store.onDidChange(() => this.scheduleSeed()),
      store.onDidChangeSnapshotProtection(() => {
        if (this.deferredPrune) {
          this.scheduleSeed();
        }
      }),
      branches.onDidChange((e) => this.onBranchChange(e)),
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.seedTimer);
    this.retryTimers.forEach((t) => clearTimeout(t));
    this.conflictTimers.forEach((t) => clearTimeout(t));
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      void this.persist();
    }
    this.disposables.forEach((d) => d.dispose());
  }

  /** 立刻把延後中的快照寫入 workspaceState，並等待進行中的寫入完成（停用擴充套件時呼叫）。 */
  async flushPersist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      await this.persist();
    }
    if (this.persisting) {
      await this.persisting;
    }
  }

  /** 啟動時：檢查所有有書籤的檔案。 */
  async init(): Promise<void> {
    this.checkAll();
    await this.idle();
  }

  /** 檢查所有有書籤的檔案（Git HEAD 變動、視窗回到前景）。 */
  checkAll(): void {
    this.schedule(this.bookmarkedUris(), 0);
  }

  /** 等目前排定的檢查都做完（測試用）。 */
  async idle(): Promise<void> {
    await this.store.waitOppositeCheck();
    while (this.seedTimer || this.timer || this.running || this.retryTimers.size || this.flushing.size) {
      if (this.seedTimer) {
        clearTimeout(this.seedTimer);
        this.seedTimer = undefined;
        this.seed();
      }
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
        void this.run();
      }
      if (this.running) {
        await this.running;
      } else if (this.flushing.size) {
        await Promise.all(this.flushing.values());
      } else if (this.retryTimers.size) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  /**
   * 立刻結算被誤判成從磁碟重新載入的編輯器變更：
   * VS Code 擴充主機在乾淨文件第一次編輯觸發 change 事件時 isDirty 尚未更新（仍為 false），
   * onChange 會將它放進 pendingReload 等待 300ms；此處改用編輯器內的修改規則（依 onLineDelete 設定）
   * 換算書籤，寫入完成後再記住新內容。沒有待處理項目時什麼都不做（可重複呼叫、冪等）。
   */
  flushEditorChanges(doc: vscode.TextDocument): Promise<void> {
    const key = uriKey(doc.uri);
    const active = this.flushing.get(key);
    if (active) {
      return active;
    }
    if (!this.pendingReload.has(key)) {
      return Promise.resolve();
    }
    const buffered = this.pendingEditorChanges.get(key);
    this.pendingReload.delete(key);
    this.pendingEditorChanges.delete(key);
    this.pending.delete(key);
    if (!this.known.has(key)) {
      return Promise.resolve();
    }
    const task = (async () => {
      if (buffered && !buffered.useDiff && buffered.batches.length > 0) {
        // 證實是一般打字／單純增刪行：用 BookmarkTracker 同套平移規則，改寫書籤行文字時書籤留在原行
        await applyLineChangeBatches(this.store, doc, buffered.batches);
      } else {
        await this.relocateBuffer(doc);
      }
      this.remember(doc.uri, hashText(doc.getText()));
      this.scheduleConflictCheck(doc);
    })().finally(() => {
      this.flushing.delete(key);
    });
    this.flushing.set(key, task);
    return task;
  }

  /** 這個檔案鍵是否屬於指定的 workspace 資料夾（多資料夾隔離分支快照用）。 */
  private keyInFolder(fileUriKey: string, folder: vscode.WorkspaceFolder): boolean {
    try {
      const loc = this.store.locate(vscode.Uri.parse(fileUriKey));
      return !!loc && uriKey(loc.folder.uri) === uriKey(folder.uri);
    } catch {
      return false;
    }
  }

  /** 這個分支在某檔案記住的內容（測試、清理用）。 */
  snapshotBranches(uri: vscode.Uri): string[] {
    return [...(this.snaps.get(uriKey(uri))?.keys() ?? [])];
  }

  /** 清掉指定分支記住的內容；給定 folder 時只清該資料夾的檔案，避免誤刪其他資料夾仍在用的快照。 */
  forgetBranches(names: string[], folder?: vscode.WorkspaceFolder): void {
    let changed = false;
    for (const [k, m] of this.snaps) {
      if (folder && !this.keyInFolder(k, folder)) {
        continue;
      }
      for (const n of names) {
        if (m.delete(n)) {
          changed = true;
        }
      }
    }
    if (changed) {
      this.persistSoon();
    }
  }

  /** 所有記住內容的分支名稱；給定 folder 時只回傳該資料夾的檔案。 */
  rememberedBranches(folder?: vscode.WorkspaceFolder): string[] {
    const out = new Set<string>();
    for (const [k, m] of this.snaps) {
      if (folder && !this.keyInFolder(k, folder)) {
        continue;
      }
      for (const n of m.keys()) {
        out.add(n);
      }
    }
    return [...out];
  }

  private has(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && this.store.bookmarksFor(uri, { includeHidden: true }).length > 0;
  }

  private bookmarkedUris(folder?: vscode.WorkspaceFolder): vscode.Uri[] {
    const seen = new Map<string, vscode.Uri>();
    for (const e of this.store.allBookmarks({ includeHidden: true })) {
      if (!folder || e.folder.uri.toString() === folder.uri.toString()) {
        seen.set(uriKey(e.uri), e.uri);
      }
    }
    return [...seen.values()];
  }

  private schedule(uris: vscode.Uri[], delay = 300): void {
    for (const u of uris) {
      this.pending.set(uriKey(u), u);
    }
    if (!this.pending.size) {
      return;
    }
    clearTimeout(this.timer);
    // 外部工具常一次改很多檔、或分好幾次寫入：等安靜下來再一起處理
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delay);
  }

  private run(): Promise<void> {
    if (this.running) {
      return this.running;
    }
    this.running = (async () => {
      while (this.pending.size) {
        const batch = [...this.pending.values()];
        this.pending.clear();
        // 同一個批次內每個資料夾只讀一次 git 分支，避免 50 個書籤檔重複讀 50 次 .git/HEAD
        const branchCache = new Map<string, Promise<BranchState | undefined>>();
        const deferSave = batch.length > 1;
        let next = 0;
        const workers = Math.min(8, batch.length);
        await Promise.all(
          Array.from({ length: workers }, async () => {
            while (next < batch.length) {
              const uri = batch[next++];
              try {
                await this.sync(uri, branchCache, deferSave);
              } catch {
                // 讀不到（沒有權限等）就略過，下次再試
              }
            }
          }),
        );
        if (deferSave) {
          await this.store.flush();
        }
      }
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async readDisk(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return uri.scheme === 'file'
        ? await fs.readFile(uri.fsPath, 'utf8')
        : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  /** 稍後再處理（git 正在改檔、等編輯器重新載入、等改名後的檔案出現）。 */
  private retryLater(uri: vscode.Uri, countBusy = true): void {
    const key = uriKey(uri);
    if (countBusy) {
      this.busyRetries.set(key, (this.busyRetries.get(key) ?? 0) + 1);
    }
    const t = setTimeout(() => {
      this.retryTimers.delete(t);
      this.schedule([uri], 0);
    }, 500);
    this.retryTimers.add(t);
  }

  /** 讀目前分支；git 正在改檔時回傳 'busy'（等太久就不再等）。 */
  private async branchFor(
    uri: vscode.Uri,
    loc: Located,
    branchCache?: Map<string, Promise<BranchState | undefined>>,
  ): Promise<{ id?: string; name?: string } | 'busy'> {
    const fkey = uriKey(loc.folder.uri);
    let p = branchCache?.get(fkey);
    if (!p) {
      p = this.branches.read(loc.folder);
      branchCache?.set(fkey, p);
    }
    const br = await p;
    const key = uriKey(uri);
    if (br?.busy && (this.busyRetries.get(key) ?? 0) < MAX_BUSY_RETRIES) {
      this.retryLater(uri);
      return 'busy';
    }
    this.busyRetries.delete(key);
    return { id: br?.id, name: br?.name };
  }

  /** 比對記住的內容與目前內容（開著的用編輯器內容，否則讀磁碟），不同就換算書籤。 */
  private async sync(
    uri: vscode.Uri,
    branchCache?: Map<string, Promise<BranchState | undefined>>,
    deferSave = false,
  ): Promise<void> {
    if (!this.has(uri)) {
      return;
    }
    const doc = openDocumentFor(uri);
    let text: string;
    let languageId: string | undefined;
    const key = uriKey(uri);
    let fromDisk = false;
    if (doc) {
      if (doc.isDirty && this.pendingReload.has(key)) {
        // VS Code 在乾淨文件第一次編輯觸發 change 時 isDirty 尚未更新，會誤加入 pendingReload；
        // 到這裡時文件已是 isDirty，代表是編輯器內的修改而非真正的磁碟重新載入，改走編輯器規則換算。
        await this.flushEditorChanges(doc);
        this.checkConflicts(doc);
        return;
      }
      text = doc.getText();
      languageId = doc.languageId;
      if (!doc.isDirty) {
        // 磁碟已經改了、編輯器還沒重新載入：等它載入（換算以載入後的內容為準）；等太久就直接用磁碟內容
        const disk = await this.readDisk(uri);
        if (disk !== undefined && disk !== text) {
          const waits = this.reloadWaits.get(key) ?? 0;
          if (waits < 4) {
            this.reloadWaits.set(key, waits + 1);
            this.retryLater(uri, false);
            return;
          }
          text = disk;
          fromDisk = true;
        }
      }
      this.reloadWaits.delete(key);
    } else {
      try {
        text =
          uri.scheme === 'file'
            ? await fs.readFile(uri.fsPath, 'utf8')
            : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch (err) {
        if (isNotFound(err)) {
          await this.missing(uri, branchCache);
          return;
        }
        throw err;
      }
      languageId = languageForPath(uri.path);
    }
    await this.apply(uri, text, languageId, fromDisk, branchCache, deferSave);
    if (doc && !fromDisk) {
      this.checkConflicts(doc);
    }
  }

  /** 用記住的內容換算書籤到 `text`，之後記住 `text`。 */
  private async apply(
    uri: vscode.Uri,
    text: string,
    languageId: string | undefined,
    fromDisk = false,
    branchCache?: Map<string, Promise<BranchState | undefined>>,
    deferSave = false,
  ): Promise<void> {
    const key = uriKey(uri);
    const loc = this.store.locate(uri);
    if (!loc) {
      return;
    }
    const br = await this.branchFor(uri, loc, branchCache);
    if (br === 'busy') {
      return;
    }
    const hashes = hashText(text);
    const old = this.known.get(key);
    const prevId = this.knownBranch.get(key);
    if (!old) {
      // 第一次看到這個檔案（剛加書籤、從舊版升級）：書籤行號就是對應現在的內容
      this.pendingReload.delete(key);
      this.pendingEditorChanges.delete(key);
      this.remember(uri, hashes, br.id);
      return;
    }
    const switched = prevId !== undefined && br.id !== undefined && prevId !== br.id;
    if (sameHashes(old, hashes)) {
      this.pendingReload.delete(key);
      this.pendingEditorChanges.delete(key);
      if (br.id !== undefined && prevId !== br.id) {
        this.knownBranch.set(key, br.id);
        this.persistSoon();
      }
      await this.heal(uri, splitLines(text));
      return;
    }
    const all = this.store.bookmarksFor(uri, { includeHidden: true });
    if (!all.length) {
      this.pendingReload.delete(key);
      this.pendingEditorChanges.delete(key);
      this.remember(uri, hashes, br.id);
      return;
    }
    const lines = splitLines(text);
    const symbols = await this.symbolsOf(uri, text, languageId);
    const prevName = switched ? branchName(prevId) : undefined;
    const results = relocateOnBranch({
      bookmarks: all.map((b) => ({ ...b, hidden: !this.store.isVisible(loc.folder, b) })),
      oldHashes: old,
      newLines: lines,
      switched,
      prevBranch: prevName,
      curBranch: br.name,
      curSnapshot: br.name ? this.snaps.get(key)?.get(br.name) : undefined,
      symbolStart: (p) => findByPath(symbols, p)?.startLine,
    });
    // 換算期間檔案又被編輯（打字）的話，這次的結果作廢，以最新內容重來
    const doc = openDocumentFor(uri);
    if (doc && !fromDisk && doc.getText() !== text) {
      this.schedule([uri], 0);
      return;
    }
    if (prevName) {
      this.saveSnapshot(key, prevName, old);
    }
    this.pendingReload.delete(key);
    this.pendingEditorChanges.delete(key);
    this.remember(uri, hashes, br.id);
    this.trackConflictLost(key, lines, results);
    await this.write(loc, results, lines, symbols, deferSave);
  }

  /**
   * 內容沒變，但有書籤標著需確認／不在此分支、而那一行的內容就是原本那一行（例如檔案改名後找回來）：恢復正常。
   */
  private async heal(uri: vscode.Uri, lines: string[]): Promise<void> {
    const loc = this.store.locate(uri);
    if (!loc) {
      return;
    }
    const regions = conflictRegions(lines);
    const ok = (b: LineBookmark) =>
      (b.status === 'lost' || b.status === 'notOnBranch') &&
      !!b.anchor &&
      this.store.isVisible(loc.folder, b) &&
      lines[b.line]?.trim() === b.anchor.text &&
      !regions.some(([s, e]) => b.line >= s && b.line <= e);
    if (!this.store.bookmarksFor(uri).some(ok)) {
      return;
    }
    await this.store.update(loc.folder, (d) =>
      updateBookmarksInFile(d, loc.rel, (b) => {
        if (!ok(b)) {
          return b;
        }
        const next = { ...b };
        delete next.status;
        return next;
      }),
    );
  }

  /** 書籤所在的檔案不見了：改名就跟過去；切換分支造成的標成不在此分支；否則標成需確認。 */
  private async missing(uri: vscode.Uri, branchCache?: Map<string, Promise<BranchState | undefined>>): Promise<void> {
    const key = uriKey(uri);
    const loc = this.store.locate(uri);
    if (!loc) {
      return;
    }
    const br = await this.branchFor(uri, loc, branchCache);
    if (br === 'busy') {
      return;
    }
    const old = this.known.get(key);
    const target = old ? await this.findRename(uri, old) : undefined;
    if (!target && old && (this.renameWaits.get(key) ?? 0) < 2) {
      // 改名後的新檔案通知可能還沒到：等一下再找一次
      this.renameWaits.set(key, (this.renameWaits.get(key) ?? 0) + 1);
      this.retryLater(uri, false);
      return;
    }
    this.renameWaits.delete(key);
    const toLoc = target ? this.store.locate(target) : undefined;
    if (target && toLoc && toLoc.folder.uri.toString() === loc.folder.uri.toString()) {
      const toKey = uriKey(target);
      this.known.set(toKey, old!);
      this.known.delete(key);
      const b = this.knownBranch.get(key);
      if (b !== undefined) {
        this.knownBranch.set(toKey, b);
        this.knownBranch.delete(key);
      }
      const s = this.snaps.get(key);
      if (s) {
        this.snaps.set(toKey, s);
        this.snaps.delete(key);
      }
      this.persistSoon();
      await this.store.update(loc.folder, (d) => renamePath(d, loc.rel, toLoc.rel));
      this.schedule([target], 0);
      return;
    }
    const prevId = this.knownBranch.get(key);
    const switched = prevId !== undefined && br.id !== undefined && prevId !== br.id;
    const prevName = switched ? branchName(prevId) : undefined;
    if (prevName && old) {
      this.saveSnapshot(key, prevName, old);
    }
    if (br.id !== undefined) {
      // 記住的內容保留（屬於離開的分支），切回去時用來換算
      this.knownBranch.set(key, br.id);
      this.persistSoon();
    }
    await this.store.update(loc.folder, (d) =>
      updateBookmarksInFile(d, loc.rel, (b) => {
        const next: LineBookmark = { ...b };
        if (prevName) {
          const pos: BranchPosition = { line: b.line };
          if (b.status === 'lost' || b.status === 'notOnBranch') {
            pos.status = b.status;
          }
          next.positions = { ...b.positions, [prevName]: pos };
        }
        if (this.store.isVisible(loc.folder, b)) {
          next.status = switched || b.status === 'notOnBranch' ? 'notOnBranch' : 'lost';
        }
        return next;
      }),
    );
  }

  /** 從最近新出現的檔案中，找內容和記住的內容最相近的（同名、同副檔名優先），六成以上相同才算改名。 */
  private async findRename(uri: vscode.Uri, old: number[]): Promise<vscode.Uri | undefined> {
    const now = Date.now();
    const ext = path.posix.extname(uri.path);
    const base = path.posix.basename(uri.path);
    const candidates = [...this.recentCreates.values()]
      .filter((c) => now - c.at < 120_000 && uriKey(c.uri) !== uriKey(uri) && path.posix.extname(c.uri.path) === ext)
      .sort((a, b) => Number(path.posix.basename(b.uri.path) === base) - Number(path.posix.basename(a.uri.path) === base) || b.at - a.at)
      .slice(0, 30);
    let best: vscode.Uri | undefined;
    let bestScore = 0.6;
    for (const c of candidates) {
      if (this.store.bookmarksFor(c.uri, { includeHidden: true }).length) {
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

  private noteCreated(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') {
      return;
    }
    this.recentCreates.set(uriKey(uri), { uri, at: Date.now() });
    if (this.recentCreates.size > 500) {
      const oldest = [...this.recentCreates.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
      oldest.forEach(([k]) => this.recentCreates.delete(k));
    }
  }

  /**
   * 分支變了：還沒處理到的檔案先記下在離開的分支上的位置與內容（之後內容變動時再換算），
   * 再檢查所有檔案；只屬於某分支的書籤的顯示也跟著更新。
   */
  private onBranchChange(e: BranchChange): void {
    const fromName = e.from?.name;
    if (fromName && e.from) {
      const fromId = e.from.id;
      const keys = new Set<string>();
      for (const uri of this.bookmarkedUris(e.folder)) {
        const key = uriKey(uri);
        const old = this.known.get(key);
        if (old && this.knownBranch.get(key) === fromId) {
          this.saveSnapshot(key, fromName, old);
          keys.add(key);
        }
      }
      if (keys.size) {
        void this.store.update(e.folder, (d) => ({
          ...d,
          bookmarks: (d.bookmarks ?? []).map((b) => {
            if (!keys.has(uriKey(this.store.uriOf(e.folder, b.file)))) {
              return b;
            }
            const pos: BranchPosition = { line: b.line };
            if (b.status === 'lost' || b.status === 'notOnBranch') {
              pos.status = b.status;
            }
            return { ...b, positions: { ...b.positions, [fromName]: pos } };
          }),
        }));
      }
    }
    this.store.notifyChanged();
    this.checkAll();
  }

  private saveSnapshot(key: string, branch: string, hashes: number[]): void {
    const m = this.snaps.get(key) ?? new Map<string, number[]>();
    m.delete(branch);
    m.set(branch, hashes);
    while (m.size > MAX_BRANCH_SNAPSHOTS) {
      m.delete(m.keys().next().value as string);
    }
    this.snaps.set(key, m);
    this.persistSoon();
  }

  private async write(
    loc: Located,
    results: BranchRelocateResult[],
    lines: string[],
    symbols: DetectedSymbol[],
    deferSave = false,
  ): Promise<void> {
    const byId = new Map(results.map((r) => [r.id, r]));
    await this.store.update(
      loc.folder,
      (d) =>
        updateBookmarksInFile(d, loc.rel, (b) => {
          const r = byId.get(b.id);
          if (!r) {
            return b;
          }
          const next: LineBookmark = { ...b };
          if (r.positions) {
            next.positions = r.positions;
          }
          if (!this.store.isVisible(loc.folder, b)) {
            // 只屬於別的分支：位置與 anchor 對應的是那個分支的內容，不動
            return next;
          }
          next.line = r.line;
          if (r.status) {
            // 保留原本的 anchor，之後內容回來（衝突解決、切回分支）還能找回
            next.status = r.status;
          } else {
            delete next.status;
            const sym = findInnermost(symbols, r.line);
            next.anchor = makeAnchor(lines, r.line, sym?.path, sym?.startLine);
          }
          return next;
        }),
      deferSave ? { deferSave: true } : undefined,
    );
  }

  private trackConflictLost(key: string, lines: string[], results: BranchRelocateResult[]): void {
    const regions = conflictRegions(lines);
    const set = this.conflictLost.get(key) ?? new Set<string>();
    for (const r of results) {
      if (r.status === 'lost' && regions.some(([s, e]) => r.line >= s && r.line <= e)) {
        set.add(r.id);
      } else {
        set.delete(r.id);
      }
    }
    if (set.size) {
      this.conflictLost.set(key, set);
    } else {
      this.conflictLost.delete(key);
    }
  }

  private async symbolsOf(uri: vscode.Uri, text: string, languageId: string | undefined): Promise<DetectedSymbol[]> {
    if (!languageId) {
      return [];
    }
    try {
      const doc = openDocumentFor(uri);
      const same = doc && doc.getText() === text ? doc : undefined;
      const file = await this.service.getForSource(
        {
          uri,
          languageId,
          text,
          version: same ? `v${same.version}` : `ext:${++this.versionSeq}`,
          document: same,
        },
        // 沒在編輯器開啟的檔案背景換算時，不強制開啟文件觸發語言伺服器冷啟動
        { skipLsp: !same },
      );
      return file.symbols;
    } catch {
      return [];
    }
  }

  /**
   * 從磁碟重新載入（git checkout／pull、外部工具改檔時，編輯器自動載入新內容）：編輯後仍是「未修改」。
   * 注意：VS Code 在乾淨文件第一次編輯觸發 change 時 isDirty 尚未更新（仍為 false），也會誤判進 pendingReload；
   * 誤判的情況交由 sync()（見到 isDirty 變 true）與存檔時的 flushEditorChanges() 收尾。
   */
  private isReload(e: vscode.TextDocumentChangeEvent): boolean {
    return !e.document.isDirty && e.reason === undefined;
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    if (!e.contentChanges.length || !this.has(e.document.uri)) {
      return;
    }
    const doc = e.document;
    const key = uriKey(doc.uri);
    const changes = this.toChanges(e);
    if (this.known.has(key) && (this.pendingReload.has(key) || this.isReload(e))) {
      // 交給 apply 換算（含切換分支的處理）；同時暫存編輯內容，確認是編輯器內一般打字時重播平移，避免改寫行內文字被誤判成刪行
      this.pendingReload.add(key);
      const entry = this.pendingEditorChanges.get(key) ?? { batches: [], useDiff: false };
      entry.batches.push({ changes, lineCount: doc.lineCount });
      if (isWholeDocumentReplace(changes, doc.lineCount) || isBlockReplace(changes)) {
        entry.useDiff = true;
      }
      this.pendingEditorChanges.set(key, entry);
      this.schedule([doc.uri]);
      return;
    }
    if (this.handlesByDiff(e, changes)) {
      void this.relocateBuffer(doc);
    }
    // 一般編輯由 BookmarkTracker 平移；記住的內容跟著更新（只重算被改到的行，大檔打字不必每次整份雜湊）
    const old = this.known.get(key);
    const next = old && updateLineHashes(old, changes, doc.lineCount, (i) => doc.lineAt(i).text);
    this.remember(doc.uri, next ?? hashText(doc.getText()));
    this.scheduleConflictCheck(doc);
  }

  private toChanges(e: vscode.TextDocumentChangeEvent): LineChange[] {
    return e.contentChanges.map((c) => ({
      startLine: c.range.start.line,
      startChar: c.range.start.character,
      endLine: c.range.end.line,
      endChar: c.range.end.character,
      text: c.text.replace(/\r\n/g, '\n'),
    }));
  }

  /**
   * 這次編輯要不要改用差異換算（BookmarkTracker 會先問，回答 true 時它就不平移）：
   * 從磁碟重新載入、整份被取代（格式化工具），或多行換成多行（Cursor 套用 AI 修改、貼上覆蓋、Alt+↑↓ 移動行）。
   * 這類編輯若照行號平移，被換掉範圍內的書籤會被當成刪除；比對前後內容才找得到原本那一行。
   */
  handlesByDiff(e: vscode.TextDocumentChangeEvent, changes: LineChange[]): boolean {
    const key = uriKey(e.document.uri);
    if (!this.known.has(key)) {
      return false;
    }
    return (
      this.pendingReload.has(key) ||
      this.isReload(e) ||
      isWholeDocumentReplace(changes, e.document.lineCount) ||
      isBlockReplace(changes)
    );
  }

  /** 開著的文件：用編輯前記住的內容與目前內容比對，立刻換算（回傳 Promise 讓呼叫端可 await 寫入完成）。 */
  private async relocateBuffer(doc: vscode.TextDocument): Promise<void> {
    const loc = this.store.locate(doc.uri);
    const old = this.known.get(uriKey(doc.uri));
    const bookmarks = this.store.bookmarksFor(doc.uri);
    if (!loc || !old || !bookmarks.length) {
      return;
    }
    const lines = splitLines(doc.getText());
    const regions = conflictRegions(lines);
    const mode = onLineDeleteSetting(doc.uri);
    const results = new Map(relocateBookmarks(bookmarks, old, lines).map((r) => [r.id, r]));
    await this.store.update(
      loc.folder,
      (d) =>
        updateBookmarksInFile(d, loc.rel, (b) => {
          const r = results.get(b.id);
          if (!r) {
            return b;
          }
          const next: LineBookmark = { ...b, line: r.line };
          if (r.status === 'lost' && b.status === 'notOnBranch') {
            return next;
          }
          const inConflict = regions.some(([s, e]) => r.line >= s && r.line <= e);
          if (r.status === 'lost' && !inConflict) {
            // 在編輯器裡改的：依「刪除行時的行為」設定處理找不到的書籤
            if (mode === 'remove') {
              return undefined;
            }
            if (mode === 'moveToNext') {
              delete next.status;
              return next;
            }
          }
          if (r.status === 'lost') {
            next.status = 'lost';
          } else {
            delete next.status;
          }
          return next;
        }),
      { deferSave: true },
    );
  }

  private onClose(doc: vscode.TextDocument): void {
    if (!this.has(doc.uri)) {
      return;
    }
    const key = uriKey(doc.uri);
    // 關閉時沒存檔：書籤對應的是編輯器裡的內容，和磁碟不同，接著讀磁碟換算回去
    // （還沒換算的重新載入則保留原本記住的內容）
    if (!this.pendingReload.has(key)) {
      this.remember(doc.uri, hashText(doc.getText()));
    } else {
      this.pendingEditorChanges.delete(key);
    }
    this.schedule([doc.uri]);
  }

  /** 開著的檔案出現合併衝突時，把衝突範圍內的書籤標成需確認；衝突解決後重新定位。 */
  private scheduleConflictCheck(doc: vscode.TextDocument): void {
    const key = uriKey(doc.uri);
    clearTimeout(this.conflictTimers.get(key));
    this.conflictTimers.set(
      key,
      setTimeout(() => {
        this.conflictTimers.delete(key);
        this.checkConflicts(doc);
      }, 500),
    );
  }

  private checkConflicts(doc: vscode.TextDocument): void {
    const key = uriKey(doc.uri);
    const loc = this.store.locate(doc.uri);
    if (!loc || doc.isClosed) {
      return;
    }
    const text = doc.getText();
    const hadConflicts = this.conflictLost.has(key);
    if (!hadConflicts && !text.includes('<<<<<<<')) {
      return;
    }
    const lines = splitLines(text);
    const regions = conflictRegions(lines);
    const inConflict = (line: number) => regions.some(([s, e]) => line >= s && line <= e);
    const marked = this.conflictLost.get(key) ?? new Set<string>();
    const results: BranchRelocateResult[] = [];
    for (const b of this.store.bookmarksFor(doc.uri)) {
      if (b.status !== 'lost' && b.status !== 'notOnBranch' && inConflict(b.line)) {
        marked.add(b.id);
        results.push({ id: b.id, line: b.line, status: 'lost' });
      } else if (marked.has(b.id) && b.anchor) {
        const found = relocate(lines, b.anchor, b.line);
        if (found !== undefined && !inConflict(found)) {
          marked.delete(b.id);
          results.push({ id: b.id, line: found });
        }
      }
    }
    if (marked.size) {
      this.conflictLost.set(key, marked);
    } else {
      this.conflictLost.delete(key);
    }
    if (!results.length) {
      return;
    }
    void this.symbolsOf(doc.uri, text, doc.languageId).then((symbols) => {
      if (doc.getText() === text) {
        void this.write(loc, results, lines, symbols);
      }
    });
  }

  /** 書籤增減後：新加書籤的檔案記住目前內容，沒有書籤的檔案不再記住。 */
  private scheduleSeed(): void {
    clearTimeout(this.seedTimer);
    this.seedTimer = setTimeout(() => {
      this.seedTimer = undefined;
      this.seed();
    }, 200);
  }

  private seed(): void {
    const uris = this.bookmarkedUris();
    const keys = new Set(uris.map(uriKey));
    let removed = false;
    let deferred = false;
    for (const k of new Set([...this.known.keys(), ...this.snaps.keys()])) {
      if (!keys.has(k)) {
        // 切換存放位置或等待使用者決定是否從另一端複製書籤時，先保留分支快照，避免複製回來後快照消失
        if (this.store.isSnapshotProtected(k)) {
          deferred = true;
          continue;
        }
        this.known.delete(k);
        this.knownBranch.delete(k);
        this.snaps.delete(k);
        this.conflictLost.delete(k);
        removed = true;
      }
    }
    this.deferredPrune = deferred;
    if (removed) {
      this.persistSoon();
    }
    const toCheck = uris.filter((u) => {
      const k = uriKey(u);
      return !this.known.has(k) || !this.lastBookmarked.has(k);
    });
    this.lastBookmarked = keys;
    if (toCheck.length) {
      this.schedule(toCheck, 0);
    }
  }

  /** 記住內容；`branchId` 沒給時用目前分支（快取）。 */
  private remember(uri: vscode.Uri, hashes: number[], branchId?: string): void {
    const key = uriKey(uri);
    this.known.set(key, hashes);
    const id = branchId ?? this.branches.current(vscode.workspace.getWorkspaceFolder(uri))?.id;
    if (id !== undefined) {
      this.knownBranch.set(key, id);
    }
    this.persistSoon();
  }

  private load(): void {
    const saved = this.state.get<PersistedState>(STATE_KEY);
    const known = saved?.known ?? this.state.get<Record<string, number[]>>(LEGACY_STATE_KEY) ?? {};
    for (const [k, v] of Object.entries(known)) {
      if (Array.isArray(v)) {
        this.known.set(k, v);
      }
    }
    for (const [k, v] of Object.entries(saved?.branch ?? {})) {
      if (typeof v === 'string') {
        this.knownBranch.set(k, v);
      }
    }
    for (const [k, v] of Object.entries(saved?.snaps ?? {})) {
      if (v && typeof v === 'object') {
        this.snaps.set(k, new Map(Object.entries(v).filter(([, h]) => Array.isArray(h))));
      }
    }
  }

  private persistSoon(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 2000);
  }

  private persist(): Promise<void> {
    const data: PersistedState = {
      known: Object.fromEntries(this.known),
      branch: Object.fromEntries(this.knownBranch),
      snaps: Object.fromEntries([...this.snaps].map(([k, m]) => [k, Object.fromEntries(m)])),
    };
    const p = Promise.resolve(this.state.update(STATE_KEY, data)).then(
      () => undefined,
      () => undefined,
    );
    this.persisting = p;
    void p.finally(() => {
      if (this.persisting === p) {
        this.persisting = undefined;
      }
    });
    return p;
  }
}
