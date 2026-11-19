import * as vscode from 'vscode';
import { BookmarkCommands, isBookmarkLinkArg, revealLine } from './bookmarks/commands';
import { BookmarkTracker } from './bookmarks/tracker';
import { Commands, reveal } from './commands';
import { readSettings, SECTION } from './config';
import { TemplateResolver } from './django/resolver';
import { RuleError, SymbolKindName } from './detection/types';
import { MarkStore } from './storage/store';
import { FavoritesModel } from './symbols/favorites';
import { ProjectFiles } from './symbols/projectFiles';
import { SymbolService } from './symbols/symbolService';
import { mermaidPlugin } from './markdown/mermaid';
import { BookmarkHoverProvider, HOVER_ACTION, HoverActionArg } from './views/hover';
import { findByPath } from './detection/engine';
import { FavoriteGutter } from './views/gutter';
import { NoteEditor, PREVIEW_NOTE_COMMAND } from './views/noteEditor';
import { collectProjectSymbols, searchFunctions, searchMarks } from './views/search';
import { BookmarkGrouping, BookmarkNode, COMMANDS, FilterMode, FunctionTreeProvider, SymbolNode, TreeNode } from './views/tree';
import { sameUri } from './util/uris';

const VIEW_ID = 'functionBookmarks.tree';
const STATE_FILTER = 'filterMode';
const STATE_BM_GROUP = 'bookmarkGrouping';

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
  gutter: FavoriteGutter;
  notes: NoteEditor;
  refreshNow(): Promise<void>;
  /** 立即執行一次游標跟隨，回傳被標示的節點。 */
  followCursor(): SymbolNode | undefined;
  treeView: vscode.TreeView<TreeNode>;
  collectProjectSymbols(): ReturnType<typeof collectProjectSymbols>;
  /** 內建 Markdown 預覽會呼叫：加上 Mermaid 繪圖。 */
  extendMarkdownIt(md: unknown): unknown;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const service = new SymbolService();
  const store = new MarkStore(context);
  await store.init();
  const favorites = new FavoritesModel(store, service);
  const project = new ProjectFiles();
  const resolver = new TemplateResolver(service);
  const provider = new FunctionTreeProvider(service, store, favorites, project, resolver, context.workspaceState);
  const notes = new NoteEditor(context.globalStorageUri);
  const commands = new Commands(service, store, resolver, notes);
  const bookmarks = new BookmarkCommands(store, service, notes, favorites);
  const tracker = new BookmarkTracker(store, service);
  const gutter = new FavoriteGutter(context.extensionUri, service, store);
  const hover = new BookmarkHoverProvider(service, store);
  const treeView = vscode.window.createTreeView<TreeNode>(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const reportedErrors = new Set<string>();

  const applyViewState = async (filter: FilterMode, bmGroup: BookmarkGrouping = provider.bookmarkGrouping) => {
    provider.filterMode = filter;
    provider.bookmarkGrouping = bmGroup;
    await context.workspaceState.update(STATE_FILTER, filter);
    await context.workspaceState.update(STATE_BM_GROUP, bmGroup);
    await vscode.commands.executeCommand('setContext', 'functionBookmarks.filterMode', filter);
    await vscode.commands.executeCommand('setContext', 'functionBookmarks.bookmarkGrouping', bmGroup);
    provider.fire();
  };
  // 0.1.x 以前的「只顯示收藏」併入「只顯示書籤」
  const savedFilter = context.workspaceState.get<string>(STATE_FILTER, 'all');
  await applyViewState(
    savedFilter === 'all' ? 'all' : 'bookmarks',
    context.workspaceState.get<BookmarkGrouping>(STATE_BM_GROUP, 'file'),
  );


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

  let lastRevealed: string | undefined;
  /** 在側邊欄標示游標所在的函式；回傳實際標示的節點（測試用）。 */
  const followCursor = (): SymbolNode | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !treeView.visible || provider.filterMode !== 'all' || !readSettings(editor.document.uri).followCursor) {
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
    store,
    favorites,
    project,
    resolver,
    provider,
    gutter,
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hover),
    notes,
    tracker,
    treeView,
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
    reg('functionBookmarks.renameDisplayName', (node?: TreeNode) => {
      const n = node ?? treeView.selection[0];
      return isBookmarkNode(n) ? bookmarks.rename(n) : commands.rename(n);
    }),
    reg('functionBookmarks.editNote', (node?: TreeNode | vscode.Uri) => {
      // 從編輯器右鍵呼叫（參數是檔案 Uri）：游標所在行有書籤就編輯書籤的備註，否則編輯函式的備註
      if (node instanceof vscode.Uri) {
        return bookmarks.entryOf(undefined) ? bookmarks.editNote() : commands.editNote(undefined);
      }
      const n = node ?? treeView.selection[0];
      return isBookmarkNode(n) ? bookmarks.editNote(n) : commands.editNote(n);
    }),
    reg(PREVIEW_NOTE_COMMAND, (arg?: unknown) => {
      if (arg instanceof vscode.Uri) {
        return bookmarks.entryOf(undefined) ? bookmarks.previewNote() : commands.previewNote(undefined);
      }
      const n = arg ?? treeView.selection[0];
      return isBookmarkNode(n) || isBookmarkLinkArg(n) ? bookmarks.previewNote(n) : commands.previewNote(n as TreeNode);
    }),
    // 函式名稱提示中的連結：加入／移除書籤、重新命名、編輯備註
    reg(HOVER_ACTION, async (arg: HoverActionArg) => {
      const uri = vscode.Uri.parse(arg.uri);
      if (arg.action === 'toggle') {
        return commands.toggleFavoriteAt(uri, arg.path, arg.kind as SymbolKindName, arg.line);
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
    // 函式書籤（favorite 節點）與行號書籤共用同一組右鍵指令，依節點種類分派
    reg('functionBookmarks.renameBookmark', (node?: TreeNode) => {
      const n = node ?? treeView.selection[0];
      return n?.type === 'favorite' ? commands.rename(n) : bookmarks.rename(n);
    }),
    reg('functionBookmarks.editBookmarkTags', (node?: TreeNode) =>
      node?.type === 'favorite' ? commands.editTags(node) : bookmarks.editTags(isBookmarkNode(node) ? node : undefined),
    ),
    reg('functionBookmarks.removeBookmark', (node?: TreeNode) =>
      node?.type === 'favorite' ? commands.setFavorite(node, false) : bookmarks.remove(isBookmarkNode(node) ? node : undefined),
    ),
    reg('functionBookmarks.clearBookmarksInFile', (arg?: vscode.Uri | { uri?: vscode.Uri }) =>
      bookmarks.clearFile(arg instanceof vscode.Uri ? arg : arg?.uri),
    ),
    reg('functionBookmarks.clearAllBookmarks', () => bookmarks.clearAll()),
    reg('functionBookmarks.nextBookmark', () => bookmarks.go(1)),
    reg('functionBookmarks.previousBookmark', () => bookmarks.go(-1)),
    reg('functionBookmarks.searchBookmarks', () => searchMarks(store, favorites)),
    reg('functionBookmarks.showBookmarksOnly', () => applyViewState('bookmarks')),
    reg('functionBookmarks.groupBookmarksByTag', () => applyViewState(provider.filterMode, 'tag')),
    reg('functionBookmarks.groupBookmarksByFile', () => applyViewState(provider.filterMode, 'file')),
    reg('functionBookmarks.goToReferenceLine', (node?: TreeNode) => commands.goToReferenceLine(node)),
    reg('functionBookmarks.goToParentBlock', (node?: TreeNode) => commands.goToParentBlock(node)),
    reg('functionBookmarks.showAll', () => applyViewState('all')),
    reg('functionBookmarks.searchFunctions', () => searchFunctions(project, service, store)),
    vscode.window.onDidChangeActiveTextEditor(() => {
      lastRevealed = undefined;
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

  await favorites.refresh();
  await refreshNow();
  return {
    provider,
    store,
    favorites,
    commands,
    bookmarks,
    tracker,
    gutter,
    notes,
    refreshNow,
    followCursor,
    treeView,
    collectProjectSymbols: () => collectProjectSymbols(project, service, store),
    extendMarkdownIt: (md: unknown) =>
      // 已經裝了 Markdown Preview Mermaid Support 就交給它，避免重複繪圖
      vscode.extensions.getExtension('bierner.markdown-mermaid') ? md : mermaidPlugin(md),
  };
}

export function deactivate(): void {
  // 所有資源都登記在 context.subscriptions，由 VS Code 釋放
}
