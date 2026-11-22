import * as vscode from 'vscode';
import { updateBookmark } from '../storage/marks';
import { BookmarkEntry, MarkStore } from '../storage/store';

/** 篩選來源：勾選要顯示的來源（我的、henry.hsu…）。`hidden`：測試用，直接指定要隱藏的來源（自己的為空字串）。 */
export async function filterSources(store: MarkStore, hidden?: string[]): Promise<void> {
  if (hidden) {
    store.setHiddenSources(hidden);
    return;
  }
  const sources = store.sources();
  const current = new Set(store.hiddenSourceList);
  const counts = new Map<string, number>();
  for (const e of store.allBookmarks()) {
    const k = e.bookmark.source?.author ?? '';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const items = [
    { label: `$(account) ${vscode.l10n.t('Mine')}`, description: String((counts.get('') ?? 0) + store.allFavorites().length), key: '', picked: !current.has('') },
    ...sources.map((s) => ({ label: `$(person) ${s}`, description: String(counts.get(s) ?? 0), key: s, picked: !current.has(s) })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: vscode.l10n.t('Show bookmarks from'),
    placeHolder: vscode.l10n.t('Uncheck a source to hide its bookmarks'),
  });
  if (!pick) {
    return;
  }
  const shown = new Set(pick.map((p) => p.key));
  store.setHiddenSources(items.map((i) => i.key).filter((k) => !shown.has(k)));
}

async function pickSource(store: MarkStore, title: string): Promise<string | undefined> {
  const sources = store.sources();
  if (!sources.length) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There are no imported bookmarks.'));
    return undefined;
  }
  return vscode.window.showQuickPick(sources, { title });
}

/** 刪除某個來源的全部書籤（會先確認）。 */
export async function deleteSource(store: MarkStore, author?: string, confirmed?: boolean): Promise<number> {
  const name = author ?? (await pickSource(store, vscode.l10n.t('Delete bookmarks from which source?')));
  if (!name) {
    return 0;
  }
  const entries = store.allBookmarks({ includeHidden: true }).filter((e) => e.bookmark.source?.author === name);
  if (!entries.length) {
    return 0;
  }
  if (!confirmed) {
    const del = vscode.l10n.t('Delete');
    const pick = await vscode.window.showWarningMessage(vscode.l10n.t('Delete all {0} bookmarks from {1}?', entries.length, name), { modal: true }, del);
    if (pick !== del) {
      return 0;
    }
  }
  for (const folder of new Set(entries.map((e) => e.folder))) {
    await store.update(folder, (d) => ({ ...d, bookmarks: (d.bookmarks ?? []).filter((b) => b.source?.author !== name) }));
  }
  store.setHiddenSources(store.hiddenSourceList.filter((s) => s !== name));
  return entries.length;
}

/** 修改來源註記；改成已存在的註記等於合併成同一個來源。 */
export async function renameSource(store: MarkStore, author?: string, newName?: string): Promise<boolean> {
  const name = author ?? (await pickSource(store, vscode.l10n.t('Rename which source?')));
  if (!name) {
    return false;
  }
  const next = (
    newName ??
    (await vscode.window.showInputBox({
      title: vscode.l10n.t('Source note'),
      value: name,
      valueSelection: [0, name.length],
      validateInput: (v) => (v.trim() ? undefined : vscode.l10n.t('Enter a source note.')),
    }))
  )?.trim();
  if (!next || next === name) {
    return false;
  }
  const entries = store.allBookmarks({ includeHidden: true }).filter((e) => e.bookmark.source?.author === name);
  for (const folder of new Set(entries.map((e) => e.folder))) {
    await store.update(folder, (d) => ({
      ...d,
      bookmarks: (d.bookmarks ?? []).map((b) => (b.source?.author === name ? { ...b, source: { ...b.source, author: next } } : b)),
    }));
  }
  if (store.hiddenSourceList.includes(name)) {
    store.setHiddenSources([...store.hiddenSourceList.filter((s) => s !== name), next]);
  }
  return true;
}

/** 把別人的書籤轉成我的（拿掉來源註記）。 */
export async function makeMine(store: MarkStore, entry: BookmarkEntry | undefined): Promise<void> {
  if (!entry?.bookmark.source) {
    return;
  }
  await store.update(entry.folder, (d) =>
    updateBookmark(d, entry.bookmark.id, (b) => {
      delete b.source;
      return b;
    }),
  );
}
