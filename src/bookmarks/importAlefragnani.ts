import * as vscode from 'vscode';
import { findInnermost } from '../detection/engine';
import { addBookmark } from '../storage/marks';
import { MarkStore } from '../storage/store';
import { loadSource } from '../symbols/documentSource';
import { SymbolService } from '../symbols/symbolService';
import { ForeignBookmark, parseAlefragnani } from './alefragnani';
import { LineBookmark, makeAnchor, newBookmarkId } from './model';

export interface ImportResult {
  imported: number;
  skipped: number;
  /** 找到 bookmarks.json 的資料夾數。 */
  sources: number;
}

const FILE = '.vscode/bookmarks.json';

/**
 * 從 alefragnani Bookmarks 的 `.vscode/bookmarks.json` 匯入行號書籤（每個工作區資料夾各一份）。
 * 已經有書籤的行、找不到的檔案、超出檔案長度的行會略過；原本的檔案不會被修改。
 */
export async function importAlefragnani(
  store: MarkStore,
  service: SymbolService,
  options: { confirmed?: boolean } = {},
): Promise<ImportResult | undefined> {
  const found: { folder: vscode.WorkspaceFolder; items: ForeignBookmark[] }[] = [];
  let broken = 0;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const uri = vscode.Uri.joinPath(folder.uri, ...FILE.split('/'));
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      continue;
    }
    try {
      found.push({ folder, items: parseAlefragnani(JSON.parse(text)) });
    } catch {
      broken++;
    }
  }
  if (!found.length) {
    const msg = broken
      ? vscode.l10n.t('{0} could not be read (not valid JSON).', FILE)
      : vscode.l10n.t(
          'No {0} found. In the Bookmarks extension (alefragnani), turn on the setting "bookmarks.saveBookmarksInProject" so it saves its bookmarks to that file, then run this command again.',
          FILE,
        );
    void vscode.window.showInformationMessage(msg);
    return undefined;
  }
  const total = found.reduce((n, f) => n + f.items.length, 0);
  if (!total) {
    void vscode.window.showInformationMessage(vscode.l10n.t('{0} has no bookmarks to import.', FILE));
    return { imported: 0, skipped: 0, sources: found.length };
  }
  if (!options.confirmed) {
    const ok = vscode.l10n.t('Import');
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t('Import {0} bookmarks from the Bookmarks extension (alefragnani)?', total),
      {
        modal: true,
        detail: vscode.l10n.t('Lines that already have a bookmark are skipped. {0} is not changed.', FILE),
      },
      ok,
    );
    if (pick !== ok) {
      return undefined;
    }
  }
  let imported = 0;
  let skipped = 0;
  for (const { folder, items } of found) {
    const byFile = new Map<string, ForeignBookmark[]>();
    for (const it of items) {
      byFile.set(it.file, [...(byFile.get(it.file) ?? []), it]);
    }
    const created: LineBookmark[] = [];
    for (const [file, list] of byFile) {
      const uri = store.uriOf(folder, file);
      const src = await loadSource(uri);
      if (!src) {
        skipped += list.length;
        continue;
      }
      const lines = src.text.split(/\r?\n/);
      let symbols: Awaited<ReturnType<SymbolService['getForSource']>>['symbols'] = [];
      try {
        symbols = (await service.getForSource(src)).symbols;
      } catch {
        // 偵測失敗時只是沒有函式資訊
      }
      const taken = new Set(store.bookmarksFor(uri).map((b) => b.line));
      for (const it of list) {
        if (it.line >= lines.length || taken.has(it.line)) {
          skipped++;
          continue;
        }
        taken.add(it.line);
        const sym = findInnermost(symbols, it.line);
        const bm: LineBookmark = {
          id: newBookmarkId(),
          file,
          line: it.line,
          anchor: makeAnchor(lines, it.line, sym?.path, sym?.startLine),
          createdAt: new Date().toISOString(),
        };
        if (it.label) {
          bm.label = it.label;
        }
        created.push(bm);
      }
    }
    if (created.length) {
      await store.update(folder, (d) => created.reduce((acc, b) => addBookmark(acc, b), d));
      imported += created.length;
    }
  }
  void vscode.window.showInformationMessage(
    skipped
      ? vscode.l10n.t('Imported {0} bookmarks ({1} skipped: already bookmarked or file / line not found).', imported, skipped)
      : vscode.l10n.t('Imported {0} bookmarks.', imported),
  );
  return { imported, skipped, sources: found.length };
}
