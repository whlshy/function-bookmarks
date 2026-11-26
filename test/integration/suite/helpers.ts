import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { emptyStore } from '../../../src/storage/marks';
import type { SymbolNode } from '../../../src/views/tree';

export const isCursor = /cursor/i.test(vscode.env.appName);

export function findExtension(): vscode.Extension<ExtensionApi> | undefined {
  return vscode.extensions.all.find((e) => e.packageJSON?.name === 'function-bookmarks') as
    | vscode.Extension<ExtensionApi>
    | undefined;
}

let cachedApi: ExtensionApi | undefined;

export async function activateExtension(): Promise<ExtensionApi> {
  if (cachedApi) {
    return cachedApi;
  }
  const ext = findExtension();
  assert.ok(ext, '找不到 Function Bookmarks 套件');
  cachedApi = await ext.activate();
  return cachedApi;
}

export function folder(): vscode.WorkspaceFolder {
  return vscode.workspace.workspaceFolders![0];
}

export function workspaceFile(...parts: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(folder().uri.fsPath, ...parts));
}

export async function open(uri: vscode.Uri, api: ExtensionApi): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  await api.refreshNow();
  return editor;
}

export async function openAt(uri: vscode.Uri, line: number, api: ExtensionApi): Promise<vscode.TextEditor> {
  const editor = await open(uri, api);
  editor.selection = new vscode.Selection(line, 0, line, 0);
  await api.refreshNow();
  await api.updateCursorBookmarkContext();
  return editor;
}

export function names(nodes: SymbolNode[]): unknown[] {
  return nodes.map((n) => (n.children.length ? { [n.symbol.name]: names(n.children) } : n.symbol.name));
}

export function findNode(nodes: SymbolNode[], p: string): SymbolNode | undefined {
  for (const n of nodes) {
    if (n.symbol.path === p) {
      return n;
    }
    const hit = findNode(n.children, p);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

export function labelOf(item: vscode.TreeItem): string {
  return typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
}

export async function readStoreFile(): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(workspaceFile('.vscode', 'function-bookmarks.json')));
  } catch {
    return undefined;
  }
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  return vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  );
}

/** 備註的預覽分頁數（內建 Markdown 預覽）。 */
export function previewTabCount(): number {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('markdown.preview')).length;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** 逾時錯誤訊息中要顯示的等待條件說明。 */
  label: string;
}

/**
 * 輪詢等待條件成立；逾時直接拋錯並說明等待條件與最後觀測值，絕不默默回傳未達標結果。
 */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  ok: (v: T) => boolean,
  opts: WaitOptions | string,
): Promise<T> {
  const { timeoutMs = 5000, intervalMs = 50, label } = typeof opts === 'string' ? { label: opts } : opts;
  const start = Date.now();
  let last: T;
  for (;;) {
    last = await fn();
    if (ok(last)) {
      return last;
    }
    if (Date.now() - start >= timeoutMs) {
      let repr: string;
      try {
        repr = JSON.stringify(last);
      } catch {
        repr = String(last);
      }
      throw new Error(`waitFor 逾時（${timeoutMs}ms）：等待「${label}」，最後觀測值：${repr}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * 觸發會開出 QuickPick／InputBox 的指令，並以 closeQuickOpen（等同按 Esc）取消。
 * 附安全逾時，避免 UI 未出現或未關閉時無限等待。
 */
export async function runAndCancelQuickOpen<T = unknown>(
  run: () => Thenable<T>,
  label = 'QuickOpen 取消操作',
  timeoutMs = 5000,
): Promise<T> {
  let done = false;
  const p = Promise.resolve(run()).finally(() => {
    done = true;
  });
  const timer = setInterval(() => {
    if (!done) {
      void vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    }
  }, 60);
  let guard: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    guard = setTimeout(() => reject(new Error(`runAndCancelQuickOpen 逾時（${timeoutMs}ms）：${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearInterval(timer);
    if (guard) {
      clearTimeout(guard);
    }
  }
}

/** 重置工作區書籤、來源篩選、搜尋字串與外部監看狀態（供各測試檔 beforeEach 共用）。 */
export async function resetWorkspace(api: ExtensionApi, opts: { closeEditors?: boolean } = {}): Promise<void> {
  if (opts.closeEditors) {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(
      () => vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0),
      (n) => n === 0,
      '所有分頁都已關閉',
    );
  }
  api.searchBox.close();
  api.searchBox.setQuery('');
  api.provider.setQuery('');
  api.store.setHiddenSources([]);
  await api.store.update(folder(), () => emptyStore());
  await api.store.flush();
  await api.favorites.refresh();
  await api.external.idle();
}

/** 測試結束後關閉編輯器並清空 .vscode 書籤檔。 */
export async function cleanupWorkspaceStore(api: ExtensionApi): Promise<void> {
  await resetWorkspace(api, { closeEditors: true });
  await vscode.workspace.fs.delete(workspaceFile('.vscode'), { recursive: true }).then(undefined, () => undefined);
}

/** 同時清空 file 與 workspaceState 兩端存放位置，並恢復成跟隨預設設定（file）。 */
export async function cleanBothStorages(api: ExtensionApi): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('functionBookmarks');
  api.store.suppressStoragePrompt = true;
  await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
  await api.store.update(folder(), () => emptyStore());
  await api.store.clearHandledOpposite('workspaceState');
  await api.store.clearHandledOpposite('file');
  await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'file');
  await api.store.update(folder(), () => emptyStore());
  await api.store.flush();
  await vscode.workspace.fs.delete(workspaceFile('.vscode', 'function-bookmarks.json')).then(undefined, () => undefined);
  await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'setting');
  await cfg.update('storage', undefined, vscode.ConfigurationTarget.Workspace);
  await waitFor(() => api.store.effectiveStorageMode(), (v) => v === 'file', '恢復預設 file 存放模式');
  api.store.lastStorageSwitch = undefined;
  api.store.lastOppositeCheck = undefined;
  api.store.suppressStoragePrompt = false;
}
