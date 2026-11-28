import * as path from 'path';
import * as vscode from 'vscode';
import { BookmarkItem, compareItems, itemSource, itemTags, shownBookmarkItems } from '../bookmarks/unified';
import { BookmarkQuery, isEmptyQuery, matchesQuery, parseQuery } from '../bookmarks/filter';
import { FileBookmarkSort } from '../bookmarks/sort';
import { findInnermost } from '../detection/engine';
import { DetectedSymbol, SymbolKindName } from '../detection/types';
import { OverrideInfo, TemplateResolver } from '../django/resolver';
import { MarkStore } from '../storage/store';
import { openDocumentFor } from '../symbols/documentSource';
import { FavoritesModel } from '../symbols/favorites';
import { ProjectFiles } from '../symbols/projectFiles';
import { DirTree } from '../symbols/projectTree';
import { FileSymbols, SymbolService } from '../symbols/symbolService';
import { basenamePosix } from '../util/paths';
import { toggleBookmarkKey } from '../util/shortcuts';
import { sameUri, uriKey } from '../util/uris';
import { bmGroupId, bookmarkNodeId, favoriteNodeId, TreeItemFactory } from './treeItems';
import {
  AUTO_COLLAPSE_BOOKMARKS,
  AUTO_COLLAPSE_GROUPS,
  BmGroupNode,
  BookmarkGrouping,
  BookmarkNode,
  DirNode,
  FavoriteNode,
  FileNode,
  FilterMode,
  SearchNode,
  SectionId,
  SectionNode,
  SymbolNode,
  TreeNode,
  WsFolderNode,
} from './treeNodes';
import { compareBookmarkItemsByCreated, compareBookmarkItemsByTitle, distinctCount, searchFields } from './treeSearch';

export * from './treeNodes';
export { searchFields } from './treeSearch';

const EXPANSION_KEY = 'treeExpansion';
const MAX_EXPANSION = 3000;
const FILE_SORT_KEY = 'bookmarkFileSort';
const MAX_FILE_SORT = 2000;

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
  /** 各檔案在「依檔案分組」底下的書籤排序方式（鍵為檔案 uriKey；只記錄非預設的 'title' 或 'created'）。 */
  private fileSort: Record<string, FileBookmarkSort>;
  private saveTimer: NodeJS.Timeout | undefined;
  /** 「整個專案」中各檔案最上層的函式數量；0 表示沒有函式，不顯示展開鈕。 */
  private fileCounts = new Map<string, number>();
  private projectEmpty = false;
  private projectEmptyKnown = false;
  private projectCheckSeq = 0;
  private projectCheckPromise: Promise<void> | undefined;
  /** 最近一次列出書籤分組時的總書籤數與分組數，用來判斷是否預設收合分組。 */
  private lastBookmarkTotalCount = 0;
  private lastBookmarkGroupCount = 0;
  /** 書籤、函式、分組與搜尋列的 TreeItem。 */
  private readonly items: TreeItemFactory;

  constructor(
    private readonly service: SymbolService,
    private readonly store: MarkStore,
    private readonly favorites: FavoritesModel,
    private readonly project: ProjectFiles,
    private readonly resolver: TemplateResolver,
    private readonly memento?: vscode.Memento,
    private readonly isIgnoredEditor?: (uri: vscode.Uri) => boolean,
  ) {
    this.items = new TreeItemFactory({
      store,
      searching: () => this.searching,
      query: () => this.parsedQuery,
      fileSortOf: (target) => this.fileSortOf(target),
      defaultGroupState: () => this.defaultGroupCollapsibleState(),
    });
    this.expansion = { ...(memento?.get<Record<string, boolean>>(EXPANSION_KEY) ?? {}) };
    this.fileSort = {};
    const savedSort = memento?.get<Record<string, FileBookmarkSort>>(FILE_SORT_KEY);
    if (savedSort) {
      for (const [k, v] of Object.entries(savedSort)) {
        if (v === 'title' || v === 'created') {
          this.fileSort[k] = v;
        }
      }
    }
    this.disposables.push(
      project.onDidChange(() => {
        this.fileCounts.clear();
        this.projectEmptyKnown = false;
        this.scheduleProjectEmptyCheck();
      }),
      vscode.workspace.onDidSaveTextDocument((d) => this.fileCounts.delete(uriKey(d.uri))),
      favorites.onDidChange(() => this.fire()),
      store.onDidChange(() => this.fire()),
      project.onDidChange(() => this.fire()),
    );
  }

  /** 背景輕量檢查專案是否沒有任何符合 include 的檔案，避免空專案的「整個專案」先顯示展開箭頭。 */
  scheduleProjectEmptyCheck(): Promise<void> {
    const seq = ++this.projectCheckSeq;
    const job = (async () => {
      const has = await this.project.hasAny().catch(() => true);
      if (seq !== this.projectCheckSeq) {
        return;
      }
      const empty = !has;
      this.projectEmptyKnown = true;
      if (empty !== this.projectEmpty) {
        this.projectEmpty = empty;
        this.changed.fire(this.sections.project);
      }
    })();
    this.projectCheckPromise = job;
    return job;
  }

  /** 給測試用：等背景的空專案檢查完成。 */
  async whenProjectChecked(): Promise<void> {
    await this.projectCheckPromise;
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      void this.memento?.update(EXPANSION_KEY, this.expansion);
    }
    [...this.disposables, this.changed].forEach((d) => d.dispose());
  }

  /** 取得樹節點的穩定識別碼（與 getTreeItem().id 一致）。 */
  nodeId(node: TreeNode): string | undefined {
    switch (node.type) {
      case 'search':
        return 'search';
      case 'section':
        return `section:${node.section}`;
      case 'bmGroup':
        return bmGroupId(node, this.searching);
      case 'bookmark':
        return bookmarkNodeId(node);
      case 'favorite':
        return favoriteNodeId(node);
      case 'symbol':
        return node.id;
      case 'wsFolder':
        return `ws:${node.folder.uri.toString()}`;
      case 'dir':
        return `dir:${node.folder.uri.toString()}:${node.dir.path}`;
      case 'file':
        return `file:${uriKey(node.uri)}`;
    }
  }

  /** 記錄使用者展開或收合了某個節點。 */
  setExpanded(node: TreeNode, expanded: boolean): void {
    const id = this.nodeId(node);
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
    const id = this.nodeId(node);
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
    if (sort === 'title' || sort === 'created') {
      this.fileSort[key] = sort;
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

  /** 回傳目前側邊欄搜尋列的書籤比對函式（與側邊欄清單完全共用）；沒有搜尋時回傳 undefined。 */
  searchMatcher(): ((item: BookmarkItem) => boolean) | undefined {
    if (!this.searching) {
      return undefined;
    }
    const q = this.parsedQuery;
    return (item) => matchesQuery(q, searchFields(item));
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

  /** 在「書籤」區目前顯示的節點中找出指定書籤（依側邊欄分組順序取第一個）。 */
  bookmarkNodeFor(
    uri: vscode.Uri,
    target: { kind: 'line'; id: string } | { kind: 'symbol'; path: string; kindName: SymbolKindName },
  ): BookmarkNode | FavoriteNode | undefined {
    for (const group of this.bookmarkChildren(this.sections.bookmarks)) {
      for (const node of this.groupChildren(group)) {
        if (target.kind === 'line') {
          if (node.type === 'bookmark' && node.entry.bookmark.id === target.id && sameUri(node.entry.uri, uri)) {
            return node;
          }
        } else if (
          node.type === 'favorite' &&
          sameUri(node.fav.uri, uri) &&
          node.fav.mark.path === target.path &&
          node.fav.mark.kind === target.kindName
        ) {
          return node;
        }
      }
    }
    return undefined;
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
    // 編輯備註分頁時不要把「目前檔案」換成暫存備註檔或清空成「沒有開啟的檔案」，沿用原本的程式碼檔案
    if (editor && this.isIgnoredEditor?.(editor.document.uri)) {
      editor = undefined;
    }
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
    this.projectEmptyKnown = true;
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
    const match = this.searchMatcher();
    return match ? items.filter(match) : items;
  }

  private fileComparator(key: string): (a: BookmarkItem, b: BookmarkItem) => number {
    const sort = this.fileSortOf(key);
    if (sort === 'title') {
      return compareBookmarkItemsByTitle;
    }
    if (sort === 'created') {
      return compareBookmarkItemsByCreated;
    }
    return compareItems;
  }

  private groupChildren(group: BmGroupNode): (BookmarkNode | FavoriteNode)[] {
    const items = group.by === 'file' ? [...group.items].sort(this.fileComparator(group.key)) : group.items;
    return items.map((i) =>
      i.kind === 'line'
        ? ({ type: 'bookmark', entry: i.entry, parent: group } as BookmarkNode)
        : ({ type: 'favorite', fav: i.fav, parent: group } as FavoriteNode),
    );
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
        add(uriKey(e.uri), e, { uri: e.uri, rel: e.file, folder: e.folder });
      }
    }
    const list = [...groups.values()];
    this.lastBookmarkTotalCount = all.length;
    this.lastBookmarkGroupCount = list.length;
    if (this.bookmarkGrouping === 'source') {
      // 自己的排第一，其他依名稱
      return list.sort((a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : a.key.localeCompare(b.key)));
    }
    if (this.bookmarkGrouping === 'tag') {
      return list.sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.key.localeCompare(b.key)));
    }
    for (const g of list) {
      if (this.fileSortOf(g.key) !== 'line') {
        g.items.sort(this.fileComparator(g.key));
      }
    }
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    return list.sort(
      (a, b) =>
        (multiRoot ? (a.folder?.name ?? '').localeCompare(b.folder?.name ?? '') : 0) ||
        (a.rel ?? '').localeCompare(b.rel ?? ''),
    );
  }

  /** 書籤數量或分組很多時（且非搜尋狀態），分組預設收合；使用者手動展開的分組仍由 expansion 記錄保留。 */
  private defaultGroupCollapsibleState(): vscode.TreeItemCollapsibleState {
    if (this.searching) {
      return vscode.TreeItemCollapsibleState.Expanded;
    }
    return this.lastBookmarkTotalCount > AUTO_COLLAPSE_BOOKMARKS || this.lastBookmarkGroupCount >= AUTO_COLLAPSE_GROUPS
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded;
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
        return this.items.searchItem(this.queryText);
      case 'section':
        return this.sectionItem(element);
      case 'favorite':
        return this.items.favoriteItem(element);
      case 'bmGroup':
        return this.items.bmGroupItem(element);
      case 'bookmark':
        return this.items.bookmarkItem(element);
      case 'symbol':
        return this.items.symbolItem(element);
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

  private sectionItem(element: SectionNode): vscode.TreeItem {
    if (element.section === 'bookmarks') {
      const count = this.shownItems().length;
      const item = new vscode.TreeItem(vscode.l10n.t('Bookmarks'), vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'section:bookmarks';
      item.iconPath = new vscode.ThemeIcon(this.searching ? 'search' : 'bookmark');
      if (this.searching) {
        item.description = vscode.l10n.t('{0} of {1} match', distinctCount(this.matchedItems()), count);
      } else if (count) {
        item.description = String(count);
      } else {
        const key = toggleBookmarkKey();
        item.description = vscode.l10n.t('{0} or ☆', key);
        item.tooltip = vscode.l10n.t('Press {0} in an editor, or click ☆ on a function to add a bookmark.', key);
      }
      item.contextValue = 'fbSection.bookmarks';
      return item;
    }
    if (element.section === 'project') {
      const hasFolders = (vscode.workspace.workspaceFolders ?? []).length > 0;
      if (hasFolders && !this.projectEmptyKnown) {
        void this.scheduleProjectEmptyCheck();
      }
      const none = this.projectEmpty || !hasFolders;
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

}
