import * as vscode from 'vscode';
import { Commands, reveal } from './commands';
import { readSettings, SECTION } from './config';
import { TemplateResolver } from './django/resolver';
import { RuleError } from './detection/types';
import { MarkStore } from './storage/store';
import { FavoritesModel } from './symbols/favorites';
import { ProjectFiles } from './symbols/projectFiles';
import { SymbolService } from './symbols/symbolService';
import { collectProjectSymbols, searchFunctions } from './views/search';
import { COMMANDS, FilterMode, FunctionTreeProvider, TreeNode } from './views/tree';

const VIEW_ID = 'functionBookmarks.tree';
const STATE_FILTER = 'filterMode';
const STATE_GROUP = 'favoritesGroupByFile';

export interface ExtensionApi {
  /** 給整合測試使用。 */
  provider: FunctionTreeProvider;
  store: MarkStore;
  favorites: FavoritesModel;
  commands: Commands;
  refreshNow(): Promise<void>;
  collectProjectSymbols(): ReturnType<typeof collectProjectSymbols>;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const service = new SymbolService();
  const store = new MarkStore(context);
  await store.init();
  const favorites = new FavoritesModel(store, service);
  const project = new ProjectFiles();
  const resolver = new TemplateResolver(service);
  const provider = new FunctionTreeProvider(service, store, favorites, project, resolver);
  const commands = new Commands(service, store, resolver);
  const treeView = vscode.window.createTreeView<TreeNode>(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const reportedErrors = new Set<string>();

  const applyViewState = async (filter: FilterMode, group: boolean) => {
    provider.filterMode = filter;
    provider.groupByFile = group;
    await context.workspaceState.update(STATE_FILTER, filter);
    await context.workspaceState.update(STATE_GROUP, group);
    await vscode.commands.executeCommand('setContext', 'functionBookmarks.filterMode', filter);
    await vscode.commands.executeCommand('setContext', 'functionBookmarks.groupByFile', group);
    provider.fire();
  };
  await applyViewState(
    context.workspaceState.get<FilterMode>(STATE_FILTER, 'all'),
    context.workspaceState.get<boolean>(STATE_GROUP, true),
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

  let lastRevealed: string | undefined;
  const followCursor = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !treeView.visible || provider.filterMode !== 'all' || !readSettings(editor.document.uri).followCursor) {
      return;
    }
    const node = provider.nodeAt(editor.selection.active.line);
    if (!node || node.id === lastRevealed) {
      return;
    }
    lastRevealed = node.id;
    void treeView.reveal(node, { select: true, focus: false, expand: true }).then(undefined, () => undefined);
  };

  let cursorTimer: NodeJS.Timeout | undefined;
  const reg = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    store,
    favorites,
    project,
    resolver,
    provider,
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
    reg('functionBookmarks.renameDisplayName', (node?: TreeNode) => commands.rename(node ?? treeView.selection[0])),
    reg('functionBookmarks.goToReferenceLine', (node?: TreeNode) => commands.goToReferenceLine(node)),
    reg('functionBookmarks.goToParentBlock', (node?: TreeNode) => commands.goToParentBlock(node)),
    reg('functionBookmarks.showFavoritesOnly', () => applyViewState('favorites', provider.groupByFile)),
    reg('functionBookmarks.showAll', () => applyViewState('all', provider.groupByFile)),
    reg('functionBookmarks.groupByFile', () => applyViewState(provider.filterMode, true)),
    reg('functionBookmarks.ungroup', () => applyViewState(provider.filterMode, false)),
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        service.invalidate();
        favorites.schedule(0);
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
    refreshNow,
    collectProjectSymbols: () => collectProjectSymbols(project, service, store),
  };
}

export function deactivate(): void {
  // 所有資源都登記在 context.subscriptions，由 VS Code 釋放
}
