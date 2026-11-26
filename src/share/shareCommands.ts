/** 匯出、匯入、存放位置與來源相關的指令。 */
import * as vscode from 'vscode';
import { BookmarkCommands } from '../bookmarks/commands';
import { WorkspaceStorageChoice } from '../config';
import { BranchService } from '../git/branchService';
import { MarkStore } from '../storage/store';
import { FavoritesModel } from '../symbols/favorites';
import { SymbolService } from '../symbols/symbolService';
import { oneOf, plainOptions } from '../util/commandArgs';
import { isBookmarkNode, sourceArg } from '../util/editorArgs';
import type { BmGroupNode, TreeNode } from '../views/tree';
import { exportBookmarks, ExportOptions } from './exporter';
import { importBookmarks, ImportOptions } from './importer';
import { deleteSource, filterSources, makeMine, renameSource } from './sources';

// 側邊欄標題列（…）的指令會收到選取中的樹節點，選項一律經 plainOptions／oneOf 過濾（src/util/commandArgs.ts）
const EXPORT_OPTION_KEYS = ['folder', 'scope', 'includeImported', 'format', 'includeCode', 'target'] as const satisfies readonly (keyof ExportOptions)[];
const IMPORT_OPTION_KEYS = ['text', 'uri', 'from', 'folder', 'author', 'mode', 'confirmed'] as const satisfies readonly (keyof ImportOptions)[];
const STORAGE_CHOICES: readonly WorkspaceStorageChoice[] = ['file', 'workspaceState', 'setting'];

export interface ShareCommandDeps {
  store: MarkStore;
  favorites: FavoritesModel;
  branches: BranchService;
  service: SymbolService;
  bookmarks: BookmarkCommands;
}

export function registerShareCommands(deps: ShareCommandDeps): vscode.Disposable[] {
  const { store, service, bookmarks } = deps;
  const shareDeps = { store: deps.store, favorites: deps.favorites, branches: deps.branches, service: deps.service };
  const reg = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  return [
    // 標題列（…）、命令選擇區、Explorer 右鍵（Uri）：選取中的樹節點不算參數，一律匯出全部
    reg('functionBookmarks.exportBookmarks', (arg?: unknown, extra?: unknown) => {
      if (arg instanceof vscode.Uri) {
        // Explorer 右鍵第二個參數是選取的 Uri[] 陣列，測試呼叫時可傳 ExportOptions 物件
        return exportBookmarks(shareDeps, plainOptions<ExportOptions>(extra, EXPORT_OPTION_KEYS) ?? {}, arg);
      }
      return exportBookmarks(shareDeps, plainOptions<ExportOptions>(arg, EXPORT_OPTION_KEYS) ?? {});
    }),
    // 側邊欄檔案列右鍵：只匯出該檔
    reg('functionBookmarks.exportFileBookmarks', (arg?: unknown, extra?: unknown) => {
      const g = arg as Partial<BmGroupNode> | undefined;
      const uri = g?.type === 'bmGroup' && g.by === 'file' && g.uri instanceof vscode.Uri ? g.uri : undefined;
      const opts = plainOptions<ExportOptions>(extra, EXPORT_OPTION_KEYS) ?? {};
      return uri ? exportBookmarks(shareDeps, opts, uri) : exportBookmarks(shareDeps, opts);
    }),
    reg('functionBookmarks.importBookmarks', (arg?: unknown) =>
      importBookmarks(shareDeps, service, arg instanceof vscode.Uri ? { uri: arg } : (plainOptions<ImportOptions>(arg, IMPORT_OPTION_KEYS) ?? {})),
    ),
    reg('functionBookmarks.chooseStorage', (choice?: unknown) => store.chooseStorage(oneOf(choice, STORAGE_CHOICES))),
    reg('functionBookmarks.filterBookmarkSources', (hidden?: unknown) => filterSources(store, Array.isArray(hidden) ? hidden : undefined)),
    reg('functionBookmarks.filterBookmarkSourcesActive', () => filterSources(store)),
    reg('functionBookmarks.deleteBookmarkSource', (arg?: unknown, confirmed?: boolean) => deleteSource(store, sourceArg(arg), confirmed === true)),
    reg('functionBookmarks.renameBookmarkSource', (arg?: unknown, newName?: string) => renameSource(store, sourceArg(arg), newName)),
    reg('functionBookmarks.makeBookmarkMine', (node?: TreeNode) => makeMine(store, bookmarks.entryOf(isBookmarkNode(node) ? node : undefined))),
  ];
}
