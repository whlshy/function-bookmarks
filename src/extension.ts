import * as vscode from 'vscode';
import { BookmarkCommands, isBookmarkLinkArg, revealLine } from './bookmarks/commands';
import { BookmarkTracker } from './bookmarks/tracker';
import { BookmarkExtras } from './bookmarks/extras';
import { BookmarkStatusBar } from './views/statusBar';
import { RuleTester } from './views/ruleTester';
import { ExternalChangeWatcher } from './bookmarks/externalWatcher';
import { watchGitHead } from './bookmarks/gitHead';
import { BranchService } from './git/branchService';
import { cleanBranchRecords, setBranchScope } from './git/branchCommands';
import { exportBookmarks, ExportOptions } from './share/exporter';
import { importBookmarks, ImportOptions } from './share/importer';
import { deleteSource, filterSources, makeMine, renameSource } from './share/sources';
import { ReconcileWatcher } from './storage/reconcileWatcher';
import { Commands, reveal } from './commands';
import { readSettings, SECTION, WorkspaceStorageChoice } from './config';
import { TemplateResolver } from './django/resolver';
import { RuleError, SymbolKindName } from './detection/types';
import { MarkStore, BookmarkEntry } from './storage/store';
import { FavoritesModel } from './symbols/favorites';
import { ProjectFiles } from './symbols/projectFiles';
import { SymbolService } from './symbols/symbolService';
import { mermaidPlugin } from './markdown/mermaid';
import { BookmarkHoverProvider, HOVER_ACTION, HoverActionArg } from './views/hover';
import { findByPath, findInnermost } from './detection/engine';
import { FavoriteGutter } from './views/gutter';
import { FileEvents } from './util/fileEvents';
import { NoteEditor, PREVIEW_NOTE_COMMAND } from './views/noteEditor';
import { collectProjectSymbols, searchFunctions, searchMarks } from './views/search';
import { BmGroupNode, BookmarkGrouping, BookmarkNode, COMMANDS, FilterMode, FunctionTreeProvider, SymbolNode, TreeNode } from './views/tree';
import { sameUri, uriKey } from './util/uris';
import { BookmarkSearchBox } from './views/searchBox';
import { StartupLog, StartupTiming } from './util/startupLog';

const VIEW_ID = 'functionBookmarks.tree';
const STATE_FILTER = 'filterMode';
const STATE_BM_GROUP = 'bookmarkGrouping';
const STATE_HIDE_AWAY = 'hideNotOnBranch';
const STATE_HIDDEN_SOURCES = 'hiddenSources';

/** 行號右鍵選單傳入的參數：{ lineNumber（1 起算）, uri }。 */
function lineArg(arg: unknown): { uri: vscode.Uri; line: number } | undefined {
  const a = arg as { lineNumber?: unknown; uri?: unknown } | undefined;
  return a && typeof a.lineNumber === 'number' && a.uri instanceof vscode.Uri ? { uri: a.uri, line: a.lineNumber - 1 } : undefined;
}

function isBookmarkNode(n: unknown): n is BookmarkNode {
  return (n as BookmarkNode | undefined)?.type === 'bookmark';
}

export interface ExtensionApi {
  /** 給整合測試使用。 */
  provider: FunctionTreeProvider;
  store: MarkStore;
  favorites: FavoritesModel;
  commands: Commands;
  bookmarks: BookmarkCommands;
  tracker: BookmarkTracker;
  external: ExternalChangeWatcher;
  branches: BranchService;
  reconciler: ReconcileWatcher;
  gutter: FavoriteGutter;
  extras: BookmarkExtras;
  statusBar: BookmarkStatusBar;
  ruleTester: RuleTester;
  notes: NoteEditor;
  searchBox: BookmarkSearchBox;
  refreshNow(): Promise<void>;
  /** 立即執行一次游標跟隨，回傳被標示的節點。 */
  followCursor(): SymbolNode | undefined;
  /** 立即重算游標所在位置是否有書籤（供編輯器右鍵選單 when 條件與整合測試用）。 */
  updateCursorBookmarkContext(): Promise<boolean>;
  treeView: vscode.TreeView<TreeNode>;
  collectProjectSymbols(): ReturnType<typeof collectProjectSymbols>;
  /** 內建 Markdown 預覽會呼叫：加上 Mermaid 繪圖。 */
  extendMarkdownIt(md: unknown): unknown;
  /** 啟動各階段計時紀錄（毫秒）。 */
  startupTimings: StartupTiming[];
  /** 用同一個 workspaceState 重新建立樹狀檢視提供者（給整合測試模擬重開用，呼叫端負責 dispose）。 */
  recreateProvider(): FunctionTreeProvider;
  /** 用同一個 ExtensionContext 重新建立 MarkStore（給整合測試模擬重開用，呼叫端負責 dispose）。 */
  recreateStore(): MarkStore;
}

/** 停用時等待尚未寫完的書籤與外部監看快照寫入完成。 */
let activeDeactivate: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const startup = new StartupLog();
  context.subscriptions.push(startup);
  const service = new SymbolService();
  const store = new MarkStore(context);
  const branches = new BranchService();
  store.branchOf = (folder) => branches.name(folder);
  // 平行讀取書籤檔與 git 分支，互不等待
  await Promise.all([
    startup.measure('store.init', () => store.init()),
    startup.measure('branches.refresh', () => branches.refresh()),
  ]);
  const setupStart = performance.now();
  const files = new FileEvents();
  const favorites = new FavoritesModel(store, service, files);
  const project = new ProjectFiles(files);
  const resolver = new TemplateResolver(service);
  const notes = new NoteEditor(context.globalStorageUri);
  const provider = new FunctionTreeProvider(service, store, favorites, project, resolver, context.workspaceState, (uri) =>
    notes.isNoteDocument(uri),
  );
  const commands = new Commands(service, store, resolver, notes);
  const bookmarks = new BookmarkCommands(store, service, notes, favorites);
  const tracker = new BookmarkTracker(store, service);
  const external = new ExternalChangeWatcher(store, service, context.workspaceState, branches, files);
  tracker.handledByDiff = (e, changes) => external.handlesByDiff(e, changes);
  tracker.beforeRefreshAnchors = (doc) => external.flushEditorChanges(doc);
  const reconciler = new ReconcileWatcher(store, service);
  const gutter = new FavoriteGutter(context.extensionUri, service, store);
  const hover = new BookmarkHoverProvider(service, store);
  const extras = new BookmarkExtras(
    store,
    service,
    favorites,
    bookmarks,
    (fav) => commands.openFavorite(fav),
    () => gutter.update(),
  );
  const statusBar = new BookmarkStatusBar(store, favorites, gutter);
  const ruleTester = new RuleTester(service);
  const setIconsHidden = async (hide: boolean) => {
    gutter.hidden = hide;
    await vscode.commands.executeCommand('setContext', 'functionBookmarks.iconsHidden', hide);
    statusBar.update();
  };
  /** 快捷鍵傳入 { number: 1 }，也可直接傳數字。 */
  /** 行號右鍵選單傳入 { lineNumber, uri }；編輯器右鍵傳入檔案 Uri（改用游標所在的行）。 */
  const extrasArg = (arg: unknown) => {
    const at = lineArg(arg);
    return at ? { type: 'line', ...at } : arg instanceof vscode.Uri ? undefined : arg;
  };
  const numberArg = (arg: unknown): number | undefined =>
    typeof arg === 'number' ? arg : typeof (arg as { number?: unknown } | undefined)?.number === 'number' ? (arg as { number: number }).number : undefined;
  const treeView = vscode.window.createTreeView<TreeNode>(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const reportedErrors = new Set<string>();

  // 書籤搜尋：清單第一列顯示搜尋字串，輸入框開在畫面上方，打字即時篩選「書籤」區
  const openMatch = async (node: TreeNode | undefined) => {
    if (node?.type === 'bookmark') {
      await revealLine(node.entry.uri, node.entry.bookmark.line);
    } else if (node?.type === 'favorite') {
      await commands.openFavorite(node.fav);
    }
  };
  const setSearchContext = () => void vscode.commands.executeCommand('setContext', 'functionBookmarks.searching', provider.searching);
  const searchBox = new BookmarkSearchBox(context.workspaceState, {
    onQuery: (q) => {
      const was = provider.searching;
      if (!provider.setQuery(q)) {
        return;
      }
      setSearchContext();
      // 開始搜尋時展開「書籤」區（使用者先前收合了也看得到結果）
      if (!was && provider.searching) {
        void treeView.reveal(provider.sections.bookmarks, { expand: true, select: false, focus: false }).then(undefined, () => undefined);
      }
    },
    onEnter: () => openMatch(provider.firstMatch()),
    onDown: async () => {
      const node = provider.firstMatch();
      if (node) {
        await treeView.reveal(node, { select: true, focus: true }).then(undefined, () => undefined);
      } else {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      }
    },
  });
  provider.setQuery(searchBox.query);
  setSearchContext();

  // 側邊欄標題旁顯示目前分支（多個資料夾在不同分支時不顯示）
  // 單一檢視合併到容器標題列時 VS Code 只會顯示 title（不顯示 description），所以同時設 title 讓分支名在預設寬度看得到
  const defaultViewTitle = treeView.title;
  const updateBranchLabel = () => {
    const ids = new Set<string>();
    let label: string | undefined;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const b = branches.current(folder);
      if (b) {
        ids.add(b.id);
        label = b.name ?? vscode.l10n.t('detached {0}', b.id.slice(1, 8));
      }
    }
    const parts = [ids.size === 1 ? label : undefined, store.hiddenSourceList.length ? vscode.l10n.t('filtered') : undefined];
    const status = parts.filter(Boolean).join(' · ') || undefined;
    treeView.description = status;
    treeView.title = status ?? defaultViewTitle;
  };
  updateBranchLabel();

  // 來源篩選：記住被隱藏的來源；有匯入的書籤時才顯示篩選按鈕
  store.setHiddenSources(context.workspaceState.get<string[]>(STATE_HIDDEN_SOURCES, []));
  store.onSourceFilterChanged = (hidden) => void context.workspaceState.update(STATE_HIDDEN_SOURCES, hidden);
  const updateSourceContext = () => {
    void vscode.commands.executeCommand('setContext', 'functionBookmarks.hasSources', store.sources().length > 0);
    void vscode.commands.executeCommand('setContext', 'functionBookmarks.sourceFiltered', store.hiddenSourceList.length > 0);
    updateBranchLabel();
  };
  updateSourceContext();
  const shareDeps = { store, favorites, branches, service };
  const entryArg = (node?: TreeNode) => bookmarks.entryOf(isBookmarkNode(node) ? node : undefined);
  const sourceArg = (arg?: unknown) =>
    typeof arg === 'string' ? arg : (arg as { type?: string; by?: string; key?: string } | undefined)?.by === 'source' ? (arg as { key: string }).key : undefined;
  /** 依檔案分組的檔案列參數（BmGroupNode、Uri 或 uriKey 字串），回傳檔案的 uriKey。 */
  const fileGroupKey = (arg?: unknown): string | undefined => {
    if (typeof arg === 'string') {
      return arg;
    }
    if (arg instanceof vscode.Uri) {
      return uriKey(arg);
    }
    const g = arg as Partial<BmGroupNode> | undefined;
    if (g?.type === 'bmGroup' && g.by === 'file') {
      return g.uri ? uriKey(g.uri) : g.key;
    }
    return undefined;
  };

  const setHideAway = async (hide: boolean) => {
    provider.hideNotOnBranch = hide;
    await context.workspaceState.update(STATE_HIDE_AWAY, hide);
    await vscode.commands.executeCommand('setContext', 'functionBookmarks.hideNotOnBranch', hide);
    provider.fire();
  };
  const initialHideAway = context.workspaceState.get<boolean>(STATE_HIDE_AWAY, false);
  provider.hideNotOnBranch = initialHideAway;
  void vscode.commands.executeCommand('setContext', 'functionBookmarks.hideNotOnBranch', initialHideAway);

  const applyViewState = async (filter: FilterMode, bmGroup: BookmarkGrouping = provider.bookmarkGrouping) => {
    provider.filterMode = filter;
    provider.bookmarkGrouping = bmGroup;
    await context.workspaceState.update(STATE_FILTER, filter);
    await context.workspaceState.update(STATE_BM_GROUP, bmGroup);
    await vscode.commands.executeCommand('setContext', 'functionBookmarks.filterMode', filter);
    await vscode.commands.executeCommand('setContext', 'functionBookmarks.bookmarkGrouping', bmGroup);
    provider.fire();
  };
  // 0.1.x 以前的「只顯示收藏」併入「只顯示書籤」；啟動時只讀不回寫 workspaceState，也不串行等待 setContext
  const savedFilter = context.workspaceState.get<string>(STATE_FILTER, 'all');
  const initialFilter: FilterMode = savedFilter === 'all' ? 'all' : 'bookmarks';
  const initialGroup = context.workspaceState.get<BookmarkGrouping>(STATE_BM_GROUP, 'file');
  provider.filterMode = initialFilter;
  provider.bookmarkGrouping = initialGroup;
  void vscode.commands.executeCommand('setContext', 'functionBookmarks.filterMode', initialFilter);
  void vscode.commands.executeCommand('setContext', 'functionBookmarks.bookmarkGrouping', initialGroup);


  const reportErrors = (errors: RuleError[]) => {
    for (const e of errors) {
      const key = `${e.ruleId}:${e.message}`;
      if (reportedErrors.has(key)) {
        continue;
      }
      reportedErrors.add(key);
      const open = vscode.l10n.t('Open Settings');
      void vscode.window
        .showWarningMessage(vscode.l10n.t('Detection rule "{0}" is invalid: {1}', e.ruleId, e.message), open)
        .then((pick) => {
          if (pick === open) {
            void vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.detection.rules`);
          }
        });
    }
  };

  const refreshNow = async () => {
    const hasContent = await provider.refresh(vscode.window.activeTextEditor);
    if (provider.currentFile) {
      reportErrors(provider.currentFile.errors);
    }
    void updateCursorBookmarkContext();
    if (hasContent) {
      followCursor();
    }
  };

  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = (delay = 300) => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => void refreshNow(), delay);
  };

  /** 側邊欄目前選取的項目是否就是指向這個函式（例如剛點的收藏），是的話不搶走選取。 */
  // 記住最後選取的項目：側邊欄重新整理的瞬間 selection 可能暫時是空的
  let lastSelected: TreeNode | undefined;
  const selectionPointsTo = (uri: vscode.Uri, path: string, line: number): boolean => {
    const sel = treeView.selection[0] ?? lastSelected;
    if (sel?.type === 'bookmark') {
      // 剛點了書籤：游標還停在書籤那一行就不搶走選取
      return sameUri(sel.entry.uri, uri) && sel.entry.bookmark.line === line;
    }
    if (sel?.type === 'favorite') {
      return sameUri(sel.fav.uri, uri) && sel.fav.mark.path === path;
    }
    if (sel?.type === 'symbol') {
      return sameUri(sel.uri, uri) && sel.symbol.path === path;
    }
    return false;
  };

  /** 上層有被使用者收合的節點（例如收合了「目前檔案」）時，不為了跟隨游標把它展開。 */
  const hasCollapsedAncestor = (node: TreeNode): boolean => {
    for (let p = provider.getParent(node); p; p = provider.getParent(p)) {
      if (provider.isExpanded(p) === false) {
        return true;
      }
    }
    return false;
  };

  /** 編輯器游標所在位置的書籤：游標這一行有看得到的行號書籤優先，其次為游標所在的函式書籤。 */
  const resolveCursorBookmark = async (): Promise<
    { kind: 'line'; entry: BookmarkEntry } | { kind: 'symbol'; node: SymbolNode } | undefined
  > => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || notes.isNoteDocument(editor.document.uri)) {
      return undefined;
    }
    const lineEntry = bookmarks.entryOf(undefined);
    if (lineEntry) {
      return { kind: 'line', entry: lineEntry };
    }
    if (!store.favoritesShown || !store.locate(editor.document.uri)) {
      return undefined;
    }
    const file = await service.getSymbols(editor.document);
    const sym = findInnermost(file.symbols, editor.selection.active.line);
    if (!sym || sym.kind === 'reference' || !store.get(editor.document.uri, sym)?.favorite) {
      return undefined;
    }
    const node: SymbolNode = {
      type: 'symbol',
      scope: 'current',
      uri: editor.document.uri,
      symbol: sym,
      parent: provider.sections.currentFile,
      children: [],
      id: '',
    };
    return { kind: 'symbol', node };
  };

  let cursorHasBookmarkState: boolean | undefined;
  let cursorCtxSeq = 0;
  const updateCursorBookmarkContext = async (): Promise<boolean> => {
    const seq = ++cursorCtxSeq;
    let has = false;
    const editor = vscode.window.activeTextEditor;
    if (editor && !notes.isNoteDocument(editor.document.uri) && store.locate(editor.document.uri)) {
      if (bookmarks.entryOf(undefined)) {
        has = true;
      } else if (store.favoritesShown) {
        const uriStr = editor.document.uri.toString();
        if (store.allFavorites().some((f) => f.uri.toString() === uriStr)) {
          const file = await service.getSymbols(editor.document);
          if (seq !== cursorCtxSeq) {
            return cursorHasBookmarkState ?? false;
          }
          const sym = findInnermost(file.symbols, editor.selection.active.line);
          has = !!(sym && sym.kind !== 'reference' && store.get(editor.document.uri, sym)?.favorite);
        }
      }
    }
    if (seq !== cursorCtxSeq) {
      return cursorHasBookmarkState ?? false;
    }
    if (has !== cursorHasBookmarkState) {
      cursorHasBookmarkState = has;
      await vscode.commands.executeCommand('setContext', 'functionBookmarks.cursorHasBookmark', has);
    }
    return has;
  };
  void updateCursorBookmarkContext();

  const isTreeNodeArg = (arg: unknown): arg is TreeNode =>
    !!arg && typeof arg === 'object' && !(arg instanceof vscode.Uri) && typeof (arg as { type?: unknown }).type === 'string';

  const isRenameableSymbol = (node: TreeNode): node is SymbolNode => {
    if (node.type !== 'symbol' || node.symbol.kind === 'reference') {
      return false;
    }
    const mark = store.get(node.uri, node.symbol);
    return !!(mark?.favorite || mark?.alias);
  };

  const noBookmarkAtCursor = () => {
    void vscode.window.showInformationMessage(vscode.l10n.t('There is no bookmark at the cursor.'));
  };

  let lastRevealed: string | undefined;
  /** 在側邊欄標示游標所在的函式；回傳實際標示的節點（測試用）。 */
  const followCursor = (): SymbolNode | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (
      !editor ||
      notes.isNoteDocument(editor.document.uri) ||
      !provider.currentFile ||
      !sameUri(editor.document.uri, provider.currentFile.uri) ||
      !treeView.visible ||
      provider.filterMode !== 'all' ||
      !readSettings(editor.document.uri).followCursor
    ) {
      return undefined;
    }
    const node = provider.nodeAt(editor.selection.active.line);
    if (!node || node.id === lastRevealed) {
      return undefined;
    }
    if (selectionPointsTo(editor.document.uri, node.symbol.path, editor.selection.active.line) || hasCollapsedAncestor(node)) {
      return undefined;
    }
    lastRevealed = node.id;
    void treeView.reveal(node, { select: true, focus: false, expand: false }).then(undefined, () => undefined);
    return node;
  };

  let cursorTimer: NodeJS.Timeout | undefined;
  const reg = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    files,
    store,
    favorites,
    project,
    resolver,
    provider,
    gutter,
    statusBar,
    ruleTester,
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hover),
    notes,
    tracker,
    external,
    branches,
    watchGitHead(() => void branches.refresh().then(() => external.checkAll())),
    reconciler,
    treeView,
    searchBox,
    reg('functionBookmarks.focusSearch', async () => {
      // 先打開側邊欄，打字時才看得到下方的書籤即時篩選
      if (!treeView.visible) {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      }
      searchBox.open();
    }),
    reg('functionBookmarks.clearSearch', () => searchBox.setQuery('')),
    reg('functionBookmarks.searchToList', () => searchBox.toList()),
    reg('functionBookmarks.searchClearAndClose', () => searchBox.clearAndClose()),
    reg('functionBookmarks.refresh', () => {
      service.invalidate();
      reportedErrors.clear();
      void favorites.refresh();
      provider.fire();
      return refreshNow();
    }),
    reg(COMMANDS.reveal, (uri: vscode.Uri, line: number, startCol: number, endCol: number) => reveal(uri, line, startCol, endCol)),
    reg(COMMANDS.openFavorite, (fav) => commands.openFavorite(fav)),
    reg(COMMANDS.openTemplate, (node?: TreeNode) => commands.openTemplate(node)),
    reg('functionBookmarks.addFavorite', (node?: TreeNode) => commands.setFavorite(node, true)),
    reg('functionBookmarks.removeFavorite', (node?: TreeNode) => commands.setFavorite(node, false)),
    reg('functionBookmarks.toggleFavorite', (node?: TreeNode) => commands.setFavorite(node, 'toggle')),
    reg('functionBookmarks.renameDisplayName', (node?: TreeNode, value?: string) => {
      // 側邊欄 F2 或函式右鍵呼叫：只針對可改名的書籤／函式節點動作，在非書籤節點（分組、檔案、區段等）不退回改編輯器游標處函式
      const n = node ?? treeView.selection[0];
      if (!n) {
        return undefined;
      }
      if (isBookmarkNode(n)) {
        return bookmarks.rename(n, value);
      }
      if (n.type === 'favorite' || isRenameableSymbol(n)) {
        return commands.rename(n, value);
      }
      return undefined;
    }),
    reg('functionBookmarks.editNote', async (node?: unknown) => {
      // 行號右鍵選單（{ lineNumber, uri }）：針對右鍵那一行（而非游標所在行）編輯備註；沒書籤就先依 Ctrl+Alt+B 規則建立
      const at = lineArg(node);
      if (at) {
        const hit = await bookmarks.ensureAtLine(at);
        if (!hit) {
          return undefined;
        }
        if (hit.kind === 'line') {
          return bookmarks.editNote({ type: 'bookmark', entry: hit.entry });
        }
        const symNode: SymbolNode = { type: 'symbol', scope: 'current', uri: hit.uri, symbol: hit.symbol, parent: provider.sections.currentFile, children: [], id: '' };
        return commands.editNote(symNode);
      }
      // 從編輯器右鍵呼叫（參數是檔案 Uri）：游標所在行有書籤就編輯書籤的備註，否則編輯函式的備註
      if (node instanceof vscode.Uri) {
        return bookmarks.entryOf(undefined) ? bookmarks.editNote() : commands.editNote(undefined);
      }
      if (node !== undefined) {
        return isBookmarkNode(node) ? bookmarks.editNote(node) : commands.editNote(node as TreeNode);
      }
      // 命令選擇區／無參數呼叫：游標所在行有看得到的行號書籤時優先編輯它的備註，否則改看側邊欄選取或游標所在函式
      if (bookmarks.entryOf(undefined)) {
        return bookmarks.editNote();
      }
      const n = treeView.visible ? treeView.selection[0] : undefined;
      return isBookmarkNode(n) ? bookmarks.editNote(n) : commands.editNote(n);
    }),
    reg(PREVIEW_NOTE_COMMAND, (arg?: unknown) => {
      if (arg instanceof vscode.Uri) {
        return bookmarks.entryOf(undefined) ? bookmarks.previewNote() : commands.previewNote(undefined);
      }
      if (arg !== undefined) {
        return isBookmarkNode(arg) || isBookmarkLinkArg(arg) ? bookmarks.previewNote(arg) : commands.previewNote(arg as TreeNode);
      }
      if (bookmarks.entryOf(undefined)) {
        return bookmarks.previewNote();
      }
      const n = treeView.visible ? treeView.selection[0] : undefined;
      return isBookmarkNode(n) || isBookmarkLinkArg(n) ? bookmarks.previewNote(n) : commands.previewNote(n as TreeNode);
    }),
    // 函式名稱提示中的連結：加入／移除書籤、重新命名、編輯備註
    reg(HOVER_ACTION, async (arg: HoverActionArg) => {
      const uri = vscode.Uri.parse(arg.uri);
      if (arg.action === 'toggle') {
        await commands.toggleFavoriteAt(uri, arg.path, arg.kind as SymbolKindName, arg.line);
        // 開著的提示內容無法更新（還寫著「加入書籤」）：關掉它，滑鼠再移上去就是新的內容；結果顯示在狀態列
        await vscode.commands.executeCommand('editor.action.hideHover').then(undefined, () => undefined);
        const name = arg.path.split('.').pop() ?? arg.path;
        const on = !!store.get(uri, { path: arg.path, kind: arg.kind as SymbolKindName })?.favorite;
        vscode.window.setStatusBarMessage(
          on ? `$(star-full) ${vscode.l10n.t('Bookmark added: {0}', name)}` : `$(star-empty) ${vscode.l10n.t('Bookmark removed: {0}', name)}`,
          3000,
        );
        return undefined;
      }
      const file = await service.getForUri(uri);
      const symbol = file && findByPath(file.symbols, arg.path, arg.kind);
      if (!symbol) {
        return undefined;
      }
      const node: SymbolNode = { type: 'symbol', scope: 'current', uri, symbol, parent: provider.sections.currentFile, children: [], id: '' };
      return arg.action === 'rename' ? commands.rename(node) : commands.editNote(node);
    }),
    reg(COMMANDS.revealLine, (uri: vscode.Uri, line: number) => revealLine(uri, line)),
    // 也可從行號右鍵選單呼叫（參數為 { lineNumber, uri }）
    reg('functionBookmarks.toggleBookmark', (arg?: unknown) => bookmarks.toggle(lineArg(arg))),
    reg('functionBookmarks.addLabeledBookmark', (arg?: unknown) => bookmarks.addLabeled(undefined, lineArg(arg))),
    // 函式書籤與行號書籤共用同一組指令：從側邊欄呼叫時作用在該節點；從命令選擇區／編輯器右鍵／快捷鍵呼叫時作用在游標所在的書籤
    reg('functionBookmarks.renameBookmark', async (arg?: unknown, value?: string) => {
      if (isTreeNodeArg(arg)) {
        if (isBookmarkNode(arg)) {
          return bookmarks.rename(arg, value);
        }
        if (arg.type === 'favorite' || isRenameableSymbol(arg)) {
          return commands.rename(arg, value);
        }
        return undefined;
      }
      const hit = await resolveCursorBookmark();
      if (!hit) {
        noBookmarkAtCursor();
        return undefined;
      }
      return hit.kind === 'line'
        ? bookmarks.rename({ type: 'bookmark', entry: hit.entry }, value)
        : commands.rename(hit.node, value);
    }),
    reg('functionBookmarks.editBookmarkTags', async (arg?: unknown, value?: string) => {
      if (isTreeNodeArg(arg)) {
        if (isBookmarkNode(arg)) {
          return bookmarks.editTags(arg, value);
        }
        if (arg.type === 'favorite' || arg.type === 'symbol') {
          return commands.editTags(arg, value);
        }
        return undefined;
      }
      const hit = await resolveCursorBookmark();
      if (!hit) {
        noBookmarkAtCursor();
        return undefined;
      }
      return hit.kind === 'line'
        ? bookmarks.editTags({ type: 'bookmark', entry: hit.entry }, value)
        : commands.editTags(hit.node, value);
    }),
    reg('functionBookmarks.removeBookmark', async (arg?: unknown) => {
      if (isTreeNodeArg(arg)) {
        if (isBookmarkNode(arg)) {
          return bookmarks.remove(arg);
        }
        if (arg.type === 'favorite' || arg.type === 'symbol') {
          return commands.setFavorite(arg, false);
        }
        return undefined;
      }
      const hit = await resolveCursorBookmark();
      if (!hit) {
        noBookmarkAtCursor();
        return undefined;
      }
      return hit.kind === 'line'
        ? bookmarks.remove({ type: 'bookmark', entry: hit.entry })
        : commands.setFavorite(hit.node, false);
    }),
    reg('functionBookmarks.moveBookmarkToCursor', (node?: TreeNode) => {
      if (node !== undefined && !isBookmarkNode(node)) {
        return undefined;
      }
      return bookmarks.moveToCursor(node);
    }),
    reg('functionBookmarks.clearBookmarksInFile', (arg?: vscode.Uri | { uri?: vscode.Uri }) =>
      bookmarks.clearFile(arg instanceof vscode.Uri ? arg : arg?.uri),
    ),
    branches.onDidChange(() => updateBranchLabel()),
    reg('functionBookmarks.setBookmarkBranchOnly', (node?: TreeNode) =>
      setBranchScope(store, bookmarks.entryOf(isBookmarkNode(node) ? node : undefined), true),
    ),
    reg('functionBookmarks.setBookmarkAllBranches', (node?: TreeNode) =>
      setBranchScope(store, bookmarks.entryOf(isBookmarkNode(node) ? node : undefined), false),
    ),
    reg('functionBookmarks.hideNotOnBranch', () => setHideAway(true)),
    reg('functionBookmarks.showNotOnBranch', () => setHideAway(false)),
    reg('functionBookmarks.cleanBranchRecords', (picked?: string[]) =>
      cleanBranchRecords(store, branches, external, Array.isArray(picked) ? picked : undefined),
    ),
    store.onDidChange(() => {
      updateSourceContext();
      void updateCursorBookmarkContext();
    }),
    favorites.onDidChange(() => void updateCursorBookmarkContext()),
    reg('functionBookmarks.exportBookmarks', (arg?: unknown, extra?: unknown) => {
      const g = arg as Partial<BmGroupNode> | undefined;
      const uri =
        arg instanceof vscode.Uri
          ? arg
          : g?.type === 'bmGroup' && g.by === 'file' && g.uri instanceof vscode.Uri
            ? g.uri
            : undefined;
      if (uri) {
        // Explorer 右鍵第二個參數是選取的 Uri[] 陣列，測試呼叫時可傳 ExportOptions 物件
        const opts = extra && typeof extra === 'object' && !Array.isArray(extra) ? (extra as ExportOptions) : {};
        return exportBookmarks(shareDeps, opts, uri);
      }
      return exportBookmarks(shareDeps, (arg as ExportOptions | undefined) ?? {});
    }),
    reg('functionBookmarks.importBookmarks', (arg?: unknown) =>
      importBookmarks(shareDeps, service, arg instanceof vscode.Uri ? { uri: arg } : ((arg as ImportOptions | undefined) ?? {})),
    ),
    reg('functionBookmarks.chooseStorage', (choice?: WorkspaceStorageChoice) => store.chooseStorage(choice)),
    reg('functionBookmarks.filterBookmarkSources', (hidden?: unknown) => filterSources(store, Array.isArray(hidden) ? hidden : undefined)),
    reg('functionBookmarks.filterBookmarkSourcesActive', () => filterSources(store)),
    reg('functionBookmarks.groupBookmarksBySource', () => applyViewState(provider.filterMode, 'source')),
    reg('functionBookmarks.deleteBookmarkSource', (arg?: unknown, confirmed?: boolean) => deleteSource(store, sourceArg(arg), confirmed === true)),
    reg('functionBookmarks.renameBookmarkSource', (arg?: unknown, newName?: string) => renameSource(store, sourceArg(arg), newName)),
    reg('functionBookmarks.makeBookmarkMine', (node?: TreeNode) => makeMine(store, entryArg(node))),
    reg('functionBookmarks.clearAllBookmarks', () => bookmarks.clearAll()),
    // M7：數字快速書籤、顏色、暫時隱藏圖示
    reg('functionBookmarks.setBookmarkNumber', (node?: unknown, value?: number | 'next' | null, confirmed?: boolean) =>
      extras.setNumber(extrasArg(node), value, confirmed),
    ),
    reg('functionBookmarks.toggleNumberedBookmark', (arg?: unknown, confirmed?: boolean) => {
      const n = numberArg(arg);
      return n === undefined ? extras.setNumber(undefined) : extras.toggleNumber(n, confirmed);
    }),
    reg('functionBookmarks.goToNumberedBookmark', (arg?: unknown) => extras.goToNumber(numberArg(arg))),
    reg('functionBookmarks.tourNext', () => extras.tour(1)),
    reg('functionBookmarks.tourPrevious', () => extras.tour(-1)),
    reg('functionBookmarks.setBookmarkColor', (node?: unknown, value?: string | null) =>
      extras.setColor(extrasArg(node), value),
    ),
    reg('functionBookmarks.setTagColor', (arg?: unknown, value?: string | null) => extras.setTagColor(arg, value)),
    reg('functionBookmarks.hideBookmarkIcons', () => setIconsHidden(true)),
    reg('functionBookmarks.showBookmarkIcons', () => setIconsHidden(false)),
    reg('functionBookmarks.toggleBookmarkIcons', () => setIconsHidden(!gutter.hidden)),
    // M8：測試偵測規則
    reg('functionBookmarks.testDetectionRules', (keep?: boolean) => ruleTester.toggle(keep === true)),
    reg('functionBookmarks.stopTestingDetectionRules', () => ruleTester.stop()),
    reg('functionBookmarks.nextBookmark', () => bookmarks.go(1)),
    reg('functionBookmarks.previousBookmark', () => bookmarks.go(-1)),
    reg('functionBookmarks.searchBookmarks', () =>
      searchMarks(store, favorites, {
        hideNotOnBranch: provider.hideNotOnBranch,
        openFavorite: (fav) => commands.openFavorite(fav),
      }),
    ),
    reg('functionBookmarks.showBookmarksOnly', () => applyViewState('bookmarks')),
    reg('functionBookmarks.groupBookmarksByTag', () => applyViewState(provider.filterMode, 'tag')),
    reg('functionBookmarks.groupBookmarksByFile', () => applyViewState(provider.filterMode, 'file')),
    reg('functionBookmarks.sortFileBookmarksByTitle', (arg?: unknown) => {
      const key = fileGroupKey(arg);
      return key ? provider.setFileSort(key, 'title') : undefined;
    }),
    reg('functionBookmarks.sortFileBookmarksByLine', (arg?: unknown) => {
      const key = fileGroupKey(arg);
      return key ? provider.setFileSort(key, 'line') : undefined;
    }),
    reg('functionBookmarks.goToReferenceLine', (node?: TreeNode) => commands.goToReferenceLine(node)),
    reg('functionBookmarks.goToParentBlock', (node?: TreeNode) => commands.goToParentBlock(node)),
    reg('functionBookmarks.showAll', () => applyViewState('all')),
    reg('functionBookmarks.searchFunctions', () => searchFunctions(project, service, store)),
    vscode.window.onDidChangeActiveTextEditor(() => {
      lastRevealed = undefined;
      void updateCursorBookmarkContext();
      scheduleRefresh(0);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document && e.contentChanges.length) {
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      if (provider.currentFile && provider.currentFile.uri.toString() === d.uri.toString()) {
        scheduleRefresh(0);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        service.invalidate();
        favorites.schedule(0);
        gutter.schedule(0);
        scheduleRefresh(0);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor) {
        return;
      }
      void updateCursorBookmarkContext();
      if (cursorTimer) {
        clearTimeout(cursorTimer);
      }
      cursorTimer = setTimeout(followCursor, 150);
    }),
    treeView.onDidChangeSelection((e) => {
      const sel = e.selection[0];
      if (sel) {
        lastSelected = sel;
        // 選取換到別的項目：清掉「上次標示」的紀錄，之後游標回到原函式時才會再標示
        if (sel.type !== 'symbol' || sel.id !== lastRevealed) {
          lastRevealed = undefined;
        }
      }
    }),
    treeView.onDidExpandElement((e) => provider.setExpanded(e.element, true)),
    treeView.onDidCollapseElement((e) => provider.setExpanded(e.element, false)),
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        lastRevealed = undefined;
        scheduleRefresh(0);
      }
    }),
    { dispose: () => [refreshTimer, cursorTimer].forEach((t) => t && clearTimeout(t)) },
  );

  activeDeactivate = async () => {
    await Promise.all([
      store.flush().catch(() => undefined),
      external.flushPersist().catch(() => undefined),
    ]);
  };
  startup.record('registerAndState', performance.now() - setupStart);
  startup.record('activate.total', startup.elapsed());
  // 書籤清單已在 store.init() 後立即可用；函式書籤驗證、目前檔案偵測、外部變動檢查與另一端存放檢查改在背景執行，不阻擋啟動
  void startup.measure('favorites.background', () => favorites.refresh());
  void startup.measure('refreshNow.background', () => refreshNow());
  void startup.measure('external.init', () => external.init());
  void startup.measure('storage.checkOpposite', () => store.checkOppositeStorage());
  return {
    provider,
    store,
    favorites,
    commands,
    bookmarks,
    tracker,
    external,
    branches,
    reconciler,
    gutter,
    extras,
    statusBar,
    ruleTester,
    notes,
    searchBox,
    refreshNow,
    followCursor,
    updateCursorBookmarkContext,
    treeView,
    collectProjectSymbols: () => collectProjectSymbols(project, service, store),
    extendMarkdownIt: (md: unknown) =>
      // 已經裝了 Markdown Preview Mermaid Support 就交給它，避免重複繪圖
      vscode.extensions.getExtension('bierner.markdown-mermaid') ? md : mermaidPlugin(md),
    startupTimings: startup.timings,
    recreateProvider: () =>
      new FunctionTreeProvider(service, store, favorites, project, resolver, context.workspaceState, (uri) => notes.isNoteDocument(uri)),
    recreateStore: () => new MarkStore(context),
  };
}

export function deactivate(): Promise<void> {
  const fn = activeDeactivate;
  activeDeactivate = undefined;
  return fn ? fn() : Promise.resolve();
}
