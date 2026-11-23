import * as vscode from 'vscode';
import { DetectedSymbol } from '../detection/types';
import { clearNumber, MarkKey, setSymbolExtras, setTagColor, updateBookmark } from '../storage/marks';
import { MarkStore, NumberedEntry } from '../storage/store';
import { FavoritesModel } from '../symbols/favorites';
import { SymbolService } from '../symbols/symbolService';
import { BookmarkCommands, bookmarkTitle, revealLine } from './commands';
import { circled, nextFreeNumber, PALETTE, paletteColor } from './decor';
import { itemTags, allBookmarkItems } from './unified';

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

function sameTarget(e: NumberedEntry, t: ExtrasTarget): boolean {
  if (e.folder !== t.folder) {
    return false;
  }
  return e.kind === 'line'
    ? t.kind === 'line' && e.bookmark.id === t.id
    : t.kind === 'symbol' && e.mark.file === t.key.file && e.mark.path === t.key.path && e.mark.kind === t.key.kind;
}

/**
 * M7：數字快速書籤（1～9）、書籤與標籤顏色。
 */
export class BookmarkExtras {
  constructor(
    private readonly store: MarkStore,
    private readonly service: SymbolService,
    private readonly favorites: FavoritesModel,
    private readonly bookmarks: BookmarkCommands,
    private readonly openFavorite: (fav: FavoritesModel['all'][number]) => Promise<void>,
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
    // 這一行還沒有書籤：照 Ctrl+Alt+B 的規則加入（函式名稱那一行加函式書籤，其他行加行號書籤）
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

  /** 寫入號碼（null 為拿掉）；同一個號碼在其他書籤上的會一併拿掉。 */
  private async writeNumber(t: ExtrasTarget, n: number | null): Promise<void> {
    if (n !== null) {
      const except = t.kind === 'line' ? { bookmarkId: t.id } : { key: t.key };
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder !== t.folder) {
          await this.store.update(folder, (d) => clearNumber(d, n));
        }
      }
      await this.store.update(t.folder, (d) => this.patch(clearNumber(d, n, except), t, { number: n }));
      return;
    }
    await this.store.update(t.folder, (d) => this.patch(d, t, { number: null }));
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
  private async confirmTake(n: number, t: ExtrasTarget, confirmed?: boolean): Promise<boolean> {
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
   * 游標那一行還沒有書籤時會先加入書籤。
   */
  async setNumber(node?: unknown, value?: number | 'next' | null, confirmed?: boolean): Promise<void> {
    const t = await this.target(node, true);
    if (!t) {
      return this.noBookmark();
    }
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
      if (t.number) {
        items.push({ label: `$(close) ${vscode.l10n.t('Remove number')}`, value: null });
      }
      const pick = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t('Number for "{0}" (jump with Ctrl+Alt+1–9)', t.title),
      });
      if (!pick) {
        return;
      }
      n = pick.value;
    }
    if (n === 'next') {
      if (t.number) {
        return;
      }
      n = nextFreeNumber(used.keys()) ?? null;
      if (n === null) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Numbers 1–9 are all used.'));
        return;
      }
    }
    if (n !== null && !(await this.confirmTake(n, t, confirmed))) {
      return;
    }
    await this.writeNumber(t, n);
  }

  /** Ctrl+Alt+Shift+1～9：游標那一行設為這個號碼；已經是這個號碼就拿掉。 */
  async toggleNumber(n: number, confirmed?: boolean): Promise<void> {
    if (!(n >= 1 && n <= 9)) {
      return;
    }
    const existed = await this.target(undefined, false);
    const t = existed ?? (await this.target(undefined, true));
    if (!t) {
      return;
    }
    // 剛加入的書籤可能已自動給了號碼（設定 autoNumber），不能當成「已經是這個號碼」而拿掉
    if (existed && t.number === n) {
      await this.writeNumber(t, null);
      return;
    }
    if (!(await this.confirmTake(n, t, confirmed))) {
      return;
    }
    await this.writeNumber(t, n);
  }

  /** Ctrl+Alt+1～9：跳到這個號碼的書籤；沒有給號碼時列出所有有號碼的書籤。 */
  async goToNumber(n?: number): Promise<{ uri: vscode.Uri; line: number } | undefined> {
    const used = this.store.numbered();
    if (n === undefined) {
      if (!used.size) {
        void vscode.window.showInformationMessage(vscode.l10n.t('No numbered bookmarks yet. Press Ctrl+Alt+Shift+1–9 on a line to add one.'));
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
      void vscode.window.showInformationMessage(vscode.l10n.t('No bookmark has number {0}. Press Ctrl+Alt+Shift+{0} on a line to set it.', n));
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

  /** 書籤顏色：`value` 為色盤 id，null 為恢復預設（用標籤的顏色）。 */
  async setColor(node?: unknown, value?: string | null): Promise<void> {
    const t = await this.target(node, true);
    if (!t) {
      return this.noBookmark();
    }
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
    await this.store.update(t.folder, (d) => this.patch(d, t, { color }));
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
    // 每個資料夾各存一份，同一個標籤在所有資料夾都是同一個顏色
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await this.store.update(folder, (d) => setTagColor(d, tag!, color ?? undefined));
    }
  }

  private noBookmark(): void {
    void vscode.window.showInformationMessage(vscode.l10n.t('There is no bookmark on this line.'));
  }
}
