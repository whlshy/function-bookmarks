import * as path from 'path';
import { uriKey } from '../util/uris';
import * as vscode from 'vscode';
import { OverrideInfo, TemplateResolver } from '../django/resolver';
import { findInnermost } from '../detection/engine';
import { DetectedSymbol, SymbolKindName } from '../detection/types';
import { MarkStore } from '../storage/store';
import { FavoritesModel, ResolvedFavorite } from '../symbols/favorites';
import { ProjectFiles } from '../symbols/projectFiles';
import { DirTree } from '../symbols/projectTree';
import { FileSymbols, SymbolService } from '../symbols/symbolService';
import { basenamePosix } from '../util/paths';

export type SectionId = 'favorites' | 'currentFile' | 'project';
export type FilterMode = 'all' | 'favorites';

export interface SectionNode {
  type: 'section';
  section: SectionId;
}
export interface FavGroupNode {
  type: 'favGroup';
  folder: vscode.WorkspaceFolder;
  uri: vscode.Uri;
  rel: string;
  items: ResolvedFavorite[];
  parent: SectionNode;
}
export interface FavoriteNode {
  type: 'favorite';
  fav: ResolvedFavorite;
  parent: SectionNode | FavGroupNode;
}
export interface SymbolNode {
  type: 'symbol';
  scope: 'current' | 'project';
  uri: vscode.Uri;
  symbol: DetectedSymbol;
  parent: TreeNode;
  children: SymbolNode[];
  id: string;
  override?: OverrideInfo;
}
export interface WsFolderNode {
  type: 'wsFolder';
  folder: vscode.WorkspaceFolder;
  parent: SectionNode;
}
export interface DirNode {
  type: 'dir';
  folder: vscode.WorkspaceFolder;
  dir: DirTree;
  parent: TreeNode;
}
export interface FileNode {
  type: 'file';
  folder: vscode.WorkspaceFolder;
  uri: vscode.Uri;
  rel: string;
  parent: TreeNode;
}
export type TreeNode = SectionNode | FavGroupNode | FavoriteNode | SymbolNode | WsFolderNode | DirNode | FileNode;

export const ICONS: Record<SymbolKindName, string> = {
  function: 'symbol-function',
  method: 'symbol-method',
  class: 'symbol-class',
  block: 'symbol-namespace',
  partial: 'symbol-snippet',
  macro: 'symbol-method',
  reference: 'go-to-file',
};

const REFERENCE_KEYWORD: Record<string, string> = {
  'dj-extends': 'extends',
  'dj-include': 'include',
};

export const COMMANDS = {
  reveal: 'functionBookmarks.revealSymbol',
  openFavorite: 'functionBookmarks.openFavorite',
  openTemplate: 'functionBookmarks.openTemplate',
};

export function displayName(name: string, alias: string | undefined): string {
  return alias ?? name;
}

export class FunctionTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  readonly sections: Record<SectionId, SectionNode> = {
    favorites: { type: 'section', section: 'favorites' },
    currentFile: { type: 'section', section: 'currentFile' },
    project: { type: 'section', section: 'project' },
  };

  private current?: FileSymbols;
  private currentNodes: SymbolNode[] = [];
  private fileLabel?: string;
  filterMode: FilterMode = 'all';
  groupByFile = true;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly service: SymbolService,
    private readonly store: MarkStore,
    private readonly favorites: FavoritesModel,
    private readonly project: ProjectFiles,
    private readonly resolver: TemplateResolver,
  ) {
    this.disposables.push(
      favorites.onDidChange(() => this.fire()),
      store.onDidChange(() => this.fire()),
      project.onDidChange(() => this.fire()),
    );
  }

  dispose(): void {
    [...this.disposables, this.changed].forEach((d) => d.dispose());
  }

  fire(): void {
    this.changed.fire(undefined);
  }

  get currentFile(): FileSymbols | undefined {
    return this.current;
  }

  get currentSymbolNodes(): SymbolNode[] {
    return this.currentNodes;
  }

  /** 重新讀取目前編輯器的函式。回傳 true 表示有內容。 */
  async refresh(editor: vscode.TextEditor | undefined): Promise<boolean> {
    if (!editor || !['file', 'untitled', 'vscode-remote', 'vscode-vfs'].includes(editor.document.uri.scheme)) {
      this.current = undefined;
      this.fileLabel = undefined;
      this.currentNodes = [];
      this.fire();
      return false;
    }
    const doc = editor.document;
    const file = await this.service.getSymbols(doc);
    let overrides = new Map<string, OverrideInfo>();
    if (file.symbols.some((s) => s.ruleId === 'dj-extends')) {
      overrides = await this.resolver.overrides(doc.uri, file.symbols).catch(() => new Map<string, OverrideInfo>());
    }
    this.current = file;
    this.fileLabel = path.basename(doc.uri.fsPath || doc.uri.path);
    this.currentNodes = this.buildSymbolNodes(file.symbols, doc.uri, this.sections.currentFile, 'current', overrides);
    this.fire();
    return this.currentNodes.length > 0;
  }

  private buildSymbolNodes(
    symbols: DetectedSymbol[],
    uri: vscode.Uri,
    parent: TreeNode,
    scope: 'current' | 'project',
    overrides: Map<string, OverrideInfo> = new Map(),
    counts = new Map<string, number>(),
  ): SymbolNode[] {
    return symbols.map((s) => {
      // id 以「路徑＋同名序號」組成，編輯時行號改變也不會讓展開狀態重置
      const base = `${scope}:${uriKey(uri)}::${s.kind}:${s.path}`;
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      const node: SymbolNode = {
        type: 'symbol',
        scope,
        uri,
        symbol: s,
        parent,
        children: [],
        id: `${base}#${n}`,
        override: s.ruleId === 'dj-block' ? overrides.get(s.name) : undefined,
      };
      node.children = this.buildSymbolNodes(s.children, uri, node, scope, overrides, counts);
      return node;
    });
  }

  /** 找出包住指定行的最內層節點（游標跟隨用）。 */
  nodeAt(line: number): SymbolNode | undefined {
    if (!this.current) {
      return undefined;
    }
    const target = findInnermost(this.current.symbols, line);
    if (!target) {
      return undefined;
    }
    const walk = (nodes: SymbolNode[]): SymbolNode | undefined => {
      for (const n of nodes) {
        if (n.symbol === target) {
          return n;
        }
        const hit = walk(n.children);
        if (hit) {
          return hit;
        }
      }
      return undefined;
    };
    return walk(this.currentNodes);
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      if (this.filterMode === 'favorites') {
        return [this.sections.favorites];
      }
      return [this.sections.favorites, this.sections.currentFile, this.sections.project];
    }
    switch (element.type) {
      case 'section':
        return this.sectionChildren(element);
      case 'favGroup':
        return element.items.map((fav) => ({ type: 'favorite', fav, parent: element }) as FavoriteNode);
      case 'symbol':
        return element.children;
      case 'wsFolder': {
        const files = await this.project.list(element.folder);
        return this.dirChildren(element.folder, files.tree, element);
      }
      case 'dir':
        return this.dirChildren(element.folder, element.dir, element);
      case 'file': {
        const file = await this.service.getForUri(element.uri);
        return file ? this.buildSymbolNodes(file.symbols, element.uri, element, 'project') : [];
      }
      default:
        return [];
    }
  }

  private async sectionChildren(section: SectionNode): Promise<TreeNode[]> {
    if (section.section === 'currentFile') {
      return this.currentNodes;
    }
    if (section.section === 'favorites') {
      const items = [...this.favorites.all];
      if (!this.groupByFile) {
        return items
          .sort((a, b) => this.favLabel(a).localeCompare(this.favLabel(b)))
          .map((fav) => ({ type: 'favorite', fav, parent: section }) as FavoriteNode);
      }
      const groups = new Map<string, FavGroupNode>();
      for (const fav of items) {
        const key = uriKey(fav.uri);
        let g = groups.get(key);
        if (!g) {
          g = { type: 'favGroup', folder: fav.folder, uri: fav.uri, rel: fav.mark.file, items: [], parent: section };
          groups.set(key, g);
        }
        g.items.push(fav);
      }
      for (const g of groups.values()) {
        g.items.sort((a, b) => (a.symbol?.startOffset ?? Infinity) - (b.symbol?.startOffset ?? Infinity) || a.mark.path.localeCompare(b.mark.path));
      }
      return [...groups.values()].sort((a, b) => a.rel.localeCompare(b.rel));
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) {
      return this.dirChildren(folders[0], (await this.project.list(folders[0])).tree, section);
    }
    return folders.map((folder) => ({ type: 'wsFolder', folder, parent: section }) as WsFolderNode);
  }

  private dirChildren(folder: vscode.WorkspaceFolder, dir: DirTree, parent: TreeNode): TreeNode[] {
    return [
      ...dir.dirs.map((d) => ({ type: 'dir', folder, dir: d, parent }) as DirNode),
      ...dir.files.map((rel) => ({ type: 'file', folder, rel, uri: this.store.uriOf(folder, rel), parent }) as FileNode),
    ];
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return element.type === 'section' ? undefined : element.parent;
  }

  private favLabel(fav: ResolvedFavorite): string {
    return displayName(fav.mark.path.split('.').pop() ?? fav.mark.path, fav.mark.alias);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.type) {
      case 'section':
        return this.sectionItem(element);
      case 'favGroup': {
        const item = new vscode.TreeItem(basenamePosix(element.rel), vscode.TreeItemCollapsibleState.Expanded);
        item.id = `favGroup:${element.uri.toString()}`;
        item.resourceUri = element.uri;
        item.iconPath = vscode.ThemeIcon.File;
        item.description = path.posix.dirname(element.rel) === '.' ? '' : path.posix.dirname(element.rel);
        item.tooltip = element.rel;
        item.contextValue = 'fbFavGroup';
        return item;
      }
      case 'favorite':
        return this.favoriteItem(element);
      case 'symbol':
        return this.symbolItem(element);
      case 'wsFolder': {
        const item = new vscode.TreeItem(element.folder.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `ws:${element.folder.uri.toString()}`;
        item.iconPath = new vscode.ThemeIcon('root-folder');
        return item;
      }
      case 'dir': {
        const item = new vscode.TreeItem(element.dir.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `dir:${element.folder.uri.toString()}:${element.dir.path}`;
        item.resourceUri = this.store.uriOf(element.folder, element.dir.path);
        item.iconPath = vscode.ThemeIcon.Folder;
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(basenamePosix(element.rel), vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `file:${element.uri.toString()}`;
        item.resourceUri = element.uri;
        item.iconPath = vscode.ThemeIcon.File;
        item.tooltip = element.rel;
        item.contextValue = 'fbFile';
        return item;
      }
    }
  }

  private sectionItem(element: SectionNode): vscode.TreeItem {
    if (element.section === 'favorites') {
      const count = this.favorites.all.length;
      const item = new vscode.TreeItem(vscode.l10n.t('Favorites'), vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'section:favorites';
      item.iconPath = new vscode.ThemeIcon('star-full');
      item.description = count ? String(count) : vscode.l10n.t('Click ☆ on a function to add it');
      item.contextValue = 'fbSection.favorites';
      return item;
    }
    if (element.section === 'project') {
      const item = new vscode.TreeItem(vscode.l10n.t('Whole project'), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'section:project';
      item.iconPath = new vscode.ThemeIcon('folder-library');
      item.contextValue = 'fbSection.project';
      return item;
    }
    const item = new vscode.TreeItem(
      this.fileLabel ? vscode.l10n.t('Current file: {0}', this.fileLabel) : vscode.l10n.t('Current file'),
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = 'section:currentFile';
    item.iconPath = new vscode.ThemeIcon('file-code');
    item.contextValue = 'fbSection.currentFile';
    if (!this.current) {
      item.description = vscode.l10n.t('No file open');
    } else if (this.currentNodes.length === 0) {
      item.description = vscode.l10n.t('No functions detected');
    } else if (this.current.source === 'languageServer') {
      item.description = vscode.l10n.t('from language server');
    }
    return item;
  }

  private tooltip(name: string, alias: string | undefined, symPath: string, rel: string, line: number | undefined, extra: string[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMd(alias ?? name)}**\n\n`);
    if (alias) {
      md.appendMarkdown(`${vscode.l10n.t('Original name')}: \`${name}\`\n\n`);
    }
    md.appendMarkdown(`${vscode.l10n.t('Path')}: \`${symPath}\`\n\n`);
    md.appendMarkdown(`${escapeMd(rel)}${line !== undefined ? `:${line + 1}` : ''}`);
    for (const e of extra) {
      md.appendMarkdown(`\n\n${e}`);
    }
    return md;
  }

  private symbolItem(element: SymbolNode): vscode.TreeItem {
    const s = element.symbol;
    const mark = this.store.get(element.uri, s);
    const isRef = s.kind === 'reference';
    const item = new vscode.TreeItem(
      displayName(s.name, mark?.alias),
      element.children.length
        ? element.scope === 'current'
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = element.id;
    item.iconPath = new vscode.ThemeIcon(ICONS[s.kind] ?? 'symbol-misc');
    const prefix = `${mark?.favorite ? '★' : ''}${mark?.alias ? '✎' : ''}`;
    const parts: string[] = [];
    const keyword = REFERENCE_KEYWORD[s.ruleId];
    if (keyword) {
      parts.push(keyword);
    }
    parts.push(String(s.nameLine + 1));
    if (element.override) {
      parts.push(vscode.l10n.t('overrides {0}', basenamePosix(element.override.label)));
    }
    item.description = prefix ? `${prefix} ${parts.join(' · ')}` : parts.join(' · ');
    const extra = [`${vscode.l10n.t('Rule')}: \`${s.ruleId}\``];
    if (element.override) {
      extra.push(vscode.l10n.t('Overrides the block in {0}', element.override.label));
    }
    item.tooltip = this.tooltip(s.name, mark?.alias, s.path, vscode.workspace.asRelativePath(element.uri, false), s.nameLine, extra);
    item.contextValue = `fbSymbol:${mark?.favorite ? 'fav' : 'nofav'}${mark?.alias ? ':alias' : ''}${isRef ? ':ref' : ''}${
      element.override ? ':override' : ''
    }`;
    item.command = isRef
      ? { command: COMMANDS.openTemplate, title: vscode.l10n.t('Open template'), arguments: [element] }
      : {
          command: COMMANDS.reveal,
          title: vscode.l10n.t('Go to symbol'),
          arguments: [element.uri, s.nameLine, s.nameStartCol, s.nameEndCol],
        };
    return item;
  }

  private favoriteItem(element: FavoriteNode): vscode.TreeItem {
    const { fav } = element;
    const name = fav.mark.path.split('.').pop() ?? fav.mark.path;
    const item = new vscode.TreeItem(this.favLabel(fav), vscode.TreeItemCollapsibleState.None);
    item.id = `fav:${fav.uri.toString()}::${fav.mark.kind}:${fav.mark.path}`;
    const line = fav.symbol?.nameLine ?? fav.mark.line;
    const parts: string[] = [];
    if (fav.mark.alias) {
      parts.push('✎');
    }
    if (fav.status === 'ok') {
      parts.push(this.groupByFile ? String(line! + 1) : `${basenamePosix(fav.mark.file)}:${line! + 1}`);
      item.iconPath = new vscode.ThemeIcon(ICONS[fav.mark.kind] ?? 'symbol-misc');
    } else {
      parts.push(fav.status === 'missing' ? vscode.l10n.t('function not found') : vscode.l10n.t('file not found'));
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('disabledForeground'));
    }
    item.description = parts.join(' ');
    const extra: string[] = [];
    if (fav.status !== 'ok') {
      extra.push(
        fav.status === 'missing'
          ? vscode.l10n.t('This function was not found in the file. It may have been renamed or deleted.')
          : vscode.l10n.t('The file does not exist.'),
      );
    }
    item.tooltip = this.tooltip(name, fav.mark.alias, fav.mark.path, fav.mark.file, line, extra);
    item.contextValue = `fbFavorite:fav${fav.mark.alias ? ':alias' : ''}:${fav.status}`;
    item.command = { command: COMMANDS.openFavorite, title: vscode.l10n.t('Go to symbol'), arguments: [fav] };
    return item;
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
