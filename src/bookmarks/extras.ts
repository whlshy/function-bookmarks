import * as vscode from 'vscode';
import { DetectedSymbol } from '../detection/types';
import { addBookmark, clearNumber, MarkKey, setFavorite, setSymbolExtras, setTagColor, updateBookmark } from '../storage/marks';
import { MarkStore, NumberedEntry } from '../storage/store';
import { FavoritesModel } from '../symbols/favorites';
import { SymbolService } from '../symbols/symbolService';
import { autoNumbers, BookmarkCommands, bookmarkTitle, revealLine } from './commands';
import { circled, nextFreeNumber, PALETTE, paletteColor } from './decor';
import { itemTags, allBookmarkItems } from './unified';
import { goToNumberKeys, setNumberKey, setNumberKeys } from '../util/shortcuts';

/** 號碼、顏色要套用的對象：行號書籤或函式書籤。 */
export type ExtrasTarget =
  | { kind: 'line'; folder: vscode.WorkspaceFolder; uri: vscode.Uri; id: string; title: string; number?: number; color?: string }
  | { kind: 'symbol'; folder: vscode.WorkspaceFolder; uri: vscode.Uri; key: MarkKey; title: string; number?: number; color?: string };

interface NodeLike {
  type?: string;
  entry?: { folder: vscode.WorkspaceFolder; uri: vscode.Uri; bookmark: { id: string } };
  fav?: { folder: vscode.WorkspaceFolder; uri: vscode.Uri; mark: MarkKey };
  uri?: vscode.Uri;
  symbol?: DetectedSymbol;
  by?: string;
  key?: string;
}

const COLOR_NAMES: Record<string, () => string> = {
  red: () => vscode.l10n.t('Red'),
  orange: () => vscode.l10n.t('Orange'),
  yellow: () => vscode.l10n.t('Yellow'),
  green: () => vscode.l10n.t('Green'),
  teal: () => vscode.l10n.t('Teal'),
  blue: () => vscode.l10n.t('Blue'),
  purple: () => vscode.l10n.t('Purple'),
  pink: () => vscode.l10n.t('Pink'),
  gray: () => vscode.l10n.t('Gray'),
};

export function colorName(id: string): string {
  return COLOR_NAMES[id]?.() ?? id;
}

function entryTitle(e: NumberedEntry): string {
  return e.kind === 'line' ? bookmarkTitle(e.bookmark) : (e.mark.alias ?? e.mark.path.split('.').pop() ?? e.mark.path);
}

function entryWhere(e: NumberedEntry): string {
  return e.kind === 'line' ? `${e.bookmark.file}:${e.bookmark.line + 1}` : `${e.mark.file} › ${e.mark.path}`;
}

/** 尚未建立的書籤目標：等使用者在 QuickPick／確認框確定後才一次建立並套用號碼或顏色。 */
type PendingTarget =
  | { pending: true; kind: 'line'; folder: vscode.WorkspaceFolder; uri: vscode.Uri; rel: string; doc: vscode.TextDocument; line: number; title: string; number?: undefined; color?: undefined }
  | { pending: true; kind: 'symbol'; folder: vscode.WorkspaceFolder; uri: vscode.Uri; key: MarkKey; line: number; title: string; number?: undefined; color?: undefined };

type ResolvedTarget = (ExtrasTarget & { pending?: false }) | PendingTarget;

function sameTarget(e: NumberedEntry, t: ResolvedTarget): boolean {
  if (t.pending || e.folder !== t.folder) {
    return false;
  }
  return e.kind === 'line'
    ? t.kind === 'line' && e.bookmark.id === t.id
    : t.kind === 'symbol' && e.mark.file === t.key.file && e.mark.path === t.key.path && e.mark.kind === t.key.kind;
}

/** 依編號導覽一步的結果。 */
export interface TourStepResult {
  number: number;
  index: number;
  total: number;
  title: string;
  uri: vscode.Uri;
  line: number;
  hasNote: boolean;
}

/**
 * M7：數字快速書籤（1～9）、書籤與標籤顏色、依編號導覽。
 */
export class BookmarkExtras {
  private lastTourNumber: number | undefined;
  /** 給測試用：最近一次導覽顯示的狀態列文字。 */
  lastTourStatus: string | undefined;

  constructor(
    private readonly store: MarkStore,
    private readonly service: SymbolService,
    private readonly favorites: FavoritesModel,
    private readonly bookmarks: BookmarkCommands,
    private readonly openFavorite: (fav: FavoritesModel['all'][number]) => Promise<void>,
    private readonly beforeShowHover?: () => Promise<void>,
  ) {}

  /** 從樹狀節點，或游標所在的行取得對象；`create` 時游標那一行沒有書籤就先加入。 */
  async target(node?: unknown, create = false): Promise<ExtrasTarget | undefined> {
    const n = node as NodeLike | undefined;
    if (n?.type === 'bookmark' && n.entry) {
      const b = this.store.bookmarksFor(n.entry.uri, { includeHidden: true }).find((x) => x.id === n.entry!.bookmark.id);
      return b && { kind: 'line', folder: n.entry.folder, uri: n.entry.uri, id: b.id, title: bookmarkTitle(b), number: b.number, color: b.color };
    }
    if (n?.type === 'favorite' && n.fav) {
      return this.symbolTarget(n.fav.uri, n.fav.mark);
    }
    if (n?.type === 'symbol' && n.uri && n.symbol) {
      const loc = this.store.locate(n.uri);
      if (!loc) {
        return undefined;
      }
      const key: MarkKey = { file: loc.rel, path: n.symbol.path, kind: n.symbol.kind };
      if (!this.store.get(n.uri, key)?.favorite) {
        if (!create) {
          return undefined;
        }
        await vscode.commands.executeCommand('functionBookmarks.addFavorite', node);
      }
      return this.symbolTarget(n.uri, key);
    }
    // 行號右鍵選單：指定的檔案與行；否則用游標所在的行
    const at = n?.type === 'line' && n.uri && typeof (n as { line?: unknown }).line === 'number' ? { uri: n.uri, line: (n as { line: number }).line } : undefined;
    const editor = vscode.window.activeTextEditor;
    const doc = at ? await vscode.workspace.openTextDocument(at.uri) : editor?.document;
    if (!doc) {
      return undefined;
    }
    const uri = doc.uri;
    const line = at?.line ?? editor!.selection.active.line;
    const found = await this.atLine(doc, line);
    if (found || !create) {
      return found;
    }
    if (!this.store.locate(uri)) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Only files inside a workspace folder can be bookmarked.'));
      return undefined;
    }
    // 這一行還沒有書籤：照 Alt+Shift+B B 的規則加入（函式名稱那一行加函式書籤，其他行加行號書籤）
    await this.bookmarks.toggle({ uri, line });
    // 「我的」被篩選隱藏時，剛加（或原本就有）的自己的書籤看不到，也要找得到
    return this.atLine(doc, line, true);
  }

  private symbolTarget(uri: vscode.Uri, key: Pick<MarkKey, 'path' | 'kind'>): ExtrasTarget | undefined {
    const k = this.store.keyFor(uri, key);
    const mark = this.store.get(uri, key);
    if (!k || !mark?.favorite) {
      return undefined;
    }
    return {
      kind: 'symbol',
      folder: k.folder,
      uri,
      key: { file: k.file, path: k.path, kind: k.kind },
      title: mark.alias ?? key.path.split('.').pop() ?? key.path,
      number: mark.number,
      color: mark.color,
    };
  }

  /** 這一行的書籤：行號書籤，或名稱在這一行的函式書籤。`includeHiddenMine`：也找被來源篩選隱藏的自己的書籤。 */
  private async atLine(doc: vscode.TextDocument, line: number, includeHiddenMine = false): Promise<ExtrasTarget | undefined> {
    const loc = this.store.locate(doc.uri);
    if (!loc) {
      return undefined;
    }
    const b =
      this.store.shownBookmarksFor(doc.uri).find((x) => x.line === line) ??
      (includeHiddenMine ? this.bookmarks.hiddenMineAt(doc.uri, [line])[0] : undefined);
    if (b) {
      return { kind: 'line', folder: loc.folder, uri: doc.uri, id: b.id, title: bookmarkTitle(b), number: b.number, color: b.color };
    }
    let hit: DetectedSymbol | undefined;
    const walk = (list: DetectedSymbol[]) => {
      for (const s of list) {
        if (s.nameLine === line && (this.store.favoritesShown || includeHiddenMine) && this.store.get(doc.uri, s)?.favorite) {
          hit = s;
        }
        walk(s.children);
      }
    };
    walk((await this.service.getSymbols(doc)).symbols);
    return hit ? this.symbolTarget(doc.uri, hit) : undefined;
  }

  /** 依節點或游標解析出既有或尚未建立的目標（不先寫入 store，取消時不留殘留書籤）。 */
  private async resolveForWrite(node?: unknown): Promise<{ target: ResolvedTarget; hiddenMine?: boolean } | { outsideWorkspace: true } | undefined> {
    const n = node as NodeLike | undefined;
    if (n?.type === 'bookmark' && n.entry) {
      const b = this.store.bookmarksFor(n.entry.uri, { includeHidden: true }).find((x) => x.id === n.entry!.bookmark.id);
      return b
        ? { target: { kind: 'line', folder: n.entry.folder, uri: n.entry.uri, id: b.id, title: bookmarkTitle(b), number: b.number, color: b.color } }
        : undefined;
    }
    if (n?.type === 'favorite' && n.fav) {
      const t = this.symbolTarget(n.fav.uri, n.fav.mark);
      return t ? { target: t } : undefined;
    }
    if (n?.type === 'symbol' && n.uri && n.symbol) {
      const loc = this.store.locate(n.uri);
      if (!loc) {
        void vscode.window.showWarningMessage(vscode.l10n.t('Only files inside a workspace folder can be bookmarked.'));
        return { outsideWorkspace: true };
      }
      const key: MarkKey = { file: loc.rel, path: n.symbol.path, kind: n.symbol.kind };
      const existing = this.symbolTarget(n.uri, key);
      if (existing) {
        return { target: existing };
      }
      const mark = this.store.get(n.uri, key);
      return {
        target: {
          pending: true,
          kind: 'symbol',
          folder: loc.folder,
          uri: n.uri,
          key,
          line: n.symbol.nameLine,
          title: mark?.alias ?? n.symbol.name,
        },
      };
    }
    const at =
      n?.type === 'line' && n.uri && typeof (n as { line?: unknown }).line === 'number'
        ? { uri: n.uri, line: (n as { line: number }).line }
        : undefined;
    const editor = vscode.window.activeTextEditor;
    const doc = at ? await vscode.workspace.openTextDocument(at.uri) : editor?.document;
    if (!doc) {
      return undefined;
    }
    const line = at?.line ?? editor!.selection.active.line;
    if (line < 0 || line >= doc.lineCount) {
      return undefined;
    }
    const found = await this.atLine(doc, line);
    if (found) {
      return { target: found };
    }
    const loc = this.store.locate(doc.uri);
    if (!loc) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Only files inside a workspace folder can be bookmarked.'));
      return { outsideWorkspace: true };
    }
    // 「我的」被來源篩選隱藏且這一行已有自己的書籤：操作原本那筆，不重複建立
    const hidden = await this.atLine(doc, line, true);
    if (hidden) {
      return { target: hidden, hiddenMine: true };
    }
    const sym = await this.bookmarks.symbolAtNameLine(doc, line);
    if (sym) {
      const key: MarkKey = { file: loc.rel, path: sym.path, kind: sym.kind };
      const mark = this.store.get(doc.uri, key);
      return {
        target: {
          pending: true,
          kind: 'symbol',
          folder: loc.folder,
          uri: doc.uri,
          key,
          line: sym.nameLine,
          title: mark?.alias ?? sym.name,
        },
      };
    }
    const lineText = doc.lineAt(line).text.trim();
    return {
      target: {
        pending: true,
        kind: 'line',
        folder: loc.folder,
        uri: doc.uri,
        rel: loc.rel,
        doc,
        line,
        title: lineText || vscode.l10n.t('Line {0}', line + 1),
      },
    };
  }

  /** 把號碼或顏色寫入目標；目標尚未建立時，在同一個 store.update 裡一次建立並套用。 */
  private async commitTarget(
    t: ResolvedTarget,
    p: { number?: number | null; color?: string | null },
    options: { applyAutoNumber?: boolean; hiddenMine?: boolean } = {},
  ): Promise<void> {
    if (p.number !== undefined && p.number !== null) {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder !== t.folder) {
          await this.store.update(folder, (d) => clearNumber(d, p.number!));
        }
      }
    }
    if (!t.pending) {
      if (p.number !== undefined && p.number !== null) {
        const except = t.kind === 'line' ? { bookmarkId: t.id } : { key: t.key };
        await this.store.update(t.folder, (d) => this.patch(clearNumber(d, p.number!, except), t, p));
      } else {
        await this.store.update(t.folder, (d) => this.patch(d, t, p));
      }
      if (options.hiddenMine) {
        this.bookmarks.notifyIfMineHidden();
      }
      return;
    }
    // 尚未建立的目標：確定套用時才建立書籤；指定號碼時不另外觸發 autoNumber
    const num = p.number !== undefined ? (p.number ?? undefined) : options.applyAutoNumber ? autoNumbers(this.store, 1)[0] : undefined;
    if (t.kind === 'symbol') {
      await this.store.update(t.folder, (d) => {
        let next = num ? clearNumber(d, num) : d;
        next = setFavorite(next, t.key, true, t.line);
        return setSymbolExtras(next, t.key, {
          ...(num !== undefined ? { number: num } : {}),
          ...(p.color !== undefined ? { color: p.color } : {}),
        });
      });
    } else {
      const bm = await this.bookmarks.prepareBookmark(t.doc, t.rel, t.line);
      if (num !== undefined) {
        bm.number = num;
      }
      if (p.color) {
        bm.color = p.color;
      }
      await this.store.update(t.folder, (d) => addBookmark(num ? clearNumber(d, num) : d, bm));
    }
    this.bookmarks.notifyIfMineHidden();
  }

  private patch(d: Parameters<typeof setSymbolExtras>[0], t: ExtrasTarget, p: { number?: number | null; color?: string | null }) {
    if (t.kind === 'symbol') {
      return setSymbolExtras(d, t.key, p);
    }
    return updateBookmark(d, t.id, (b) => {
      if (p.number === null) {
        delete b.number;
      } else if (p.number !== undefined) {
        b.number = p.number;
      }
      if (p.color === null) {
        delete b.color;
      } else if (p.color !== undefined) {
        b.color = p.color;
      }
      return b;
    });
  }

  /** 號碼已被別的書籤使用時詢問是否改給這個書籤。 */
  private async confirmTake(n: number, t: ResolvedTarget, confirmed?: boolean): Promise<boolean> {
    const holder = this.store.numbered().get(n);
    if (!holder || sameTarget(holder, t)) {
      return true;
    }
    if (confirmed !== undefined) {
      return confirmed;
    }
    const yes = vscode.l10n.t('Move Number');
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t('Number {0} is already used by "{1}" ({2}). Give it to this bookmark instead?', n, entryTitle(holder), entryWhere(holder)),
      { modal: true },
      yes,
    );
    return pick === yes;
  }

  /**
   * 指定號碼：`value` 為 1～9、'next'（下一個空號）、null（拿掉）；沒有給就跳出選單。
   * 游標那一行還沒有書籤時，等使用者確定選好後才一起建立，取消不留任何變動。
   */
  async setNumber(node?: unknown, value?: number | 'next' | null, confirmed?: boolean): Promise<void> {
    const resolved = await this.resolveForWrite(node);
    if (!resolved) {
      return this.noBookmark();
    }
    if ('outsideWorkspace' in resolved) {
      return;
    }
    const t = resolved.target;
    const used = this.store.numbered();
    let n = value;
    if (n === undefined) {
      const free = nextFreeNumber(used.keys());
      type Item = vscode.QuickPickItem & { value: number | null };
      const items: Item[] = [];
      for (let i = 1; i <= 9; i++) {
        const holder = used.get(i);
        items.push({
          label: `${circled(i)}  ${i}`,
          description: holder ? (sameTarget(holder, t) ? vscode.l10n.t('this bookmark') : entryTitle(holder)) : i === free ? vscode.l10n.t('next free') : '',
          detail: holder && !sameTarget(holder, t) ? entryWhere(holder) : undefined,
          value: i,
        });
      }
      if (!t.pending && t.number) {
        items.push({ label: `$(close) ${vscode.l10n.t('Remove number')}`, value: null });
      }
      const pick = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t('Number for "{0}" (jump with {1})', t.title, goToNumberKeys()),
      });
      if (!pick) {
        return;
      }
      n = pick.value;
    }
    if (n === 'next') {
      if (!t.pending && t.number) {
        return;
      }
      n = nextFreeNumber(used.keys()) ?? null;
      if (n === null) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Numbers 1–9 are all used.'));
        return;
      }
    }
    if (n === null && t.pending) {
      return;
    }
    if (n !== null && !(await this.confirmTake(n, t, confirmed))) {
      return;
    }
    await this.commitTarget(t, { number: n }, { hiddenMine: resolved.hiddenMine });
  }

  /** Alt+Shift+B Shift+1～9：游標那一行設為這個號碼；已經是這個號碼就拿掉。取消時不建立多餘書籤。 */
  async toggleNumber(n: number, confirmed?: boolean): Promise<void> {
    if (!(n >= 1 && n <= 9)) {
      return;
    }
    const resolved = await this.resolveForWrite(undefined);
    if (!resolved || 'outsideWorkspace' in resolved) {
      return;
    }
    const t = resolved.target;
    if (!t.pending && t.number === n) {
      await this.commitTarget(t, { number: null }, { hiddenMine: resolved.hiddenMine });
      return;
    }
    if (!(await this.confirmTake(n, t, confirmed))) {
      return;
    }
    await this.commitTarget(t, { number: n }, { hiddenMine: resolved.hiddenMine });
  }

  /** Alt+Shift+B 1～9：跳到這個號碼的書籤；沒有給號碼時列出所有有號碼的書籤。 */
  async goToNumber(n?: number): Promise<{ uri: vscode.Uri; line: number } | undefined> {
    const used = this.store.numbered();
    if (n === undefined) {
      if (!used.size) {
        void vscode.window.showInformationMessage(vscode.l10n.t('No numbered bookmarks yet. Press {0} on a line to add one.', setNumberKeys()));
        return undefined;
      }
      const pick = await vscode.window.showQuickPick(
        [...used.entries()]
          .sort(([a], [b]) => a - b)
          .map(([i, e]) => ({ label: `${circled(i)}  ${entryTitle(e)}`, description: entryWhere(e), i })),
        { title: vscode.l10n.t('Go to numbered bookmark') },
      );
      if (!pick) {
        return undefined;
      }
      n = pick.i;
    }
    const e = used.get(n);
    if (!e) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No bookmark has number {0}. Press {1} on a line to set it.', n, setNumberKey(n)));
      return undefined;
    }
    if (e.kind === 'line') {
      if (e.bookmark.status === 'notOnBranch' || !this.store.isVisible(e.folder, e.bookmark)) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Bookmark {0} is not on the current branch.', n));
        return undefined;
      }
      await revealLine(e.uri, e.bookmark.line);
      return { uri: e.uri, line: e.bookmark.line };
    }
    const fav = this.favorites.all.find(
      (f) => f.folder === e.folder && f.mark.file === e.mark.file && f.mark.path === e.mark.path && f.mark.kind === e.mark.kind,
    );
    if (fav) {
      await this.openFavorite(fav);
      const line = fav.symbol?.nameLine ?? fav.mark.line ?? 0;
      return { uri: e.uri, line };
    }
    await revealLine(e.uri, e.mark.line ?? 0);
    return { uri: e.uri, line: e.mark.line ?? 0 };
  }

  /**
   * 依編號（1→9）在有編號的書籤間循環導覽（跨檔案、跨資料夾）。
   * 跳轉後在狀態列顯示「導覽 i/N：名稱」，若書籤有備註則自動開啟該行滑鼠提示。
   */
  async tour(direction: 1 | -1): Promise<TourStepResult | undefined> {
    const used = this.store.numbered();
    const steps: { number: number; entry: NumberedEntry; line: number }[] = [];
    for (const [num, entry] of [...used.entries()].sort(([a], [b]) => a - b)) {
      if (entry.kind === 'line') {
        if (!this.store.isShown(entry.folder, entry.bookmark)) {
          continue;
        }
        steps.push({ number: num, entry, line: entry.bookmark.line });
      } else {
        if (!this.store.favoritesShown) {
          continue;
        }
        const fav = this.favorites.all.find(
          (f) => f.folder === entry.folder && f.mark.file === entry.mark.file && f.mark.path === entry.mark.path && f.mark.kind === entry.mark.kind,
        );
        const line = fav?.symbol?.nameLine ?? entry.mark.line ?? 0;
        steps.push({ number: num, entry, line });
      }
    }
    if (!steps.length) {
      this.lastTourStatus = undefined;
      void vscode.window.showInformationMessage(vscode.l10n.t('No numbered bookmarks yet. Press {0} on a line to add one.', setNumberKeys()));
      return undefined;
    }

    // 優先以目前游標正好停在的編號書籤為起點，否則沿用上次導覽位置
    const editor = vscode.window.activeTextEditor;
    let curIdx = -1;
    if (editor) {
      const curUri = editor.document.uri.toString();
      const curLine = editor.selection.active.line;
      curIdx = steps.findIndex((s) => s.entry.uri.toString() === curUri && s.line === curLine);
    }
    if (curIdx === -1 && this.lastTourNumber !== undefined) {
      curIdx = steps.findIndex((s) => s.number === this.lastTourNumber);
    }
    const nextIdx =
      curIdx === -1
        ? direction === 1
          ? 0
          : steps.length - 1
        : (curIdx + direction + steps.length) % steps.length;
    const step = steps[nextIdx];
    const e = step.entry;
    let landedLine = step.line;
    if (e.kind === 'line') {
      await revealLine(e.uri, e.bookmark.line);
      landedLine = e.bookmark.line;
    } else {
      const fav = this.favorites.all.find(
        (f) => f.folder === e.folder && f.mark.file === e.mark.file && f.mark.path === e.mark.path && f.mark.kind === e.mark.kind,
      );
      if (fav) {
        await this.openFavorite(fav);
        landedLine = fav.symbol?.nameLine ?? fav.mark.line ?? 0;
      } else {
        await revealLine(e.uri, e.mark.line ?? 0);
        landedLine = e.mark.line ?? 0;
      }
    }

    this.lastTourNumber = step.number;
    const title = entryTitle(e);
    const status = vscode.l10n.t('Tour {0}/{1}: {2}', nextIdx + 1, steps.length, title);
    this.lastTourStatus = status;
    vscode.window.setStatusBarMessage(`$(compass) ${status}`, 6000);

    const hasNote = e.kind === 'line' ? Boolean(e.bookmark.note) : Boolean(e.mark.note);
    if (hasNote) {
      // 先確保編輯器行號旁與整行的備註裝飾已畫上，再打開滑鼠提示
      await this.beforeShowHover?.();
      await vscode.commands.executeCommand('editor.action.showHover').then(undefined, () => undefined);
    }
    return { number: step.number, index: nextIdx + 1, total: steps.length, title, uri: e.uri, line: landedLine, hasNote };
  }

  private colorItems(current: string | undefined, defaultLabel: string) {
    type Item = vscode.QuickPickItem & { value: string | null };
    const items: Item[] = PALETTE.map((c) => ({
      label: colorName(c.id),
      iconPath: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(c.theme)),
      description: c.id === current ? vscode.l10n.t('current') : undefined,
      value: c.id,
    }));
    items.push({
      label: defaultLabel,
      iconPath: new vscode.ThemeIcon('circle-outline'),
      description: current ? undefined : vscode.l10n.t('current'),
      value: null,
    });
    return items;
  }

  /** 書籤顏色：`value` 為色盤 id，null 為恢復預設（用標籤的顏色）。取消時不建立多餘書籤。 */
  async setColor(node?: unknown, value?: string | null): Promise<void> {
    const resolved = await this.resolveForWrite(node);
    if (!resolved) {
      return this.noBookmark();
    }
    if ('outsideWorkspace' in resolved) {
      return;
    }
    const t = resolved.target;
    let color = value;
    if (color === undefined) {
      const pick = await vscode.window.showQuickPick(this.colorItems(t.color, vscode.l10n.t('Default (tag color)')), {
        title: vscode.l10n.t('Color for "{0}"', t.title),
      });
      if (!pick) {
        return;
      }
      color = pick.value;
    }
    if (color !== null && !paletteColor(color)) {
      return;
    }
    await this.commitTarget(t, { color }, { applyAutoNumber: true, hiddenMine: resolved.hiddenMine });
  }

  /** 標籤顏色：沒有顏色的書籤用它第一個有顏色的標籤的顏色。可從依標籤分組的標籤節點呼叫。 */
  async setTagColor(arg?: unknown, value?: string | null): Promise<void> {
    const n = arg as NodeLike | undefined;
    let tag = typeof arg === 'string' ? arg : n?.by === 'tag' ? n.key : undefined;
    const all = [...new Set(allBookmarkItems(this.store, this.favorites).flatMap((i) => itemTags(i)))].sort();
    if (!tag) {
      if (!all.length) {
        void vscode.window.showInformationMessage(vscode.l10n.t('No tags yet. Add tags to bookmarks first.'));
        return;
      }
      const colors = this.store.tagColors();
      const pick = await vscode.window.showQuickPick(
        all.map((t) => {
          const c = paletteColor(colors.get(t));
          return {
            label: `#${t}`,
            iconPath: new vscode.ThemeIcon(c ? 'circle-filled' : 'circle-outline', c ? new vscode.ThemeColor(c.theme) : undefined),
            description: c ? colorName(c.id) : undefined,
            t,
          };
        }),
        { title: vscode.l10n.t('Set the color of which tag?') },
      );
      if (!pick) {
        return;
      }
      tag = pick.t;
    }
    let color = value;
    if (color === undefined) {
      const pick = await vscode.window.showQuickPick(this.colorItems(this.store.tagColors().get(tag), vscode.l10n.t('No color')), {
        title: vscode.l10n.t('Color for #{0}', tag),
      });
      if (!pick) {
        return;
      }
      color = pick.value;
    }
    if (color !== null && !paletteColor(color)) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      return;
    }
    let targets: readonly vscode.WorkspaceFolder[];
    if (color === null) {
      // 清除顏色：寫進所有 tagColors 裡有這個標籤的資料夾；沒有任何資料夾有就什麼都不寫
      targets = folders.filter((f) => this.store.hasTagColor(f, tag!));
    } else {
      // 設定顏色：只寫進已經有書籤資料的資料夾（避免在空資料夾建立書籤檔）；都沒有時只寫第一個
      const withData = folders.filter((f) => this.store.hasData(f));
      targets = withData.length ? withData : [folders[0]];
    }
    for (const folder of targets) {
      await this.store.update(folder, (d) => setTagColor(d, tag!, color ?? undefined));
    }
  }

  private noBookmark(): void {
    void vscode.window.showInformationMessage(vscode.l10n.t('There is no bookmark on this line.'));
  }
}
