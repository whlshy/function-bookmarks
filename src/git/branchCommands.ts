import * as vscode from 'vscode';
import type { ExternalChangeWatcher } from '../bookmarks/externalWatcher';
import { updateBookmark } from '../storage/marks';
import { BookmarkEntry, MarkStore } from '../storage/store';
import { BranchService } from './branchService';

/** 書籤只屬於目前分支（其他分支隱藏），或改回所有分支都顯示。 */
export async function setBranchScope(store: MarkStore, entry: BookmarkEntry | undefined, branchOnly: boolean): Promise<void> {
  if (!entry) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There is no bookmark on this line.'));
    return;
  }
  const branch = store.branchOf(entry.folder);
  if (branchOnly && !branch) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Not on a git branch (not a git repository, or a commit is checked out directly).'),
    );
    return;
  }
  await store.update(entry.folder, (d) =>
    updateBookmark(d, entry.bookmark.id, (b) => {
      if (branchOnly) {
        b.scope = 'branch';
        b.homeBranch = branch;
      } else {
        delete b.scope;
        delete b.homeBranch;
      }
      return b;
    }),
  );
}

/**
 * 清理分支紀錄：列出書籤記錄過、但本機已經沒有的分支（被刪除或改名），選取後刪除這些紀錄；
 * 只屬於這些分支的書籤改成所有分支都顯示，避免永遠看不到。
 * `picked`：測試用，直接指定要清理的分支。
 */
export async function cleanBranchRecords(
  store: MarkStore,
  branches: BranchService,
  external: ExternalChangeWatcher,
  picked?: string[],
): Promise<string[]> {
  const stale = new Map<string, vscode.WorkspaceFolder[]>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const existing = await branches.existingBranches(folder);
    if (!existing) {
      continue;
    }
    const used = new Set<string>();
    for (const e of store.allBookmarks({ includeHidden: true })) {
      if (e.folder !== folder) {
        continue;
      }
      Object.keys(e.bookmark.positions ?? {}).forEach((n) => used.add(n));
      if (e.bookmark.homeBranch) {
        used.add(e.bookmark.homeBranch);
      }
    }
    external.rememberedBranches(folder).forEach((n) => used.add(n));
    for (const n of used) {
      if (!existing.includes(n)) {
        stale.set(n, [...(stale.get(n) ?? []), folder]);
      }
    }
  }
  if (!stale.size) {
    if (!picked) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No records of deleted branches.'));
    }
    return [];
  }
  let names = picked?.filter((n) => stale.has(n));
  if (!names) {
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const items = [...stale.keys()].sort().map((n) => ({
      label: n,
      description: multiRoot ? stale.get(n)!.map((f) => f.name).join(', ') : undefined,
      picked: true,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: vscode.l10n.t('Remove records of branches that no longer exist'),
      placeHolder: vscode.l10n.t('Bookmarks that belong only to a removed branch will be shown on every branch'),
    });
    if (!pick?.length) {
      return [];
    }
    names = pick.map((p) => p.label);
  }
  // 依資料夾分組清理：某分支只在 A 資料夾已刪除、但在 B 資料夾仍存在時，只清理 A 資料夾的紀錄與快照
  const perFolder = new Map<vscode.WorkspaceFolder, Set<string>>();
  for (const n of names) {
    for (const folder of stale.get(n) ?? []) {
      let s = perFolder.get(folder);
      if (!s) {
        s = new Set<string>();
        perFolder.set(folder, s);
      }
      s.add(n);
    }
  }
  for (const [folder, folderNames] of perFolder) {
    await store.update(folder, (d) => ({
      ...d,
      bookmarks: (d.bookmarks ?? []).map((b) => {
        const hasPos = Object.keys(b.positions ?? {}).some((n) => folderNames.has(n));
        const home = b.homeBranch !== undefined && folderNames.has(b.homeBranch);
        if (!hasPos && !home) {
          return b;
        }
        const next = { ...b };
        if (hasPos) {
          next.positions = Object.fromEntries(Object.entries(b.positions!).filter(([n]) => !folderNames.has(n)));
          if (!Object.keys(next.positions).length) {
            delete next.positions;
          }
        }
        if (home) {
          delete next.scope;
          delete next.homeBranch;
        }
        return next;
      }),
    }));
    external.forgetBranches([...folderNames], folder);
  }
  return names;
}
