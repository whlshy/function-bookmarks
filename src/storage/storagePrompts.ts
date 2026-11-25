import * as vscode from 'vscode';
import { StorageMode, WorkspaceStorageChoice } from '../config';
import { BOOKMARKS_FILE } from './gitExclude';

/**
 * 書籤存放位置相關的介面（選單、提示訊息）。
 * 只負責問使用者、回傳選擇；實際搬移資料與狀態處理留在 MarkStore。
 */

/** 「選擇這個專案的書籤存放位置」QuickPick 項目。 */
export interface StoragePickItem extends vscode.QuickPickItem {
  value: WorkspaceStorageChoice;
}

/** 存放位置的顯示名稱。 */
export function storageLabel(mode: StorageMode): string {
  return mode === 'file' ? BOOKMARKS_FILE : vscode.l10n.t('Editor workspace storage');
}

/** 建立選單項目：標出這個工作區的個別選擇（目前）與實際生效的存放端（生效中）。 */
export function storagePickItems(state: {
  override: StorageMode | undefined;
  setting: StorageMode;
  effective: StorageMode;
}): StoragePickItem[] {
  const cur = vscode.l10n.t('current');
  const active = vscode.l10n.t('active');
  const desc = (selected: boolean, isActive: boolean): string | undefined =>
    [selected ? cur : '', isActive ? active : ''].filter(Boolean).join(' · ') || undefined;
  return [
    {
      label: `$(file) ${BOOKMARKS_FILE}`,
      description: desc(state.override === 'file', state.effective === 'file'),
      detail: vscode.l10n.t('Stored inside the project (kept out of git via .git/info/exclude)'),
      value: 'file',
    },
    {
      label: `$(database) ${vscode.l10n.t('Editor workspace storage')}`,
      description: desc(state.override === 'workspaceState', state.effective === 'workspaceState'),
      detail: vscode.l10n.t('Stored by the editor (no file is created in the project)'),
      value: 'workspaceState',
    },
    {
      label: `$(settings-gear) ${vscode.l10n.t('Follow setting')}`,
      description: desc(state.override === undefined, false),
      detail: vscode.l10n.t('Use functionBookmarks.storage setting (currently: {0})', storageLabel(state.setting)),
      value: 'setting',
    },
  ];
}

/** 顯示選單讓使用者選存放位置；按 Esc 回傳 undefined。 */
export async function pickStorageChoice(items: StoragePickItem[], effective: StorageMode): Promise<WorkspaceStorageChoice | undefined> {
  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Choose bookmark storage for this workspace'),
    placeHolder: vscode.l10n.t('Currently active: {0}', storageLabel(effective)),
  });
  return pick?.value;
}

/** 選了存放位置但實際生效的位置沒變時，在狀態列簡短說明。 */
export function showStorageUnchanged(followsSetting: boolean, mode: StorageMode): void {
  const msg = followsSetting
    ? vscode.l10n.t('Bookmark storage for this workspace now follows the setting ({0}).', storageLabel(mode))
    : vscode.l10n.t('Bookmark storage for this workspace is set to {0}.', storageLabel(mode));
  vscode.window.setStatusBarMessage(`$(database) ${msg}`, 4000);
}

/** 目前存放端是空的、另一端有書籤：問要不要複製過來。沒點任何選項時回傳 undefined。 */
export async function askCopyFromOpposite(from: StorageMode, to: StorageMode): Promise<'copy' | 'keep' | undefined> {
  const copy = vscode.l10n.t('Copy bookmarks');
  const keep = vscode.l10n.t('Keep empty');
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t('No bookmarks in {0} yet, but bookmarks were found in {1}. Copy them over?', storageLabel(to), storageLabel(from)),
    copy,
    keep,
  );
  return pick === copy ? 'copy' : pick === keep ? 'keep' : undefined;
}

/**
 * 切換存放位置後，問要怎麼處理原本那一端的書籤。
 * 新的一端沒有書籤時只有「複製／保持空白」；已有書籤時是「合併／取代／保留現有資料」。沒點任何選項時回傳 undefined。
 */
export async function askMigration(
  from: StorageMode,
  to: StorageMode,
  targetHadData: boolean,
): Promise<'copy' | 'merge' | 'replace' | 'keep' | undefined> {
  const fromLabel = storageLabel(from);
  const toLabel = storageLabel(to);
  if (!targetHadData) {
    const copy = vscode.l10n.t('Copy bookmarks');
    const keep = vscode.l10n.t('Keep empty');
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t('Storage changed to {0}. Copy your bookmarks from {1}?', toLabel, fromLabel),
      copy,
      keep,
    );
    return pick === copy ? 'copy' : pick === keep ? 'keep' : undefined;
  }
  const merge = vscode.l10n.t('Merge');
  const replace = vscode.l10n.t('Replace');
  const keep = vscode.l10n.t('Keep existing');
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t('Storage changed to {0}, which already has bookmarks. What would you like to do with bookmarks from {1}?', toLabel, fromLabel),
    merge,
    replace,
    keep,
  );
  return pick === merge ? 'merge' : pick === replace ? 'replace' : pick === keep ? 'keep' : undefined;
}
