import * as vscode from 'vscode';
import { DetectedSymbol } from '../detection/types';
import { bookmarkTitle, revealLine } from '../bookmarks/commands';
import { circled } from '../bookmarks/decor';
import { MarkStore } from '../storage/store';
import { FavoritesModel } from '../symbols/favorites';
import { ProjectFiles } from '../symbols/projectFiles';
import { SymbolService } from '../symbols/symbolService';
import { COMMANDS, ICONS } from './tree';

export interface SearchEntry {
  uri: vscode.Uri;
  rel: string;
  symbol: DetectedSymbol;
  alias?: string;
  note?: string;
  favorite: boolean;
}

/** 收集整個專案的函式（不含 extends／include 參照），每讀完一批就回報一次。 */
export async function collectProjectSymbols(
  project: ProjectFiles,
  service: SymbolService,
  store: MarkStore,
  onBatch?: (entries: SearchEntry[]) => void,
  token?: vscode.CancellationToken,
): Promise<SearchEntry[]> {
  const out: SearchEntry[] = [];
  const files = (await project.all()).flatMap((f) => f.rels.map((rel) => ({ rel, uri: store.uriOf(f.folder, rel) })));
  const CONCURRENCY = 8;
  let next = 0;
  let lastReport = Date.now();
  const worker = async () => {
    while (next < files.length && !token?.isCancellationRequested) {
      const f = files[next++];
      const result = await service.getForUri(f.uri).catch(() => undefined);
      const walk = (list: DetectedSymbol[]) => {
        for (const s of list) {
          if (s.kind !== 'reference') {
            const mark = store.get(f.uri, s);
            out.push({ uri: f.uri, rel: f.rel, symbol: s, alias: mark?.alias, note: mark?.note, favorite: !!mark?.favorite });
          }
          walk(s.children);
        }
      };
      walk(result?.symbols ?? []);
      if (onBatch && Date.now() - lastReport > 150) {
        lastReport = Date.now();
        onBatch(out);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  onBatch?.(out);
  return out;
}

interface Item extends vscode.QuickPickItem {
  entry: SearchEntry;
}

function toItem(e: SearchEntry): Item {
  const s = e.symbol;
  const label = `$(${ICONS[s.kind]}) ${e.alias ?? s.name}`;
  const desc: string[] = [];
  if (e.favorite) {
    desc.push('★');
  }
  if (e.alias) {
    desc.push(s.path);
  } else if (s.path !== s.name) {
    desc.push(s.path);
  }
  const firstLine = e.note?.split('\n').find((l) => l.trim())?.trim();
  const detail = `${e.rel}:${s.nameLine + 1}${firstLine ? `  ·  ${firstLine.slice(0, 80)}` : ''}`;
  return { label, description: desc.join(' '), detail, entry: e };
}

/** 「搜尋函式」：同時比對自訂名稱、原本的函式名稱、路徑與檔名。 */
export async function searchFunctions(project: ProjectFiles, service: SymbolService, store: MarkStore): Promise<void> {
  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = vscode.l10n.t('Search functions in the workspace (display name, original name, path or file)');
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.busy = true;
  const cts = new vscode.CancellationTokenSource();
  qp.onDidHide(() => {
    cts.cancel();
    qp.dispose();
  });
  qp.onDidAccept(() => {
    const pick = qp.selectedItems[0];
    if (!pick) {
      return;
    }
    const s = pick.entry.symbol;
    qp.hide();
    void vscode.commands.executeCommand(COMMANDS.reveal, pick.entry.uri, s.nameLine, s.nameStartCol, s.nameEndCol);
  });
  qp.show();
  // 收藏的排前面，其餘依檔案順序
  const order = (list: SearchEntry[]) => [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite)).map(toItem);
  await collectProjectSymbols(project, service, store, (entries) => {
    qp.items = order(entries);
  }, cts.token);
  qp.busy = false;
}

interface MarkItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
  line: number;
}

/**
 * 「快速搜尋書籤」：書籤與收藏放在同一個清單，
 * 可用名稱、標籤、檔名、所在函式、該行內容搜尋。
 */
export async function searchMarks(store: MarkStore, favorites: FavoritesModel): Promise<void> {
  const items: MarkItem[] = [];
  for (const e of store.allBookmarks().filter((x) => store.shownBySource(x.bookmark)).sort((a, b) => a.bookmark.file.localeCompare(b.bookmark.file) || a.bookmark.line - b.bookmark.line)) {
    const b = e.bookmark;
    const desc = [b.tags?.map((t) => `#${t}`).join(' '), b.anchor?.symbolPath].filter(Boolean).join('  ');
    const text = b.label && b.anchor?.text ? `  ·  ${b.anchor.text.slice(0, 80)}` : '';
    items.push({
      label: `$(bookmark) ${b.number ? `${circled(b.number)} ` : ''}${bookmarkTitle(b)}`,
      description: desc,
      detail: `${b.file}:${b.line + 1}${text}`,
      uri: e.uri,
      line: b.line,
    });
  }
  for (const f of favorites.all) {
    const line = f.symbol?.nameLine ?? f.mark.line ?? 0;
    const name = f.mark.path.split('.').pop() ?? f.mark.path;
    items.push({
      label: `$(symbol-function) ${f.mark.number ? `${circled(f.mark.number)} ` : ''}${f.mark.alias ?? name}`,
      description: [f.mark.tags?.map((t) => `#${t}`).join(' '), f.mark.alias || f.mark.path !== name ? f.mark.path : '']
        .filter(Boolean)
        .join('  '),
      detail: `${f.mark.file}:${line + 1}`,
      uri: f.uri,
      line,
    });
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No bookmarks or favorites yet.'));
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Search bookmarks and favorites (name, tag, file, function or line)'),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (pick) {
    await revealLine(pick.uri, pick.line);
  }
}
