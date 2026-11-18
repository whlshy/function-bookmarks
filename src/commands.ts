import * as vscode from 'vscode';
import { TemplateResolver } from './django/resolver';
import { findPartial, splitTemplateTarget } from './django/templates';
import { findByPath, findInnermost } from './detection/engine';
import { DetectedSymbol } from './detection/types';
import { MarkKey, setAlias, setFavorite } from './storage/marks';
import { MarkStore } from './storage/store';
import { ResolvedFavorite } from './symbols/favorites';
import { SymbolService } from './symbols/symbolService';
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

export class Commands {
  constructor(
    private readonly service: SymbolService,
    private readonly store: MarkStore,
    private readonly resolver: TemplateResolver,
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
