import * as path from 'path';
import { openDocumentFor } from '../symbols/documentSource';
import { bookmarkPreviewLink, previewNoteLink, trustPreviewLink } from './noteEditor';
import { bookmarkTitle } from '../bookmarks/commands';
import { BookmarkItem, compareItems, itemSource, itemTags, shownBookmarkItems } from '../bookmarks/unified';
import { BookmarkEntry } from '../storage/store';
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
import { circled, effectiveColor, paletteColor } from '../bookmarks/decor';
import { BookmarkQuery, highlightRanges, isEmptyQuery, matchesQuery, parseQuery, SearchFields } from '../bookmarks/filter';
import { compareByTitle, FileBookmarkSort, lineBookmarkTitle, symbolBookmarkTitle } from '../bookmarks/sort';

export type SectionId = 'bookmarks' | 'currentFile' | 'project';
export type FilterMode = 'all' | 'bookmarks';
export type BookmarkGrouping = 'file' | 'tag' | 'source';

export interface SectionNode {
  type: 'section';
  section: SectionId;
}
/** 清單最上面的搜尋列：顯示目前的搜尋字串，點一下開啟輸入框。 */
export interface SearchNode {
  type: 'search';
}
/** 函式書籤（原本的收藏）。 */
export interface FavoriteNode {
  type: 'favorite';
  fav: ResolvedFavorite;
  parent: SectionNode | BmGroupNode;
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
export interface BmGroupNode {
  type: 'bmGroup';
  /** 依檔案分組時為檔案 uri；依標籤分組時為標籤（沒有標籤為空字串）；依來源分組時為來源（自己的為空字串）。 */
  key: string;
  by: BookmarkGrouping;
  uri?: vscode.Uri;
  rel?: string;
  items: BookmarkItem[];
  parent: SectionNode;
}
export interface BookmarkNode {
  type: 'bookmark';
  entry: BookmarkEntry;
  parent: SectionNode | BmGroupNode;
}
export type TreeNode =
  | SearchNode
  | SectionNode
  | FavoriteNode
  | BmGroupNode
  | BookmarkNode
  | SymbolNode
  | WsFolderNode
  | DirNode
  | FileNode;

export const ICONS: Record<SymbolKindName, string> = {
  function: 'symbol-function',
  method: 'symbol-method',
  class: 'symbol-class',
  block: 'symbol-namespace',
  partial: 'symbol-snippet',
  macro: 'symbol-method',
  event: 'symbol-event',
  request: 'cloud',
  heading: 'symbol-key',
  reference: 'go-to-file',
};

const REFERENCE_KEYWORD: Record<string, string> = {
  'dj-extends': 'extends',
  'dj-include': 'include',
};

/** 有備註的函式，名稱前的圖示改用這個顏色（不另外加圖示，避免擠）。 */
export const NOTE_COLOR = 'charts.blue';
/** 別人的書籤（匯入的）的顏色。 */
export const FOREIGN_COLOR = 'charts.purple';

const EXPANSION_KEY = 'treeExpansion';
const MAX_EXPANSION = 3000;
const FILE_SORT_KEY = 'bookmarkFileSort';
const MAX_FILE_SORT = 2000;

export const COMMANDS = {
  revealLine: 'functionBookmarks.revealLine',
  reveal: 'functionBookmarks.revealSymbol',
  openFavorite: 'functionBookmarks.openFavorite',
  openTemplate: 'functionBookmarks.openTemplate',
};

export function displayName(name: string, alias: string | undefined): string {
  return alias ?? name;
}

export class FunctionTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | TreeNode[] | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  readonly searchNode: SearchNode = { type: 'search' };
  readonly sections: Record<SectionId, SectionNode> = {
    bookmarks: { type: 'section', section: 'bookmarks' },
    currentFile: { type: 'section', section: 'currentFile' },
    project: { type: 'section', section: 'project' },
  };

  private current?: FileSymbols;
  private currentNodes: SymbolNode[] = [];
  private fileLabel?: string;
  filterMode: FilterMode = 'all';
  bookmarkGrouping: BookmarkGrouping = 'file';
  /** 隱藏「不在此分支」的書籤。 */
  hideNotOnBranch = false;
  /** 搜尋列的字串；有內容時「書籤」區只列出符合的。 */
  private queryText = '';
  private parsedQuery: BookmarkQuery = parseQuery('');
  private disposables: vscode.Disposable[] = [];
  /** 使用者展開／收合過的節點（以節點 id 記錄），切換檔案、重開編輯器後沿用。 */
  private expansion: Record<string, boolean>;
  /** 各檔案在「依檔案分組」底下的書籤排序方式（鍵為檔案 uriKey；只記錄非預設的 'title'）。 */
  private fileSort: Record<string, FileBookmarkSort>;
  private saveTimer: NodeJS.Timeout | undefined;
  /** 「整個專案」中各檔案最上層的函式數量；0 表示沒有函式，不顯示展開鈕。 */
  private fileCounts = new Map<string, number>();
  private projectEmpty = false;

  constructor(
    private readonly service: SymbolService,
    private readonly store: MarkStore,
    private readonly favorites: FavoritesModel,
    private readonly project: ProjectFiles,
    private readonly resolver: TemplateResolver,
    private readonly memento?: vscode.Memento,
  ) {
    this.expansion = { ...(memento?.get<Record<string, boolean>>(EXPANSION_KEY) ?? {}) };
    this.fileSort = {};
    const savedSort = memento?.get<Record<string, FileBookmarkSort>>(FILE_SORT_KEY);
    if (savedSort) {
      for (const [k, v] of Object.entries(savedSort)) {
        if (v === 'title') {
          this.fileSort[k] = 'title';
        }
      }
    }
    this.disposables.push(
      project.onDidChange(() => this.fileCounts.clear()),
      vscode.workspace.onDidSaveTextDocument((d) => this.fileCounts.delete(uriKey(d.uri))),
      favorites.onDidChange(() => this.fire()),
      store.onDidChange(() => this.fire()),
      project.onDidChange(() => this.fire()),
    );
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      void this.memento?.update(EXPANSION_KEY, this.expansion);
    }
    [...this.disposables, this.changed].forEach((d) => d.dispose());
  }

  /** 記錄使用者展開或收合了某個節點。 */
  setExpanded(node: TreeNode, expanded: boolean): void {
    const id = this.buildItem(node).id;
    if (!id) {
      return;
    }
    delete this.expansion[id];
    this.expansion[id] = expanded;
    const keys = Object.keys(this.expansion);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_EXPANSION))) {
      delete this.expansion[k];
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.memento?.update(EXPANSION_KEY, this.expansion);
    }, 500);
  }

  isExpanded(node: TreeNode): boolean | undefined {
    const id = this.buildItem(node).id;
    return id ? this.expansion[id] : undefined;
  }

  /** 取得某個檔案在「依檔案分組」底下的排序方式（預設依行號）。 */
  fileSortOf(target: vscode.Uri | string): FileBookmarkSort {
    const key = typeof target === 'string' ? target : uriKey(target);
    return this.fileSort[key] ?? 'line';
  }

  /** 設定某個檔案在「依檔案分組」底下的排序方式，立即寫入 workspaceState 並重畫。 */
  async setFileSort(target: vscode.Uri | string, sort: FileBookmarkSort): Promise<void> {
    const key = typeof target === 'string' ? target : uriKey(target);
    if (this.fileSortOf(key) === sort) {
      return;
    }
    delete this.fileSort[key];
    if (sort === 'title') {
      this.fileSort[key] = 'title';
      const keys = Object.keys(this.fileSort);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FILE_SORT))) {
        delete this.fileSort[k];
      }
    }
    await this.memento?.update(FILE_SORT_KEY, { ...this.fileSort });
    this.fire();
  }

  fire(): void {
    this.changed.fire(undefined);
  }

  get query(): string {
    return this.queryText;
  }

  /** 搜尋中（搜尋字串不是空的）。 */
  get searching(): boolean {
    return !isEmptyQuery(this.parsedQuery);
  }

  /** 設定搜尋列的字串並重畫；回傳是否有變。 */
  setQuery(query: string): boolean {
    if (query === this.queryText) {
      return false;
    }
    this.queryText = query;
    this.parsedQuery = parseQuery(query);
    this.fire();
    return true;
  }

  /** 搜尋結果的第一個書籤（依側邊欄的順序），Enter 跳過去、↓ 移到這裡。 */
  firstMatch(): BookmarkNode | FavoriteNode | undefined {
    const group = this.bookmarkChildren(this.sections.bookmarks)[0];
    return group ? this.groupChildren(group)[0] : undefined;
  }

  get currentFile(): FileSymbols | undefined {
    return this.current;
  }

  get currentSymbolNodes(): SymbolNode[] {
    return this.currentNodes;
  }

  /** 每次 refresh 遞增；等偵測結果期間又切換了檔案時，舊的那次放棄（快速切換分頁時慢的舊結果不會蓋掉新畫面）。 */
  private refreshSeq = 0;
  private latestRefresh: Promise<boolean> = Promise.resolve(false);

  /** 重新讀取目前編輯器的函式。回傳 true 表示有內容；被較新的一次取代時回傳那一次的結果。 */
  refresh(editor: vscode.TextEditor | undefined): Promise<boolean> {
    const p = this.doRefresh(editor, ++this.refreshSeq);
    this.latestRefresh = p;
    return p;
  }

  private async doRefresh(editor: vscode.TextEditor | undefined, seq: number): Promise<boolean> {
    if (!editor && this.current && openDocumentFor(this.current.uri)) {
      // 焦點暫時移到終端機、設定頁等非文字編輯器：檔案還開著就維持顯示，不清空也不重建
      const doc = openDocumentFor(this.current.uri)!;
      if (`v${doc.version}` === this.current.version) {
        return this.currentNodes.length > 0;
      }
      editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
      if (!editor) {
        return this.currentNodes.length > 0;
      }
    }
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
    if (seq === this.refreshSeq && file.symbols.some((s) => s.ruleId === 'dj-extends')) {
      overrides = await this.resolver.overrides(doc.uri, file.symbols).catch(() => new Map<string, OverrideInfo>());
    }
    if (seq !== this.refreshSeq) {
      return this.latestRefresh;
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
      if (this.filterMode === 'bookmarks') {
        return [this.searchNode, this.sections.bookmarks];
      }
      return [this.searchNode, this.sections.bookmarks, this.sections.currentFile, this.sections.project];
    }
    switch (element.type) {
      case 'section':
        return this.sectionChildren(element);
      case 'bmGroup':
        return this.groupChildren(element);
      case 'symbol':
        return element.children;
      case 'wsFolder': {
        const files = await this.project.list(element.folder);
        return this.withCounts(this.dirChildren(element.folder, files.tree, element));
      }
      case 'dir':
        return this.withCounts(this.dirChildren(element.folder, element.dir, element));
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
    if (section.section === 'bookmarks') {
      return this.bookmarkChildren(section);
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const lists = await Promise.all(folders.map((f) => this.project.list(f)));
    const empty = lists.every((l) => l.rels.length === 0);
    if (empty !== this.projectEmpty) {
      this.projectEmpty = empty;
      setTimeout(() => this.fire(), 0);
    }
    if (folders.length === 1) {
      return this.withCounts(this.dirChildren(folders[0], lists[0].tree, section));
    }
    return folders.map((folder) => ({ type: 'wsFolder', folder, parent: section }) as WsFolderNode);
  }

  /**
   * 檔案節點立刻回傳（檔案多或在遠端時不必等全部讀完）；背景偵測函式數量（有快取），
   * 沒有函式的檔案再局部更新成不顯示展開鈕。
   */
  private withCounts(nodes: TreeNode[]): TreeNode[] {
    const files = nodes.filter((n): n is FileNode => n.type === 'file' && !this.fileCounts.has(uriKey(n.uri)));
    if (files.length) {
      const job = this.countFiles(files);
      this.counting.add(job);
      void job.finally(() => this.counting.delete(job));
    }
    return nodes;
  }

  private counting = new Set<Promise<void>>();

  /** 給測試用：等背景的函式計數做完。 */
  async whenCounted(): Promise<void> {
    while (this.counting.size) {
      await Promise.all([...this.counting]);
    }
  }

  private async countFiles(files: FileNode[]): Promise<void> {
    for (let i = 0; i < files.length; i += 16) {
      const empty: FileNode[] = [];
      await Promise.all(
        files.slice(i, i + 16).map(async (f) => {
          const r = await this.service.getForUri(f.uri).catch(() => undefined);
          const n = r?.symbols.length ?? 0;
          this.fileCounts.set(uriKey(f.uri), n);
          if (n === 0) {
            empty.push(f);
          }
        }),
      );
      if (empty.length) {
        this.changed.fire(empty);
      }
    }
  }

  private dirChildren(folder: vscode.WorkspaceFolder, dir: DirTree, parent: TreeNode): TreeNode[] {
    return [
      ...dir.dirs.map((d) => ({ type: 'dir', folder, dir: d, parent }) as DirNode),
      ...dir.files.map((rel) => ({ type: 'file', folder, rel, uri: this.store.uriOf(folder, rel), parent }) as FileNode),
    ];
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return element.type === 'section' || element.type === 'search' ? undefined : element.parent;
  }

  /** 側邊欄列出的書籤（套用來源篩選與「隱藏不在此分支」）；標題的數字也用這份。 */
  private shownItems(): BookmarkItem[] {
    return shownBookmarkItems(this.store, this.favorites, { includeNotOnBranch: !this.hideNotOnBranch });
  }

  /** 側邊欄列出的書籤再套用搜尋列的篩選。 */
  private matchedItems(): BookmarkItem[] {
    const items = this.shownItems();
    return this.searching ? items.filter((i) => matchesQuery(this.parsedQuery, searchFields(i))) : items;
  }

  private groupChildren(group: BmGroupNode): (BookmarkNode | FavoriteNode)[] {
    const items =
      group.by === 'file'
        ? [...group.items].sort(this.fileSortOf(group.key) === 'title' ? compareBookmarkItemsByTitle : compareItems)
        : group.items;
    return items.map((i) =>
      i.kind === 'line'
        ? ({ type: 'bookmark', entry: i.entry, parent: group } as BookmarkNode)
        : ({ type: 'favorite', fav: i.fav, parent: group } as FavoriteNode),
    );
  }

  /** 名稱標亮搜尋字（只標一般文字；#標籤、@來源 另外在分組名稱上標）。 */
  private highlighted(label: string, extraTerms: string[] = []): string | vscode.TreeItemLabel {
    if (!this.searching) {
      return label;
    }
    const highlights = highlightRanges(label, [...this.parsedQuery.text, ...extraTerms]);
    return highlights.length ? { label, highlights } : label;
  }

  /** 搜尋中，分組節點換一組 id：讓分組都展開（使用者先前收合的分組裡也可能有結果），清除搜尋後恢復原本的展開狀態。 */
  private groupId(id: string): string {
    return this.searching ? `${id}:search` : id;
  }

  /** 書籤（函式書籤＋行號書籤）依檔案（預設）或依標籤分組；同一組內依檔名、行號混排。沒有結果的分組不列出。 */
  private bookmarkChildren(section: SectionNode): BmGroupNode[] {
    const all = this.matchedItems().sort(compareItems);
    const groups = new Map<string, BmGroupNode>();
    const add = (key: string, e: BookmarkItem, extra: Partial<BmGroupNode>) => {
      let g = groups.get(key);
      if (!g) {
        g = { type: 'bmGroup', key, by: this.bookmarkGrouping, items: [], parent: section, ...extra };
        groups.set(key, g);
      }
      g.items.push(e);
    };
    for (const e of all) {
      if (this.bookmarkGrouping === 'source') {
        add(itemSource(e), e, {});
      } else if (this.bookmarkGrouping === 'tag') {
        const tags = itemTags(e);
        // 搜尋 #標籤 時只列出那些標籤的分組（書籤的其他標籤不另外列）
        const wanted = this.parsedQuery.tags;
        const shown = wanted.length ? tags.filter((t) => wanted.some((w) => t.toLowerCase().includes(w))) : tags;
        for (const tag of shown.length ? shown : ['']) {
          add(tag, e, {});
        }
      } else {
        add(uriKey(e.uri), e, { uri: e.uri, rel: e.file });
      }
    }
    const list = [...groups.values()];
    if (this.bookmarkGrouping === 'source') {
      // 自己的排第一，其他依名稱
      return list.sort((a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : a.key.localeCompare(b.key)));
    }
    if (this.bookmarkGrouping === 'tag') {
      return list.sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.key.localeCompare(b.key)));
    }
    for (const g of list) {
      if (this.fileSortOf(g.key) === 'title') {
        g.items.sort(compareBookmarkItemsByTitle);
      }
    }
    return list.sort((a, b) => (a.rel ?? '').localeCompare(b.rel ?? ''));
  }

  private favLabel(fav: ResolvedFavorite): string {
    return symbolBookmarkTitle(fav.mark);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    const item = this.buildItem(element);
    const saved = item.id ? this.expansion[item.id] : undefined;
    if (saved !== undefined && item.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
      item.collapsibleState = saved ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    }
    return item;
  }

  private buildItem(element: TreeNode): vscode.TreeItem {
    switch (element.type) {
      case 'search':
        return this.searchItem();
      case 'section':
        return this.sectionItem(element);
      case 'favorite':
        return this.favoriteItem(element);
      case 'bmGroup':
        return this.bmGroupItem(element);
      case 'bookmark':
        return this.bookmarkItem(element);
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
        const empty = this.fileCounts.get(uriKey(element.uri)) === 0;
        const item = new vscode.TreeItem(
          basenamePosix(element.rel),
          empty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `file:${uriKey(element.uri)}`;
        item.resourceUri = element.uri;
        item.iconPath = vscode.ThemeIcon.File;
        item.tooltip = element.rel;
        item.contextValue = 'fbFile';
        if (empty) {
          item.description = vscode.l10n.t('no functions');
          item.command = { command: 'vscode.open', title: vscode.l10n.t('Open file'), arguments: [element.uri] };
        }
        return item;
      }
    }
  }

  private bmGroupItem(element: BmGroupNode): vscode.TreeItem {
    if (element.by === 'source') {
      const item = new vscode.TreeItem(
        this.highlighted(element.key || vscode.l10n.t('Mine'), element.key ? this.parsedQuery.authors : []),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = this.groupId(`bmSource:${element.key}`);
      item.iconPath = new vscode.ThemeIcon(element.key ? 'person' : 'account', element.key ? new vscode.ThemeColor(FOREIGN_COLOR) : undefined);
      item.description = String(element.items.length);
      item.contextValue = element.key ? 'fbBmSource:foreign' : 'fbBmSource';
      return item;
    }
    if (element.by === 'tag') {
      const item = new vscode.TreeItem(
        element.key ? this.highlighted(`#${element.key}`, this.parsedQuery.tags) : vscode.l10n.t('No tag'),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = this.groupId(`bmTag:${element.key}`);
      const tc = paletteColor(this.store.tagColors().get(element.key));
      item.iconPath = new vscode.ThemeIcon('tag', tc ? new vscode.ThemeColor(tc.theme) : undefined);
      item.contextValue = element.key ? 'fbBmTag' : undefined;
      item.description = String(element.items.length);
      return item;
    }
    const rel = element.rel ?? '';
    const byTitle = this.fileSortOf(element.key) === 'title';
    const item = new vscode.TreeItem(this.highlighted(basenamePosix(rel)), vscode.TreeItemCollapsibleState.Expanded);
    item.id = this.groupId(`bmFile:${element.key}`);
    item.resourceUri = element.uri;
    item.iconPath = vscode.ThemeIcon.File;
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    item.description = [dir, byTitle ? vscode.l10n.t('by title') : ''].filter(Boolean).join(' · ');
    item.tooltip = rel;
    item.contextValue = byTitle ? 'fbBmFile:byTitle' : 'fbBmFile';
    return item;
  }

  private bookmarkItem(element: BookmarkNode): vscode.TreeItem {
    const b = element.entry.bookmark;
    const item = new vscode.TreeItem(
      this.highlighted(b.number ? `${circled(b.number)} ${bookmarkTitle(b)}` : bookmarkTitle(b)),
      vscode.TreeItemCollapsibleState.None,
    );
    const color = paletteColor(effectiveColor(b, this.store.tagColors()));
    item.id = `bm:${element.parent.type === 'bmGroup' ? element.parent.key : ''}:${b.id}`;
    const lost = b.status === 'lost';
    const away = b.status === 'notOnBranch';
    item.iconPath = lost
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('disabledForeground'))
      : away
        ? new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('disabledForeground'))
        : new vscode.ThemeIcon(
            b.source && b.symbol ? 'symbol-method' : 'bookmark',
            color ? new vscode.ThemeColor(color.theme) : b.note ? new vscode.ThemeColor(NOTE_COLOR) : undefined,
          );
    const parts: string[] = [];
    if (lost) {
      parts.push(vscode.l10n.t('needs checking'));
    }
    if (away) {
      parts.push(vscode.l10n.t('not on this branch'));
    }
    if (b.scope === 'branch' && b.homeBranch) {
      parts.push(vscode.l10n.t('only on {0}', b.homeBranch));
    }
    if (b.source && !(element.parent.type === 'bmGroup' && element.parent.by === 'source')) {
      parts.push(`@${b.source.author}`);
    }
    // 不是依檔案分組（依標籤、依來源）時看不出是哪個檔案，補上檔名
    parts.push(notByFile(element) ? `${basenamePosix(b.file)}:${b.line + 1}` : String(b.line + 1));
    if (b.tags?.length && !(element.parent.type === 'bmGroup' && element.parent.by === 'tag')) {
      parts.push(b.tags.map((t) => `#${t}`).join(' '));
    }
    item.description = parts.join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMd(bookmarkTitle(b))}**\n\n`);
    md.appendMarkdown(`${escapeMd(b.file)}:${b.line + 1}`);
    if (b.label && b.anchor?.text) {
      md.appendMarkdown('\n\n');
      md.appendCodeblock(b.anchor.text);
    }
    if (b.tags?.length) {
      md.appendMarkdown(`\n\n${b.tags.map((t) => `#${escapeMd(t)}`).join(' ')}`);
    }
    if (away) {
      md.appendMarkdown(`\n\n${vscode.l10n.t('This code is not on the current branch. The bookmark comes back when you switch to a branch that has it.')}`);
    }
    if (b.source) {
      const when = b.source.importedAt ? ` · ${vscode.l10n.t('imported {0}', b.source.importedAt.slice(0, 10))}` : '';
      md.appendMarkdown(`\n\n${vscode.l10n.t('From {0}', escapeMd(b.source.author))}${when}`);
    }
    if (b.scope === 'branch' && b.homeBranch) {
      md.appendMarkdown(`\n\n${vscode.l10n.t('Shown only on branch {0}.', escapeMd(b.homeBranch))}`);
    }
    if (lost) {
      md.appendMarkdown(`\n\n${vscode.l10n.t('The bookmarked line could not be found (deleted, changed a lot, or inside a merge conflict). Put the cursor on the correct line and use Move Bookmark to Cursor.')}`);
    }
    if (b.note) {
      md.appendMarkdown('\n\n---\n\n');
      md.appendMarkdown(b.note);
      md.appendMarkdown(`\n\n${bookmarkPreviewLink(element.entry.uri, b.id)}`);
      trustPreviewLink(md);
    }
    item.tooltip = md;
    item.contextValue = `fbBookmark${b.note ? ':note' : ''}${lost ? ':lost' : ''}${away ? ':away' : ''}${b.scope === 'branch' ? ':branchOnly' : ''}${b.source ? ':foreign' : ''}`;
    item.command = {
      command: COMMANDS.revealLine,
      title: vscode.l10n.t('Go to bookmark'),
      arguments: [element.entry.uri, b.line],
    };
    return item;
  }

  private searchItem(): vscode.TreeItem {
    // 沒有搜尋時名稱留空、用淡色的 description 當提示文字（像輸入框的 placeholder）
    const item = new vscode.TreeItem(this.queryText, vscode.TreeItemCollapsibleState.None);
    item.id = 'search';
    item.iconPath = new vscode.ThemeIcon('search');
    if (!this.queryText) {
      item.description = vscode.l10n.t('Search bookmarks…');
    }
    item.tooltip = vscode.l10n.t('Search bookmarks by name, tag, file, function, code or note. #tag searches tags only, @source shows one person\'s bookmarks.');
    item.contextValue = this.queryText ? 'fbSearch:active' : 'fbSearch';
    item.command = { command: 'functionBookmarks.focusSearch', title: vscode.l10n.t('Search bookmarks…') };
    return item;
  }

  private sectionItem(element: SectionNode): vscode.TreeItem {
    if (element.section === 'bookmarks') {
      const count = this.shownItems().length;
      const item = new vscode.TreeItem(vscode.l10n.t('Bookmarks'), vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'section:bookmarks';
      item.iconPath = new vscode.ThemeIcon(this.searching ? 'search' : 'bookmark');
      item.description = this.searching
        ? vscode.l10n.t('{0} of {1} match', distinctCount(this.matchedItems()), count)
        : count
          ? String(count)
          : vscode.l10n.t('Ctrl+Alt+B, or ☆ on a function');
      item.contextValue = 'fbSection.bookmarks';
      return item;
    }
    if (element.section === 'project') {
      const none = this.projectEmpty || (vscode.workspace.workspaceFolders ?? []).length === 0;
      const item = new vscode.TreeItem(
        vscode.l10n.t('Whole project'),
        none ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
      );
      if (none) {
        item.description = vscode.l10n.t('No matching files');
      }
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

  private tooltip(
    name: string,
    alias: string | undefined,
    symPath: string,
    rel: string,
    line: number | undefined,
    extra: string[],
    note?: string,
    previewTarget?: { uri: vscode.Uri; kind: SymbolKindName },
  ): vscode.MarkdownString {
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
    if (note) {
      md.appendMarkdown('\n\n---\n\n');
      md.appendMarkdown(note);
      if (previewTarget) {
        md.appendMarkdown(`\n\n${previewNoteLink(previewTarget.uri, { path: symPath, kind: previewTarget.kind })}`);
        trustPreviewLink(md);
      }
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
    item.iconPath = new vscode.ThemeIcon(ICONS[s.kind] ?? 'symbol-misc', mark?.note ? new vscode.ThemeColor(NOTE_COLOR) : undefined);
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
    item.tooltip = this.tooltip(s.name, mark?.alias, s.path, vscode.workspace.asRelativePath(element.uri, false), s.nameLine, extra, mark?.note, {
      uri: element.uri,
      kind: s.kind,
    });
    item.contextValue = `fbSymbol:${mark?.favorite ? 'fav' : 'nofav'}${mark?.alias ? ':alias' : ''}${mark?.note ? ':note' : ''}${isRef ? ':ref' : ''}${
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
    const item = new vscode.TreeItem(
      this.highlighted(fav.mark.number ? `${circled(fav.mark.number)} ${this.favLabel(fav)}` : this.favLabel(fav)),
      vscode.TreeItemCollapsibleState.None,
    );
    const color = paletteColor(effectiveColor(fav.mark, this.store.tagColors()));
    const byTag = element.parent.type === 'bmGroup' && element.parent.by === 'tag';
    item.id = `fav:${element.parent.type === 'bmGroup' ? element.parent.key : ''}:${fav.uri.toString()}::${fav.mark.kind}:${fav.mark.path}`;
    const line = fav.symbol?.nameLine ?? fav.mark.line;
    const parts: string[] = [];
    if (fav.mark.alias) {
      parts.push('✎');
    }
    if (fav.status === 'ok') {
      if (line !== undefined) {
        parts.push(notByFile(element) ? `${basenamePosix(fav.mark.file)}:${line + 1}` : String(line + 1));
      } else if (notByFile(element)) {
        parts.push(basenamePosix(fav.mark.file));
      }
      item.iconPath = new vscode.ThemeIcon(
        ICONS[fav.mark.kind] ?? 'symbol-misc',
        color ? new vscode.ThemeColor(color.theme) : fav.mark.note ? new vscode.ThemeColor(NOTE_COLOR) : undefined,
      );
    } else {
      parts.push(fav.status === 'missing' ? vscode.l10n.t('function not found') : vscode.l10n.t('file not found'));
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('disabledForeground'));
    }
    if (fav.mark.tags?.length && !byTag) {
      parts.push(`· ${fav.mark.tags.map((t) => `#${t}`).join(' ')}`);
    }
    item.description = parts.join(' ');
    const extra: string[] = [];
    if (fav.mark.tags?.length) {
      extra.push(fav.mark.tags.map((t) => `#${escapeMd(t)}`).join(' '));
    }
    if (fav.status !== 'ok') {
      extra.push(
        fav.status === 'missing'
          ? vscode.l10n.t('This function was not found in the file. It may have been renamed or deleted.')
          : vscode.l10n.t('The file does not exist.'),
      );
    }
    item.tooltip = this.tooltip(name, fav.mark.alias, fav.mark.path, fav.mark.file, line, extra, fav.mark.note, {
      uri: fav.uri,
      kind: fav.mark.kind,
    });
    // 與行號書籤共用右鍵選單（fbBookmark），:fn 表示函式書籤
    item.contextValue = `fbBookmark:fn${fav.mark.alias ? ':alias' : ''}${fav.mark.note ? ':note' : ''}:${fav.status}`;
    item.command = { command: COMMANDS.openFavorite, title: vscode.l10n.t('Go to symbol'), arguments: [fav] };
    return item;
  }
}

/** 同檔案內的書籤依側邊欄顯示名稱正序排序（函式書籤與行號書籤混排，不含圈號前綴）。 */
function compareBookmarkItemsByTitle(a: BookmarkItem, b: BookmarkItem): number {
  return compareByTitle(
    a.kind === 'line'
      ? { kind: 'line', title: lineBookmarkTitle(a.entry.bookmark), line: a.line }
      : { kind: 'symbol', title: symbolBookmarkTitle(a.fav.mark), line: a.line },
    b.kind === 'line'
      ? { kind: 'line', title: lineBookmarkTitle(b.entry.bookmark), line: b.line }
      : { kind: 'symbol', title: symbolBookmarkTitle(b.fav.mark), line: b.line },
  );
}

/** 搜尋列比對的欄位：名稱、標籤、檔名、所在函式、那一行的程式碼、備註、來源。 */
export function searchFields(i: BookmarkItem): SearchFields {
  if (i.kind === 'line') {
    const b = i.entry.bookmark;
    return {
      names: [bookmarkTitle(b)],
      tags: b.tags ?? [],
      author: b.source?.author ?? '',
      file: b.file,
      func: b.anchor?.symbolPath ?? b.symbol?.path,
      line: b.anchor?.text,
      note: b.note,
    };
  }
  const m = i.fav.mark;
  const name = m.path.split('.').pop() ?? m.path;
  return {
    names: m.alias ? [m.alias, name] : [name],
    tags: m.tags ?? [],
    author: '',
    file: m.file,
    func: m.path,
    note: m.note,
  };
}

/** 依標籤分組時同一個書籤會出現在多個分組：計數只算一次。 */
function distinctCount(items: BookmarkItem[]): number {
  return new Set(items.map((i) => (i.kind === 'line' ? `l:${i.entry.bookmark.id}` : `f:${i.fav.uri.toString()}::${i.fav.mark.kind}:${i.fav.mark.path}`))).size;
}

/** 書籤節點不在「依檔案分組」底下（依標籤、依來源）：描述要補上檔名。 */
function notByFile(element: BookmarkNode | FavoriteNode): boolean {
  return element.parent.type === 'bmGroup' && element.parent.by !== 'file';
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
