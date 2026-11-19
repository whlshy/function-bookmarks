import * as vscode from 'vscode';
import { TemplateResolver } from './django/resolver';
import { findPartial, splitTemplateTarget } from './django/templates';
import { findByPath, findInnermost } from './detection/engine';
import { DetectedSymbol, SymbolKindName } from './detection/types';
import { parseTags } from './bookmarks/model';
import { MarkKey, setAlias, setFavorite, setNote, setTags } from './storage/marks';
import { MarkStore } from './storage/store';
import { ResolvedFavorite } from './symbols/favorites';
import { SymbolService } from './symbols/symbolService';
import { NoteEditor } from './views/noteEditor';
import { COMMANDS, FavoriteNode, SymbolNode, TreeNode } from './views/tree';

export interface Target {
  uri: vscode.Uri;
  /** 偵測到的符號；收藏中的函式找不到時為 undefined。 */
  symbol?: DetectedSymbol;
  key: Pick<MarkKey, 'path' | 'kind'>;
  name: string;
  line?: number;
}

export async function reveal(uri: vscode.Uri, line: number, startCol = 0, endCol = startCol): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(uri, { preserveFocus: false });
  const range = new vscode.Range(line, startCol, line, endCol);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  return editor;
}

export function revealSymbol(uri: vscode.Uri, s: DetectedSymbol): Promise<vscode.TextEditor> {
  return reveal(uri, s.nameLine, s.nameStartCol, s.nameEndCol);
}

interface LinkArg {
  uri: string;
  path: string;
  kind: SymbolKindName;
}

/** 提示中「在預覽中開啟」連結傳來的參數（不是樹狀節點）。 */
function isLinkArg(arg: unknown): arg is LinkArg {
  const a = arg as Partial<LinkArg> | undefined;
  return !!a && typeof a.uri === 'string' && typeof a.path === 'string' && typeof a.kind === 'string';
}

export class Commands {
  constructor(
    private readonly service: SymbolService,
    private readonly store: MarkStore,
    private readonly resolver: TemplateResolver,
    private readonly notes: NoteEditor,
  ) {}

  /** 從樹狀節點，或（沒有節點時）從游標所在位置取得目標函式。 */
  async target(node?: TreeNode): Promise<Target | undefined> {
    if (node?.type === 'symbol') {
      return this.fromSymbol(node.uri, node.symbol);
    }
    if (node?.type === 'favorite') {
      const { fav } = node;
      return {
        uri: fav.uri,
        symbol: fav.symbol,
        key: { path: fav.mark.path, kind: fav.mark.kind },
        name: fav.mark.path.split('.').pop() ?? fav.mark.path,
        line: fav.symbol?.nameLine ?? fav.mark.line,
      };
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const file = await this.service.getSymbols(editor.document);
    const sym = findInnermost(file.symbols, editor.selection.active.line);
    if (!sym || sym.kind === 'reference') {
      void vscode.window.showInformationMessage(vscode.l10n.t('No function at the cursor.'));
      return undefined;
    }
    return this.fromSymbol(editor.document.uri, sym);
  }

  private fromSymbol(uri: vscode.Uri, s: DetectedSymbol): Target {
    return { uri, symbol: s, key: { path: s.path, kind: s.kind }, name: s.name, line: s.nameLine };
  }

  private located(t: Target) {
    const loc = this.store.locate(t.uri);
    if (!loc) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Only files inside a workspace folder can be favorited or renamed.'));
      return undefined;
    }
    return { ...loc, key: { file: loc.rel, ...t.key } as MarkKey };
  }

  async setFavorite(node: TreeNode | undefined, value: boolean | 'toggle'): Promise<void> {
    const t = await this.target(node);
    if (!t) {
      return;
    }
    if (t.symbol?.kind === 'reference') {
      return;
    }
    const loc = this.located(t);
    if (!loc) {
      return;
    }
    const current = !!this.store.get(t.uri, t.key)?.favorite;
    const next = value === 'toggle' ? !current : value;
    await this.store.update(loc.folder, (d) => setFavorite(d, loc.key, next, t.line));
  }

  async rename(node?: TreeNode, value?: string): Promise<void> {
    const t = await this.target(node);
    if (!t) {
      return;
    }
    const loc = this.located(t);
    if (!loc) {
      return;
    }
    const currentAlias = this.store.get(t.uri, t.key)?.alias;
    const input =
      value ??
      (await vscode.window.showInputBox({
        title: vscode.l10n.t('Display name'),
        prompt: vscode.l10n.t('Original: {0} — leave empty to use the original name', t.key.path),
        value: currentAlias ?? t.name,
        valueSelection: [0, (currentAlias ?? t.name).length],
      }));
    if (input === undefined) {
      return;
    }
    await this.store.update(loc.folder, (d) => setAlias(d, loc.key, input, t.name, t.line));
  }

  /** 函式上方「加入書籤」可點文字：切換指定函式的書籤。 */
  async toggleFavoriteAt(uri: vscode.Uri, path: string, kind: SymbolKindName, line: number): Promise<void> {
    const loc = this.store.locate(uri);
    if (!loc) {
      return;
    }
    const key: MarkKey = { file: loc.rel, path, kind };
    const on = !!this.store.get(uri, { path, kind })?.favorite;
    await this.store.update(loc.folder, (d) => setFavorite(d, key, !on, line));
  }

  /** 編輯函式書籤的標籤。 */
  async editTags(node?: TreeNode, value?: string): Promise<void> {
    const t = await this.target(node);
    if (!t) {
      return;
    }
    const loc = this.located(t);
    if (!loc) {
      return;
    }
    const mark = this.store.get(t.uri, t.key);
    const current = (mark?.tags ?? []).map((x) => `#${x}`).join(' ');
    const input =
      value ??
      (await vscode.window.showInputBox({
        title: vscode.l10n.t('Tags'),
        prompt: vscode.l10n.t('Separate with spaces or commas, e.g. #auth #todo'),
        value: current ? `${current} ` : '',
      }));
    if (input === undefined) {
      return;
    }
    const tags = parseTags(input);
    // 加標籤代表要當成書籤，順便加入函式書籤
    await this.store.update(loc.folder, (d) => setTags(tags.length ? setFavorite(d, loc.key, true, t.line) : d, loc.key, tags));
  }

  /** 開啟備註編輯分頁；`value` 有值時直接寫入（測試用）。 */
  async editNote(node?: TreeNode, value?: string): Promise<void> {
    const t = await this.target(node);
    if (!t || t.symbol?.kind === 'reference') {
      return;
    }
    const loc = this.located(t);
    if (!loc) {
      return;
    }
    if (value !== undefined) {
      await this.store.update(loc.folder, (d) => setNote(d, loc.key, value, t.line));
      return;
    }
    const mark = this.store.get(t.uri, t.key);
    await this.notes.open({
      id: `${loc.folder.uri.toString()}|${loc.key.file}|${loc.key.kind}|${loc.key.path}`,
      title: mark?.alias ?? t.name,
      subject: t.key.path,
      current: mark?.note,
      apply: async (text) => {
        await this.store.update(loc.folder, (d) => setNote(d, loc.key, text, t.line));
      },
    });
  }

  /** 用 Markdown 預覽分頁查看備註；可從樹狀節點、游標，或提示中的連結（帶 uri／path／kind）呼叫。 */
  async previewNote(arg?: TreeNode | LinkArg): Promise<void> {
    let uri: vscode.Uri;
    let key: Pick<MarkKey, 'path' | 'kind'>;
    let name: string;
    let line: number | undefined;
    if (isLinkArg(arg)) {
      uri = vscode.Uri.parse(arg.uri);
      key = { path: arg.path, kind: arg.kind };
      name = arg.path.split('.').pop() ?? arg.path;
    } else {
      const t = await this.target(arg as TreeNode | undefined);
      if (!t) {
        return;
      }
      ({ uri, key, name, line } = t);
    }
    const mark = this.store.get(uri, key);
    if (!mark?.note) {
      void vscode.window.showInformationMessage(vscode.l10n.t('There is no note on {0}.', key.path));
      return;
    }
    const at = line ?? mark.line;
    const subtitle = `\`${key.path}\` · ${vscode.workspace.asRelativePath(uri, false)}${at !== undefined ? `:${at + 1}` : ''}`;
    await this.notes.preview(mark.alias ?? name, subtitle, mark.note);
  }

  async openFavorite(fav: ResolvedFavorite): Promise<void> {
    const file = await this.service.getForUri(fav.uri);
    if (!file) {
      void vscode.window.showWarningMessage(vscode.l10n.t('File not found: {0}', fav.mark.file));
      return;
    }
    const sym = findByPath(file.symbols, fav.mark.path, fav.mark.kind);
    if (sym) {
      await revealSymbol(fav.uri, sym);
      return;
    }
    await reveal(fav.uri, fav.mark.line ?? 0);
    void vscode.window.showWarningMessage(
      vscode.l10n.t('"{0}" was not found; jumped to its last known position.', fav.mark.path),
    );
  }

  async openTemplate(node?: TreeNode): Promise<void> {
    if (node?.type !== 'symbol' || !node.symbol.target) {
      return;
    }
    const target = node.symbol.target;
    const uri = await this.resolver.resolve(target, node.uri);
    if (!uri) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Template "{0}" was not found. Add its folder to functionBookmarks.django.templateDirs.', target),
      );
      return;
    }
    const { partial } = splitTemplateTarget(target);
    if (partial) {
      const file = await this.service.getForUri(uri);
      const sym = file && findPartial(file.symbols, partial);
      if (sym) {
        await revealSymbol(uri, sym);
        return;
      }
    }
    await reveal(uri, 0);
  }

  async goToReferenceLine(node?: TreeNode): Promise<void> {
    if (node?.type === 'symbol') {
      await revealSymbol(node.uri, node.symbol);
    }
  }

  async goToParentBlock(node?: TreeNode): Promise<void> {
    const n = node as SymbolNode | undefined;
    if (n?.type !== 'symbol' || !n.override) {
      return;
    }
    await revealSymbol(n.override.uri, n.override.symbol);
  }
}

export type { FavoriteNode };
export { COMMANDS };
