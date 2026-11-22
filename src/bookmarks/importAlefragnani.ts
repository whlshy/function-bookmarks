import * as vscode from 'vscode';
import { findInnermost } from '../detection/engine';
import { addBookmark } from '../storage/marks';
import { MarkStore } from '../storage/store';
import { loadSource } from '../symbols/documentSource';
import { SymbolService } from '../symbols/symbolService';
import { ForeignBookmark } from './alefragnani';
import { LineBookmark, makeAnchor, newBookmarkId } from './model';

export interface AlefragnaniImportResult {
  format: 'alefragnani';
  imported: number;
  skipped: number;
}

/**
 * 匯入 alefragnani Bookmarks 的書籤（`.vscode/bookmarks.json`，由「匯入書籤」自動辨識格式後呼叫）。
 * 這是自己在舊套件加的書籤，匯入成自己的行號書籤（沒有來源註記）。
 * 已經有書籤的行、找不到的檔案、超出檔案長度的行會略過；原本的檔案不會被修改。
 */
export async function importAlefragnaniItems(
  store: MarkStore,
  service: SymbolService,
  folder: vscode.WorkspaceFolder,
  items: ForeignBookmark[],
  confirmed = false,
): Promise<AlefragnaniImportResult | undefined> {
  if (!confirmed) {
    const ok = vscode.l10n.t('Import');
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t('Import {0} bookmarks from the Bookmarks extension (alefragnani)?', items.length),
      { modal: true, detail: vscode.l10n.t('They are added as your own bookmarks. Lines that already have a bookmark are skipped.') },
      ok,
    );
    if (pick !== ok) {
      return undefined;
    }
  }
  const byFile = new Map<string, ForeignBookmark[]>();
  for (const it of items) {
    byFile.set(it.file, [...(byFile.get(it.file) ?? []), it]);
  }
  let skipped = 0;
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
  }
  void vscode.window.showInformationMessage(
    skipped
      ? vscode.l10n.t('Imported {0} bookmarks ({1} skipped: already bookmarked or file / line not found).', created.length, skipped)
      : vscode.l10n.t('Imported {0} bookmarks.', created.length),
  );
  return { format: 'alefragnani', imported: created.length, skipped };
}
