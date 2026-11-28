import * as vscode from 'vscode';
import { ConfigReader, projectGlobsFrom, ruleAppliesTo, SECTION, Settings, settingsFrom } from './core/settings';
import { DetectionRule } from './detection/types';
import { parseStorageOverride, resolveStorageMode, StorageMode, WorkspaceStorageChoice } from './storage/storageMode';

// 規則與專案範圍的計算在共用核心（core/settings），這裡只負責把 VS Code 設定交給它
export { DEFAULT_PROJECT_EXCLUDE, DEFAULT_PROJECT_INCLUDE, SECTION } from './core/settings';
export type { DetectionSource, Settings } from './core/settings';
/** 存在 workspaceState 的鍵名：這個工作區個別選擇的存放模式（未設表示跟隨設定）。 */
export const WORKSPACE_STORAGE_KEY = 'storageMode';

export type { StorageMode, WorkspaceStorageChoice };

/** VS Code 設定轉成共用核心的設定讀取函式。 */
function vscodeReader(scope?: vscode.ConfigurationScope): ConfigReader {
  const cfg = vscode.workspace.getConfiguration(SECTION, scope);
  return <T>(key: string, fallback: T) => cfg.get<T>(key, fallback);
}

export function readSettings(scope?: vscode.ConfigurationScope): Settings {
  return settingsFrom(vscodeReader(scope));
}

/** 讀取設定（functionBookmarks.storage）的值，作為沒有個別選擇時的預設。 */
export function settingStorageMode(): StorageMode {
  return vscode.workspace.getConfiguration(SECTION).get<StorageMode>('storage', 'file') === 'workspaceState' ? 'workspaceState' : 'file';
}

/** 讀取這個工作區個別選擇的存放模式；未設定代表跟隨設定。 */
export function workspaceStorageOverride(workspaceState: vscode.Memento): StorageMode | undefined {
  return parseStorageOverride(workspaceState.get(WORKSPACE_STORAGE_KEY));
}

/** 取得目前生效的存放模式：這個工作區的個別選擇優先，否則使用設定。 */
export function storageMode(workspaceState?: vscode.Memento): StorageMode {
  const override = workspaceState ? workspaceStorageOverride(workspaceState) : undefined;
  return resolveStorageMode(override, settingStorageMode());
}

export function projectGlobs(scope?: vscode.ConfigurationScope): { include: string; exclude: string[] } {
  return projectGlobsFrom(vscodeReader(scope));
}

export function templateDirs(scope?: vscode.ConfigurationScope): string[] {
  return vscode.workspace.getConfiguration(SECTION, scope).get<string[]>('django.templateDirs', []) ?? [];
}

/** 規則的 include glob 是否符合這個檔案；沒有 include 就一律適用。 */
export function ruleApplies(rule: DetectionRule, uri: vscode.Uri): boolean {
  return ruleAppliesTo(rule, vscode.workspace.asRelativePath(uri, false), uri.path);
}
