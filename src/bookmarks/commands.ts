import * as vscode from 'vscode';
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
  updateBookmarksInFile,
} from '../storage/marks';
import { nextFreeNumber } from './decor';
import { BookmarkEntry, MarkStore } from '../storage/store';
import { FavoritesModel } from '../symbols/favorites';
import { SymbolService } from '../symbols/symbolService';
import { allBookmarkItems } from './unified';
import { NoteEditor } from '../views/noteEditor';
import { LineBookmark, makeAnchor, neighbor, newBookmarkId, parseTags, suggestName } from './model';

/** 樹狀檢視的書籤節點（避免與 views/tree 互相引用，只描述需要的欄位）。 */
export interface BookmarkNodeLike {
  type: 'bookmark';
  entry: BookmarkEntry;
}

/** 提示中「在預覽中開啟」連結帶的參數。 */
export interface BookmarkLinkArg {
  uri: string;
  bookmark: string;
}

export function isBookmarkLinkArg(arg: unknown): arg is BookmarkLinkArg {
  const a = arg as Partial<BookmarkLinkArg> | undefined;
  return !!a && typeof a.uri === 'string' && typeof a.bookmark === 'string';
}

export function bookmarkTitle(b: LineBookmark): string {
  return b.label ?? (b.symbol ? (b.symbol.path.split('.').pop() ?? b.symbol.path) : undefined) ?? (b.anchor?.text || `#${b.line + 1}`);
}

export async function revealLine(uri: vscode.Uri, line: number): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(uri, { preserveFocus: false });
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

  /** 名稱剛好在這一行的符號（函式、類別、block…），有的話 Ctrl+Alt+B 建立函式書籤。 */
  private async symbolAtNameLine(doc: vscode.TextDocument, line: number): Promise<DetectedSymbol | undefined> {
    let hit: DetectedSymbol | undefined;
    const walk = (list: DetectedSymbol[]) => {
      for (const s of list) {
        if (s.nameLine === line && s.kind !== 'reference') {
          hit = s; // 同一行有多個時取最內層
        }
        walk(s.children);
      }
    };
    walk((await this.service.getSymbols(doc)).symbols);
    return hit;
  }

  private async newBookmark(doc: vscode.TextDocument, rel: string, line: number, label?: string): Promise<LineBookmark> {
    const symbols = (await this.service.getSymbols(doc)).symbols;
    const sym = findInnermost(symbols, line);
    const bm: LineBookmark = {
      id: newBookmarkId(),
      file: rel,
      line,
      anchor: makeAnchor(doc.getText().split(/\r?\n/), line, sym?.path, sym?.startLine),
      createdAt: new Date().toISOString(),
    };
    if (label?.trim()) {
      bm.label = label.trim();
    }
    return bm;
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
    const existing = this.store.bookmarksFor(editor.document.uri);
    const toRemove = existing.filter((b) => lines.includes(b.line)).map((b) => b.id);
    const toAdd: LineBookmark[] = [];
    const symbolKeys: { key: MarkKey; line: number }[] = [];
    for (const line of lines) {
      if (existing.some((b) => b.line === line)) {
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
    await this.store.update(folder, (d) => {
      let next = toAdd.reduce((acc, b) => addBookmark(acc, withNumber(b, numbers)), removeBookmarks(d, toRemove));
      for (const { key, line } of symbolKeys) {
        const on = !findMark(next, key)?.favorite;
        next = setFavorite(next, key, on, line);
        const n = on ? numbers.shift() : undefined;
        if (n) {
          next = setSymbolExtras(next, key, { number: n });
        }
      }
      return next;
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
    const existing = this.store.bookmarksFor(doc.uri).find((b) => b.line === line);
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
      return;
    }
    if (existing) {
      await this.store.update(folder, (d) => updateBookmark(d, existing.id, (b) => withLabel(b, label)));
      return;
    }
    const bm = withNumber(await this.newBookmark(doc, rel, line, label), autoNumbers(this.store, 1));
    await this.store.update(folder, (d) => addBookmark(d, bm));
  }

  /** 從樹狀節點，或（沒有節點時）從游標所在行取得書籤。 */
  entryOf(node?: unknown): BookmarkEntry | undefined {
    const n = node as BookmarkNodeLike | undefined;
    if (n?.type === 'bookmark') {
      return n.entry;
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
    const bm = this.store.bookmarksFor(editor.document.uri).find((b) => b.line === line);
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
    const all = [...new Set(this.store.allBookmarks().flatMap((x) => x.bookmark.tags ?? []))].sort();
    const current = (e.bookmark.tags ?? []).map((t) => `#${t}`).join(' ');
    const input =
      value ??
      (await vscode.window.showInputBox({
        title: vscode.l10n.t('Tags'),
        prompt: all.length
          ? vscode.l10n.t('Separate with spaces or commas. Existing: {0}', all.map((t) => `#${t}`).join(' '))
          : vscode.l10n.t('Separate with spaces or commas, e.g. #auth #todo'),
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
      const list = this.store.bookmarksFor(editor.document.uri);
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
      await revealLine(entry.uri, entry.bookmark.line);
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
    const other = this.store.bookmarksFor(doc.uri).find((b) => b.line === line && b.id !== entry.bookmark.id);
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
    const count =
      this.store.bookmarksFor(target).length +
      this.store.allFavorites().filter((f) => f.folder === loc.folder && f.mark.file === loc.rel).length;
    if (count === 0) {
      return;
    }
    if (!(await this.confirm(vscode.l10n.t('Clear {0} bookmark(s) in {1}?', count, loc.rel), confirmed))) {
      return;
    }
    // 只屬於別的分支（目前看不到）的書籤保留
    await this.store.update(loc.folder, (d) =>
      unfavoriteFiles(updateBookmarksInFile(d, loc.rel, (b) => (this.store.isVisible(loc.folder, b) ? undefined : b)), loc.rel),
    );
  }

  /** 清除所有書籤（函式書籤＋行號書籤，會先確認）；函式的自訂名稱與備註保留。 */
  async clearAll(confirmed?: boolean): Promise<void> {
    const all = this.store.allBookmarks();
    const favs = this.store.allFavorites();
    const count = all.length + favs.length;
    if (count === 0) {
      return;
    }
    if (!(await this.confirm(vscode.l10n.t('Clear all {0} bookmark(s)? Display names and notes of functions are kept.', count), confirmed))) {
      return;
    }
    for (const folder of new Set([...all.map((e) => e.folder), ...favs.map((f) => f.folder)])) {
      const ids = all.filter((e) => e.folder === folder).map((e) => e.bookmark.id);
      await this.store.update(folder, (d) => unfavoriteFiles(removeBookmarks(d, ids)));
    }
  }

  /** 跳到下一個（1）或上一個（-1）書籤，跨檔案、頭尾相接；可傳入篩選後的清單。 */
  async go(direction: 1 | -1): Promise<{ uri: vscode.Uri; line: number } | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const keyOf = (folder: vscode.WorkspaceFolder, file: string) => `${String(folders.indexOf(folder)).padStart(3, '0')}/${file}`;
    // 函式書籤用目前偵測到的行號；找不到的函式不參與跳轉
    const items = allBookmarkItems(this.store, this.favorites)
      .filter(
        (i) =>
          i.line !== undefined &&
          !(i.kind === 'line' && (i.entry.bookmark.status === 'notOnBranch' || !this.store.shownBySource(i.entry.bookmark))),
      )
      .map((i) => ({ file: keyOf(i.folder, i.file), line: i.line!, entry: { uri: i.uri, line: i.line! } }));
    const editor = vscode.window.activeTextEditor;
    const loc = editor ? this.store.locate(editor.document.uri) : undefined;
    const current = loc ? `${String(folders.indexOf(loc.folder)).padStart(3, '0')}/${loc.rel}` : undefined;
    const target = neighbor(items, current, editor?.selection.active.line ?? 0, direction);
    if (!target) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No bookmarks yet.'));
      return undefined;
    }
    await revealLine(target.entry.uri, target.entry.line);
    return target.entry;
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
