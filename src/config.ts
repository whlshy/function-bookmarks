import * as vscode from 'vscode';
import { BUILTIN_RULES, PROJECT_EXTENSIONS, TEMPLATE_FILES_PLACEHOLDER } from './detection/languages';
import { mergeRules } from './detection/engine';
import { DetectionRule } from './detection/types';
import { matchesAny } from './util/paths';
import { parseStorageOverride, resolveStorageMode, StorageMode, WorkspaceStorageChoice } from './storage/storageMode';

export const SECTION = 'functionBookmarks';
/** 存在 workspaceState 的鍵名：這個工作區個別選擇的存放模式（未設表示跟隨設定）。 */
export const WORKSPACE_STORAGE_KEY = 'storageMode';

export type DetectionSource = 'rules' | 'languageServer' | 'both';
export type { StorageMode, WorkspaceStorageChoice };

export interface Settings {
  source: DetectionSource;
  rules: DetectionRule[];
  followCursor: boolean;
}

/** 「整個專案」預設列出的檔案：各語言（detection/languages）的副檔名。package.json 的預設值要一致（有單元測試檢查）。 */
export const DEFAULT_PROJECT_INCLUDE = `**/*.{${PROJECT_EXTENSIONS.join(',')}}`;
export const DEFAULT_PROJECT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.venv/**',
  '**/venv/**',
  '**/env/**',
  '**/__pycache__/**',
  '**/site-packages/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/staticfiles/**',
  '**/.next/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/target/**',
  '**/vendor/**',
  '**/obj/**',
  '**/.gradle/**',
  '**/Pods/**',
];

export function readSettings(scope?: vscode.ConfigurationScope): Settings {
  const cfg = vscode.workspace.getConfiguration(SECTION, scope);
  const templateFiles = cfg.get<string[]>('detection.templateFiles', ['**/templates/**']);
  const user = cfg.get<DetectionRule[]>('detection.rules', []);
  const disabled = cfg.get<string[]>('detection.disabledRules', ['html-id']);
  const rules = mergeRules(BUILTIN_RULES, Array.isArray(user) ? user : [], Array.isArray(disabled) ? disabled : []).map(
    (r) =>
      r.include?.includes(TEMPLATE_FILES_PLACEHOLDER)
        ? { ...r, include: r.include.flatMap((g) => (g === TEMPLATE_FILES_PLACEHOLDER ? templateFiles : [g])) }
        : r,
  );
  return {
    source: cfg.get<DetectionSource>('detection.source', 'rules'),
    rules,
    followCursor: cfg.get<boolean>('followCursor', true),
  };
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
  const cfg = vscode.workspace.getConfiguration(SECTION, scope);
  return {
    include: cfg.get<string>('project.include', DEFAULT_PROJECT_INCLUDE) || DEFAULT_PROJECT_INCLUDE,
    exclude: cfg.get<string[]>('project.exclude', DEFAULT_PROJECT_EXCLUDE) ?? DEFAULT_PROJECT_EXCLUDE,
  };
}

export function templateDirs(scope?: vscode.ConfigurationScope): string[] {
  return vscode.workspace.getConfiguration(SECTION, scope).get<string[]>('django.templateDirs', []) ?? [];
}

/** 規則的 include glob 是否符合這個檔案；沒有 include 就一律適用。 */
export function ruleApplies(rule: DetectionRule, uri: vscode.Uri): boolean {
  if (!rule.include || rule.include.length === 0) {
    return true;
  }
  const rel = vscode.workspace.asRelativePath(uri, false);
  return matchesAny(rule.include, rel) || matchesAny(rule.include, uri.path);
}
