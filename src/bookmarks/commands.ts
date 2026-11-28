import * as vscode from 'vscode';
import { editorForJump } from '../util/revealEditor';
import { findInnermost } from '../detection/engine';
import { DetectedSymbol } from '../detection/types';
import { SECTION } from '../config';
import {
  addBookmark,
  findMark,
  MarkKey,
  removeBookmarks,
  setAlias,
  setFavorite,
  setSymbolExtras,
  unfavoriteFiles,
  updateBookmark,
} from '../storage/marks';
import { nextFreeNumber } from './decor';
import { BookmarkEntry, MarkStore } from '../storage/store';
import { FavoritesModel } from '../symbols/favorites';
import { SymbolService } from '../symbols/symbolService';
import { shownBookmarkItems } from './unified';
import { newLineBookmark, symbolAtNameLine } from '../core/resolve';
import { NoteEditor } from '../views/noteEditor';
import { BookmarkStatus, LineBookmark, makeAnchor, neighbor, parseTags, suggestName } from './model';
import { lineBookmarkTitle } from './sort';

/** 樹狀檢視的書籤節點（避免與 views/tree 互相引用，只描述需要的欄位）。 */
export interface BookmarkNodeLike {
  type: 'bookmark';
  entry: BookmarkEntry;
}

/** 提示中「在預覽中開啟」連結與側邊欄點擊書籤帶的參數。 */
export interface BookmarkLinkArg {
  uri: string;
  bookmark: string;
}

export function isBookmarkLinkArg(arg: unknown): arg is BookmarkLinkArg {
  const a = arg as Partial<BookmarkLinkArg> | undefined;
  return !!a && typeof a.uri === 'string' && typeof a.bookmark === 'string';
}

export function bookmarkTitle(b: LineBookmark): string {
  return lineBookmarkTitle(b);
}

/** 共用跳轉的目標描述（行號書籤或一般位置）。 */
export interface BookmarkJumpTarget {
  uri: vscode.Uri;
  line: number;
  /** 提示中顯示的相對路徑；省略時由 workspace.asRelativePath 推算。 */
  file?: string;
  /** 行號書籤狀態；為 'lost' 時跳轉後於狀態列提示需確認。 */
  status?: BookmarkStatus;
}

export interface JumpOptions {
  /** 檔案不存在時不顯示狀態列提示（供導覽／連續跳轉跳過不存在檔案時改由外層統一提示一次）。 */
  silentMissing?: boolean;
  /** 成功跳到目標行之後、顯示「需確認」狀態列提示之前執行。 */
  afterJump?: () => void;
}

/** 在狀態列提示書籤檔案已不存在（顯示 5 秒）。 */
export function notifyMissingBookmarkFile(rel: string): void {
  vscode.window.setStatusBarMessage(
    `$(warning) ${vscode.l10n.t('The file of this bookmark no longer exists: {0}', rel)}`,
    5000,
  );
}

/** 確認磁碟上仍有該檔案：剛關閉的分頁 VS Code 仍保有內容，直接開啟會冒出「已刪除」空分頁。 */
export async function ensureBookmarkFileExists(
  uri: vscode.Uri,
  file?: string,
  options?: Pick<JumpOptions, 'silentMissing'>,
): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    if (!options?.silentMissing) {
      const rel = file ?? vscode.workspace.asRelativePath(uri, false);
      notifyMissingBookmarkFile(rel);
    }
    return false;
  }
}

/**
 * 共用的書籤跳轉函式：先確認檔案仍存在於磁碟，再開到該行；
 * 若行號書籤標記為「需確認（lost）」，在狀態列短暫提示 5 秒引導修正。
 */
export async function jumpToBookmark(target: BookmarkJumpTarget, options?: JumpOptions): Promise<boolean> {
  if (!(await ensureBookmarkFileExists(target.uri, target.file, options))) {
    return false;
  }
  await revealLine(target.uri, target.line);
  options?.afterJump?.();
  if (target.status === 'lost') {
    vscode.window.setStatusBarMessage(
      `$(warning) ${vscode.l10n.t('This bookmark needs checking: its original line was not found. Put the cursor on the correct line and run "Move Bookmark to Cursor" to fix it.')}`,
      5000,
    );
  }
  return true;
}

export async function revealLine(uri: vscode.Uri, line: number): Promise<vscode.TextEditor> {
  const editor = await editorForJump(uri);
  const target = Math.min(line, editor.document.lineCount - 1);
  const col = editor.document.lineAt(target).firstNonWhitespaceCharacterIndex;
  const pos = new vscode.Position(target, col);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  return editor;
}

export class BookmarkCommands {
  constructor(
    private readonly store: MarkStore,
    private readonly service: SymbolService,
    private readonly notes: NoteEditor,
    private readonly favorites: FavoritesModel,
  ) {}

  /** 名稱剛好在這一行的符號（函式、類別、block…），有的話 Alt+Shift+B B 建立函式書籤。 */
  async symbolAtNameLine(doc: vscode.TextDocument, line: number): Promise<DetectedSymbol | undefined> {
    return symbolAtNameLine((await this.service.getSymbols(doc)).symbols, line);
  }

  /** 準備一筆新的行號書籤（含 anchor 與所在函式），尚未寫入 store。 */
  async prepareBookmark(doc: vscode.TextDocument, rel: string, line: number, label?: string): Promise<LineBookmark> {
    return this.newBookmark(doc, rel, line, label);
  }

  /** 若「我的」目前被來源篩選隱藏，跳出提示讓使用者可一鍵顯示。 */
  notifyIfMineHidden(): void {
    this.noticeMineHidden();
  }

  private async newBookmark(doc: vscode.TextDocument, rel: string, line: number, label?: string): Promise<LineBookmark> {
    const symbols = (await this.service.getSymbols(doc)).symbols;
    return newLineBookmark(doc.getText().split(/\r?\n/), symbols, rel, line, label);
  }

  private locateEditor(target?: { uri: vscode.Uri }): { editor: vscode.TextEditor; folder: vscode.WorkspaceFolder; rel: string } | undefined {
    const editor = target
      ? vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === target.uri.toString()) ?? vscode.window.activeTextEditor
      : vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const loc = this.store.locate(editor.document.uri);
    if (!loc) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Only files inside a workspace folder can be bookmarked.'));
      return undefined;
    }
    return { editor, folder: loc.folder, rel: loc.rel };
  }

  /**
   * 切換書籤；多游標時每一行各自切換。
   * - 這一行已有行號書籤：移除
   * - 游標在函式、類別、block 等名稱那一行：切換函式書籤
   * - 其他行：新增行號書籤
   * `target` 來自行號右鍵選單（指定檔案與行）。
   */
  async toggle(target?: { uri: vscode.Uri; line: number }): Promise<void> {
    const ctx = this.locateEditor(target);
    if (!ctx) {
      return;
    }
    const { editor, folder, rel } = ctx;
    const lines = target ? [target.line] : [...new Set(editor.selections.map((s) => s.active.line))];
    const existing = this.store.shownBookmarksFor(editor.document.uri);
    const toRemove = existing.filter((b) => lines.includes(b.line)).map((b) => b.id);
    const hiddenMine = this.hiddenMineAt(editor.document.uri, lines);
    let keptHidden = false;
    const toAdd: LineBookmark[] = [];
    const symbolKeys: { key: MarkKey; line: number }[] = [];
    for (const line of lines) {
      if (existing.some((b) => b.line === line)) {
        continue;
      }
      if (hiddenMine.some((b) => b.line === line)) {
        // 這一行已有自己的書籤，只是被篩選隱藏：不重複新增，提示即可
        keptHidden = true;
        continue;
      }
      const sym = await this.symbolAtNameLine(editor.document, line);
      if (sym) {
        symbolKeys.push({ key: { file: rel, path: sym.path, kind: sym.kind }, line });
      } else {
        toAdd.push(await this.newBookmark(editor.document, rel, line));
      }
    }
    const numbers = autoNumbers(this.store, toAdd.length + symbolKeys.length);
    // 「我的」被來源篩選隱藏時，看不到的函式書籤不拿掉（看不到就不會想取消）
    const favoritesShown = this.store.favoritesShown;
    await this.store.update(folder, (d) => {
      let next = toAdd.reduce((acc, b) => addBookmark(acc, withNumber(b, numbers)), removeBookmarks(d, toRemove));
      for (const { key, line } of symbolKeys) {
        const was = !!findMark(next, key)?.favorite;
        const on = !was || !favoritesShown;
        next = setFavorite(next, key, on, line);
        const n = on && !was ? numbers.shift() : undefined;
        if (n) {
          next = setSymbolExtras(next, key, { number: n });
        }
      }
      return next;
    });
    if (toAdd.length || symbolKeys.length || keptHidden) {
      this.noticeMineHidden();
    }
  }

  /** 給測試用：跳出「『我的』被隱藏」提示的次數。 */
  mineHiddenNotices = 0;

  /**
   * 「我的」被來源篩選隱藏時，這幾行看不到的自己的行號書籤（在目前分支上）。
   * 切換、命名時當成這一行已有書籤，不重複新增、也不拿掉看不到的書籤。
   */
  hiddenMineAt(uri: vscode.Uri, lines: number[]): LineBookmark[] {
    const loc = this.store.locate(uri);
    if (!loc || this.store.favoritesShown) {
      return [];
    }
    return this.store.bookmarksFor(uri).filter((b) => !b.source && lines.includes(b.line) && this.store.isPresent(loc.folder, b));
  }

  /**
   * 新增或修改了自己的書籤，但「我的」被來源篩選隱藏（畫面上看不到）：提示並提供「顯示」，
   * 不自動改使用者的篩選。
   */
  private noticeMineHidden(): void {
    if (this.store.favoritesShown) {
      return;
    }
    this.mineHiddenNotices++;
    const show = vscode.l10n.t('Show');
    void vscode.window
      .showInformationMessage(vscode.l10n.t('This bookmark belongs to "Mine", which is hidden by the source filter.'), show)
      .then((pick) => {
        if (pick === show) {
          this.store.showSources(['']);
        }
      });
  }

  /** 新增有名稱的書籤（游標所在行已有書籤時改它的名稱）；名稱依選取、單字、函式、該行內容建議。 */
  async addLabeled(value?: string, target?: { uri: vscode.Uri; line: number }): Promise<void> {
    const ctx = this.locateEditor(target);
    if (!ctx) {
      return;
    }
    const { editor, folder, rel } = ctx;
    const line = target?.line ?? editor.selection.active.line;
    const doc = editor.document;
    const wordRange = doc.getWordRangeAtPosition(editor.selection.active);
    const sym = findInnermost((await this.service.getSymbols(doc)).symbols, line);
    const existing =
      this.store.shownBookmarksFor(doc.uri).find((b) => b.line === line) ?? this.hiddenMineAt(doc.uri, [line])[0];
    const named = existing ? undefined : await this.symbolAtNameLine(doc, line);
    const namedKey: MarkKey | undefined = named ? { file: rel, path: named.path, kind: named.kind } : undefined;
    const suggestion =
      existing?.label ??
      (namedKey ? this.store.get(doc.uri, namedKey)?.alias ?? named!.name : undefined) ??
      suggestName({
        selection: editor.selection.isEmpty ? undefined : doc.getText(editor.selection),
        word: wordRange ? doc.getText(wordRange) : undefined,
        symbolName: sym?.name,
        lineText: doc.lineAt(line).text,
      });
    const label =
      value ??
      (await vscode.window.showInputBox({
        title: vscode.l10n.t('Bookmark name'),
        prompt: vscode.l10n.t('Line {0}', line + 1),
        value: suggestion,
        valueSelection: [0, suggestion.length],
      }));
    if (label === undefined) {
      return;
    }
    if (namedKey) {
      // 函式名稱那一行：建立函式書籤，名稱即自訂顯示名稱
      const wasOn = !!this.store.get(doc.uri, namedKey)?.favorite;
      const n = wasOn ? undefined : autoNumbers(this.store, 1)[0];
      await this.store.update(folder, (d) => {
        const next = setAlias(setFavorite(d, namedKey, true, line), namedKey, label, named!.name, line);
        return n ? setSymbolExtras(next, namedKey, { number: n }) : next;
      });
      this.noticeMineHidden();
      return;
    }
    if (existing) {
      await this.store.update(folder, (d) => updateBookmark(d, existing.id, (b) => withLabel(b, label)));
      if (!this.store.shownBySource(existing)) {
        this.noticeMineHidden();
      }
      return;
    }
    const bm = withNumber(await this.newBookmark(doc, rel, line, label), autoNumbers(this.store, 1));
    await this.store.update(folder, (d) => addBookmark(d, bm));
    this.noticeMineHidden();
  }

  /**
   * 確保指定行有可編輯的書籤（供行號右鍵「編輯備註」使用）：
   * 1. 先找這一行畫面上看得到的書籤：行號書籤優先，其次是名稱在這一行的函式書籤（與行號右鍵其他四個指令一致）。
   * 2. 這一行沒有看得到的書籤時：若「我的」被來源篩選隱藏且這一行已有自己的書籤，不重複新增也不誤改，只提示可以顯示。
   * 3. 否則依 Alt+Shift+B B 規則先建立書籤（函式名稱那一行建函式書籤，其他行建行號書籤，並套用 autoNumber）。
   */
  async ensureAtLine(
    target: { uri: vscode.Uri; line: number },
  ): Promise<{ kind: 'line'; entry: BookmarkEntry } | { kind: 'symbol'; uri: vscode.Uri; symbol: DetectedSymbol } | undefined> {
    const doc = await vscode.workspace.openTextDocument(target.uri);
    const loc = this.store.locate(doc.uri);
    if (!loc) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Only files inside a workspace folder can be bookmarked.'));
      return undefined;
    }
    const line = target.line;
    if (line < 0 || line >= doc.lineCount) {
      return undefined;
    }
    const existingLine = this.store.shownBookmarksFor(doc.uri).find((b) => b.line === line);
    if (existingLine) {
      return { kind: 'line', entry: { folder: loc.folder, uri: doc.uri, bookmark: existingLine } };
    }
    const sym = await this.symbolAtNameLine(doc, line);
    const symKey: MarkKey | undefined = sym ? { file: loc.rel, path: sym.path, kind: sym.kind } : undefined;
    if (sym && symKey && this.store.favoritesShown && this.store.get(doc.uri, symKey)?.favorite) {
      return { kind: 'symbol', uri: doc.uri, symbol: sym };
    }
    // 「我的」被來源篩選隱藏且這一行已有自己的書籤：看不到的書籤不算也不誤改，只提示可以顯示
    if (this.hiddenMineAt(doc.uri, [line]).length > 0 || (symKey && !this.store.favoritesShown && this.store.get(doc.uri, symKey)?.favorite)) {
      this.noticeMineHidden();
      return undefined;
    }
    const numbers = autoNumbers(this.store, 1);
    if (sym && symKey) {
      const n = numbers[0];
      const ok = await this.store.update(loc.folder, (d) => {
        const next = setFavorite(d, symKey, true, line);
        return n ? setSymbolExtras(next, symKey, { number: n }) : next;
      });
      if (!ok) {
        return undefined;
      }
      this.noticeMineHidden();
      return { kind: 'symbol', uri: doc.uri, symbol: sym };
    }
    const bm = withNumber(await this.newBookmark(doc, loc.rel, line), numbers);
    const ok = await this.store.update(loc.folder, (d) => addBookmark(d, bm));
    if (!ok) {
      return undefined;
    }
    this.noticeMineHidden();
    return { kind: 'line', entry: { folder: loc.folder, uri: doc.uri, bookmark: bm } };
  }

  /** 從樹狀節點，或（沒有節點時）從游標所在行取得書籤。 */
  entryOf(node?: unknown): BookmarkEntry | undefined {
    const n = node as BookmarkNodeLike | undefined;
    if (n?.type === 'bookmark') {
      const fresh = this.store.bookmarksFor(n.entry.uri, { includeHidden: true }).find((b) => b.id === n.entry.bookmark.id);
      return fresh ? { folder: n.entry.folder, uri: n.entry.uri, bookmark: fresh } : n.entry;
    }
    if (isBookmarkLinkArg(node)) {
      const uri = vscode.Uri.parse(node.uri);
      return this.store.allBookmarks().find((e) => e.bookmark.id === node.bookmark && e.uri.toString() === uri.toString())
        ?? this.store.allBookmarks().find((e) => e.bookmark.id === node.bookmark);
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const line = editor.selection.active.line;
    const loc = this.store.locate(editor.document.uri);
    const bm = this.store.shownBookmarksFor(editor.document.uri).find((b) => b.line === line);
    return loc && bm ? { folder: loc.folder, uri: editor.document.uri, bookmark: bm } : undefined;
  }

  private noBookmark(): void {
    void vscode.window.showInformationMessage(vscode.l10n.t('There is no bookmark on this line.'));
  }

  async rename(node?: unknown, value?: string): Promise<void> {
    const e = this.entryOf(node);
    if (!e) {
      return this.noBookmark();
    }
    const current = e.bookmark.label ?? e.bookmark.anchor?.text ?? '';
    const label =
      value ??
      (await vscode.window.showInputBox({
        title: vscode.l10n.t('Bookmark name'),
        prompt: vscode.l10n.t('Leave empty to show the line content'),
        value: current,
        valueSelection: [0, current.length],
      }));
    if (label === undefined) {
      return;
    }
    await this.store.update(e.folder, (d) => updateBookmark(d, e.bookmark.id, (b) => withLabel(b, label)));
  }

  async editTags(node?: unknown, value?: string): Promise<void> {
    const e = this.entryOf(node);
    if (!e) {
      return this.noBookmark();
    }
    const current = (e.bookmark.tags ?? []).map((t) => `#${t}`).join(' ');
    const input =
      value ??
      (await vscode.window.showInputBox({
        title: vscode.l10n.t('Tags'),
        prompt: tagsPrompt(this.store),
        value: current ? `${current} ` : '',
      }));
    if (input === undefined) {
      return;
    }
    const tags = parseTags(input);
    await this.store.update(e.folder, (d) =>
      updateBookmark(d, e.bookmark.id, (b) => {
        if (tags.length) {
          b.tags = tags;
        } else {
          delete b.tags;
        }
        return b;
      }),
    );
  }

  /**
   * 把書籤移到游標所在的行（找不到位置、需確認的書籤用來手動放回正確位置）。
   * 書籤的檔案不在目前的編輯器時，先開到書籤附近，請使用者把游標放到正確的行再執行一次。
   */
  async moveToCursor(node?: unknown, targetLine?: number): Promise<void> {
    let e = node === undefined ? undefined : this.entryOf(node);
    const editor = vscode.window.activeTextEditor;
    if (!e && node === undefined && editor) {
      // 從命令選擇區執行：在目前檔案的書籤中挑一個（需確認的排前面）
      const list = this.store.shownBookmarksFor(editor.document.uri);
      const loc = this.store.locate(editor.document.uri);
      if (!loc || !list.length) {
        return this.noBookmark();
      }
      const sorted = [...list].sort((a, b) => Number(b.status === 'lost') - Number(a.status === 'lost') || a.line - b.line);
      const pick =
        sorted.length === 1 && sorted[0].status === 'lost'
          ? { b: sorted[0] }
          : await vscode.window.showQuickPick(
              sorted.map((b) => ({
                label: `${b.status === 'lost' ? '$(warning) ' : '$(bookmark) '}${bookmarkTitle(b)}`,
                description: String(b.line + 1),
                b,
              })),
              { title: vscode.l10n.t('Move which bookmark to line {0}?', editor.selection.active.line + 1) },
            );
      if (!pick) {
        return;
      }
      e = { folder: loc.folder, uri: editor.document.uri, bookmark: pick.b };
    }
    if (!e) {
      return this.noBookmark();
    }
    const entry = e;
    if (!editor || editor.document.uri.toString() !== entry.uri.toString()) {
      const ok = await jumpToBookmark({
        uri: entry.uri,
        line: entry.bookmark.line,
        file: entry.bookmark.file,
        status: entry.bookmark.status,
      });
      if (!ok) {
        return;
      }
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Put the cursor on the correct line, then run "Move Bookmark to Cursor" again.'),
      );
      return;
    }
    const doc = editor.document;
    const line = targetLine ?? editor.selection.active.line;
    if (line === entry.bookmark.line && entry.bookmark.status !== 'lost') {
      return;
    }
    const other = this.store.shownBookmarksFor(doc.uri).find((b) => b.line === line && b.id !== entry.bookmark.id);
    if (other) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Line {0} already has a bookmark.', line + 1));
      return;
    }
    const symbols = (await this.service.getSymbols(doc)).symbols;
    const sym = findInnermost(symbols, line);
    const anchor = makeAnchor(doc.getText().split(/\r?\n/), line, sym?.path, sym?.startLine);
    await this.store.update(entry.folder, (d) =>
      updateBookmark(d, entry.bookmark.id, (b) => {
        b.line = line;
        b.anchor = anchor;
        delete b.status;
        return b;
      }),
    );
  }

  async remove(node?: unknown): Promise<void> {
    const e = this.entryOf(node);
    if (!e) {
      return this.noBookmark();
    }
    await this.store.update(e.folder, (d) => removeBookmarks(d, [e.bookmark.id]));
  }

  private async confirm(message: string, confirmed?: boolean): Promise<boolean> {
    if (confirmed !== undefined) {
      return confirmed;
    }
    const yes = vscode.l10n.t('Clear');
    return (await vscode.window.showWarningMessage(message, { modal: true }, yes)) === yes;
  }

  /** 清除目前檔案的所有書籤（會先確認）。 */
  async clearFile(uri?: vscode.Uri, confirmed?: boolean): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      return;
    }
    const loc = this.store.locate(target);
    if (!loc) {
      return;
    }
    // 只清除畫面上看得到的：只屬於別的分支、不在此分支、被來源篩選隱藏的書籤保留
    const shown = this.store.shownBookmarksFor(target);
    const favs = this.store.favoritesShown
      ? this.store.allFavorites().filter((f) => f.folder === loc.folder && f.mark.file === loc.rel)
      : [];
    const count = shown.length + favs.length;
    if (count === 0) {
      return;
    }
    if (!(await this.confirm(vscode.l10n.t('Clear {0} bookmark(s) in {1}?', count, loc.rel), confirmed))) {
      return;
    }
    const ids = shown.map((b) => b.id);
    await this.store.update(loc.folder, (d) => {
      const next = removeBookmarks(d, ids);
      return favs.length ? unfavoriteFiles(next, loc.rel) : next;
    });
  }

  /** 清除所有書籤（函式書籤＋行號書籤，會先確認）；函式的自訂名稱與備註保留。只清除畫面上看得到的書籤。 */
  async clearAll(confirmed?: boolean): Promise<void> {
    const all = this.store.shownBookmarks();
    const favs = this.store.favoritesShown ? this.store.allFavorites() : [];
    const count = all.length + favs.length;
    if (count === 0) {
      return;
    }
    if (!(await this.confirm(vscode.l10n.t('Clear all {0} bookmark(s)? Display names and notes of functions are kept.', count), confirmed))) {
      return;
    }
    for (const folder of new Set([...all.map((e) => e.folder), ...favs.map((f) => f.folder)])) {
      const ids = all.filter((e) => e.folder === folder).map((e) => e.bookmark.id);
      const hasFavs = favs.some((f) => f.folder === folder);
      await this.store.update(folder, (d) => {
        const next = removeBookmarks(d, ids);
        return hasFavs ? unfavoriteFiles(next) : next;
      });
    }
  }

  /** 開啟指定的行號書籤（供側邊欄點擊與搜尋列按 Enter 呼叫）；檔案不存在時不開分頁並回傳 false。 */
  async openBookmark(arg?: unknown): Promise<boolean> {
    if (!arg) {
      return false;
    }
    const e = this.entryOf(arg);
    if (!e) {
      return false;
    }
    return jumpToBookmark({
      uri: e.uri,
      line: e.bookmark.line,
      file: e.bookmark.file,
      status: e.bookmark.status,
    });
  }

  /** 跳到下一個（1）或上一個（-1）書籤（含函式書籤與行號書籤），依設定決定範圍與是否頭尾循環。 */
  async go(direction: 1 | -1): Promise<{ uri: vscode.Uri; line: number } | undefined> {
    // 多資料夾工作區以視窗／工作區層級設定為準（與 autoNumber、showLabelAtLineEnd 一致，跨資料夾導覽行為統一）
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const scope = cfg.get<string>('bookmarks.navigationScope', 'all') === 'currentFile' ? 'currentFile' : 'all';
    const wrap = cfg.get<boolean>('bookmarks.navigationWrap', true);

    const folders = vscode.workspace.workspaceFolders ?? [];
    const keyOf = (folder: vscode.WorkspaceFolder, file: string) => `${String(folders.indexOf(folder)).padStart(3, '0')}/${file}`;
    const editor = vscode.window.activeTextEditor;
    const loc = editor ? this.store.locate(editor.document.uri) : undefined;
    const current = loc ? keyOf(loc.folder, loc.rel) : undefined;
    // currentFile 模式但沒有作用中的編輯器時，視為 all
    const currentFileOnly = scope === 'currentFile' && editor !== undefined;

    // 函式書籤用目前偵測到的行號；找不到的函式不參與跳轉
    const allItems = shownBookmarkItems(this.store, this.favorites)
      .filter((i) => i.line !== undefined)
      .map((i) => ({
        file: keyOf(i.folder, i.file),
        line: i.line!,
        rel: i.file,
        status: i.kind === 'line' ? i.entry.bookmark.status : undefined,
        entry: { uri: i.uri, line: i.line! },
      }));
    const items = currentFileOnly
      ? current !== undefined
        ? allItems.filter((i) => i.file === current)
        : []
      : allItems;

    if (items.length === 0) {
      if (currentFileOnly) {
        vscode.window.setStatusBarMessage(vscode.l10n.t('No bookmarks in this file.'), 3000);
      } else {
        // 和其他跳轉提示一樣用狀態列短暫顯示，不跳出會擋住程式碼的通知
        vscode.window.setStatusBarMessage(vscode.l10n.t('No bookmarks yet.'), 3000);
      }
      return undefined;
    }

    // 開不了的檔案（已被刪除、搬走）跳過，從它的位置繼續找下一個；不然游標不動，每次都挑到同一個而卡住
    let pool = items;
    let fromFile = current;
    let fromLine = editor?.selection.active.line ?? 0;
    let firstMissing: string | undefined;
    for (
      let target = neighbor(pool, fromFile, fromLine, direction, wrap);
      target;
      target = neighbor(pool, fromFile, fromLine, direction, wrap)
    ) {
      const ok = await jumpToBookmark(
        { uri: target.entry.uri, line: target.entry.line, file: target.rel, status: target.status },
        { silentMissing: true },
      );
      if (ok) {
        return target.entry;
      }
      firstMissing ??= target.rel;
      const skipped = target.entry.uri.toString();
      pool = pool.filter((i) => i.entry.uri.toString() !== skipped);
      fromFile = target.file;
      fromLine = target.line;
    }
    if (!wrap && pool.length > 0) {
      // 不循環且沒有下一個／上一個（含跳過已刪除的書籤後後面沒有了）：游標不動並以狀態列短暫提示
      vscode.window.setStatusBarMessage(
        direction === 1 ? vscode.l10n.t('Already at the last bookmark.') : vscode.l10n.t('Already at the first bookmark.'),
        3000,
      );
      return undefined;
    }
    if (firstMissing !== undefined) {
      notifyMissingBookmarkFile(firstMissing);
    }
    return undefined;
  }

  async editNote(node?: unknown, value?: string): Promise<void> {
    const e = this.entryOf(node);
    if (!e) {
      return this.noBookmark();
    }
    const apply = async (text: string) => {
      await this.store.update(e.folder, (d) =>
        updateBookmark(d, e.bookmark.id, (b) => {
          const v = text.replace(/\r\n/g, '\n').replace(/^\s*\n/, '').trimEnd();
          if (v.trim()) {
            b.note = v;
          } else {
            delete b.note;
          }
          return b;
        }),
      );
    };
    if (value !== undefined) {
      return apply(value);
    }
    await this.notes.open({
      id: `${e.folder.uri.toString()}|bookmark|${e.bookmark.id}`,
      title: bookmarkTitle(e.bookmark),
      subject: `${e.bookmark.file}:${e.bookmark.line + 1}`,
      current: e.bookmark.note,
      apply,
    });
  }

  async previewNote(node?: unknown): Promise<void> {
    const e = this.entryOf(node);
    if (!e?.bookmark.note) {
      void vscode.window.showInformationMessage(vscode.l10n.t('This bookmark has no note.'));
      return;
    }
    const b = e.bookmark;
    const subtitle = `${vscode.workspace.asRelativePath(e.uri, false)}:${b.line + 1}${b.tags?.length ? ` · ${b.tags.map((t) => `#${t}`).join(' ')}` : ''}`;
    await this.notes.preview(bookmarkTitle(b), subtitle, b.note ?? '');
  }
}

/** 編輯標籤時的輸入提示：列出所有書籤（行號＋函式）已使用過的標籤。 */
export function tagsPrompt(store: MarkStore): string {
  const all = store.allTags();
  return all.length
    ? vscode.l10n.t('Separate with spaces or commas. Existing: {0}', all.map((t) => `#${t}`).join(' '))
    : vscode.l10n.t('Separate with spaces or commas, e.g. #auth #todo');
}

/** 設定 `bookmarks.autoNumber` 開啟時，新書籤依序取得的空號（最多 count 個）。 */
export function autoNumbers(store: MarkStore, count: number): number[] {
  if (!count || !vscode.workspace.getConfiguration(SECTION).get<boolean>('bookmarks.autoNumber', false)) {
    return [];
  }
  const used = new Set(store.numbered().keys());
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const n = nextFreeNumber(used);
    if (!n) {
      break;
    }
    used.add(n);
    out.push(n);
  }
  return out;
}

function withNumber(b: LineBookmark, numbers: number[]): LineBookmark {
  const n = numbers.shift();
  return n ? { ...b, number: n } : b;
}

function withLabel(b: LineBookmark, label: string): LineBookmark {
  const v = label.trim();
  if (v && v !== b.anchor?.text) {
    b.label = v;
  } else {
    delete b.label;
  }
  return b;
}
