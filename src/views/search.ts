import * as vscode from 'vscode';
import { DetectedSymbol } from '../detection/types';
import { bookmarkTitle, jumpToBookmark } from '../bookmarks/commands';
import { circled } from '../bookmarks/decor';
import { isEmptyQuery, matchesQuery, parseQuery, SearchFields } from '../bookmarks/filter';
import { BookmarkItem, compareItems, shownBookmarkItems } from '../bookmarks/unified';
import { BookmarkEntry, MarkStore } from '../storage/store';
import { FavoritesModel, ResolvedFavorite } from '../symbols/favorites';
import { ProjectFiles } from '../symbols/projectFiles';
import { SymbolService } from '../symbols/symbolService';
import { COMMANDS, ICONS, searchFields } from './tree';

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
      if (token?.isCancellationRequested) {
        return;
      }
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
      if (onBatch && !token?.isCancellationRequested && Date.now() - lastReport > 150) {
        lastReport = Date.now();
        onBatch(out);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (!token?.isCancellationRequested) {
    onBatch?.(out);
  }
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
  let disposed = false;
  let scanDone = false;
  qp.onDidHide(() => {
    disposed = true;
    if (!scanDone) {
      cts.cancel();
    }
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
  try {
    await collectProjectSymbols(
      project,
      service,
      store,
      (entries) => {
        if (disposed || cts.token.isCancellationRequested) {
          return;
        }
        qp.items = order(entries);
      },
      cts.token,
    );
    if (!disposed && !cts.token.isCancellationRequested) {
      qp.busy = false;
    }
  } finally {
    scanDone = true;
    cts.dispose();
  }
}

export interface MarkQuickPickItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
  line: number;
  entry?: BookmarkEntry;
  fav?: ResolvedFavorite;
  fields: SearchFields;
}

export interface SearchMarksOptions {
  /** 是否隱藏「不在此分支」的書籤（跟隨側邊欄設定）。 */
  hideNotOnBranch?: boolean;
  /** 選中函式書籤時的開啟函式（未提供時退回共用跳轉函式）。 */
  openFavorite?: (fav: ResolvedFavorite) => Promise<boolean | void>;
}

function firstNoteLine(note: string | undefined): string | undefined {
  return note?.split(/\r?\n/).find((l) => l.trim())?.trim();
}

/** 建立「快速搜尋書籤」的項目清單（供 UI 與測試共用）。 */
export function buildSearchMarkItems(
  store: MarkStore,
  favorites: FavoritesModel,
  options: Pick<SearchMarksOptions, 'hideNotOnBranch'> = {},
): MarkQuickPickItem[] {
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const raw = shownBookmarkItems(store, favorites, { includeNotOnBranch: !options.hideNotOnBranch }).sort(
    (a, b) => (multiRoot ? a.folder.name.localeCompare(b.folder.name) : 0) || compareItems(a, b),
  );
  return raw.map((item) => toMarkQuickPickItem(item, multiRoot));
}

function toMarkQuickPickItem(item: BookmarkItem, multiRoot: boolean): MarkQuickPickItem {
  const fields: SearchFields = {
    ...searchFields(item),
    folder: multiRoot ? item.folder.name : undefined,
  };
  if (item.kind === 'line') {
    const e = item.entry;
    const b = e.bookmark;
    const lost = b.status === 'lost';
    const away = b.status === 'notOnBranch';
    const icon = lost ? '$(warning)' : away ? '$(git-branch)' : '$(bookmark)';
    const desc = [
      lost ? vscode.l10n.t('needs checking') : undefined,
      away ? vscode.l10n.t('not on this branch') : undefined,
      b.source ? `@${b.source.author}` : undefined,
      b.tags?.map((t) => `#${t}`).join(' '),
      b.anchor?.symbolPath ?? b.symbol?.path,
    ]
      .filter(Boolean)
      .join('  ');
    const where = `${multiRoot ? `${e.folder.name} · ` : ''}${b.file}:${b.line + 1}`;
    const code = b.label && b.anchor?.text ? b.anchor.text.slice(0, 80) : undefined;
    const noteLine = firstNoteLine(b.note)?.slice(0, 80);
    return {
      label: `${icon} ${b.number ? `${circled(b.number)} ` : ''}${bookmarkTitle(b)}`,
      description: desc,
      detail: [where, code, noteLine].filter(Boolean).join('  ·  '),
      uri: e.uri,
      line: b.line,
      entry: e,
      fields,
      alwaysShow: true,
    };
  }
  const f = item.fav;
  const line = f.symbol?.nameLine ?? f.mark.line ?? 0;
  const name = f.mark.path.split('.').pop() ?? f.mark.path;
  const missing = f.status !== 'ok';
  const icon = missing ? '$(warning)' : `$(${ICONS[f.mark.kind] ?? 'symbol-function'})`;
  const statusText = f.status === 'missing' ? vscode.l10n.t('function not found') : f.status === 'noFile' ? vscode.l10n.t('file not found') : undefined;
  const desc = [
    statusText,
    f.mark.tags?.map((t) => `#${t}`).join(' '),
    f.mark.alias || f.mark.path !== name ? f.mark.path : undefined,
  ]
    .filter(Boolean)
    .join('  ');
  const where = `${multiRoot ? `${f.folder.name} · ` : ''}${f.mark.file}:${line + 1}`;
  const noteLine = firstNoteLine(f.mark.note)?.slice(0, 80);
  return {
    label: `${icon} ${f.mark.number ? `${circled(f.mark.number)} ` : ''}${f.mark.alias ?? name}`,
    description: desc,
    detail: [where, noteLine].filter(Boolean).join('  ·  '),
    uri: f.uri,
    line,
    fav: f,
    fields,
    alwaysShow: true,
  };
}

/** 共用側邊欄的 filter.ts 比對規則（含完整多行備註、#標籤、@來源、資料夾名稱）。 */
export function filterSearchMarkItems(items: MarkQuickPickItem[], query: string): MarkQuickPickItem[] {
  const parsed = parseQuery(query);
  return isEmptyQuery(parsed) ? items : items.filter((i) => matchesQuery(parsed, i.fields));
}

/**
 * 「快速搜尋書籤」：書籤與收藏放在同一個清單，
 * 可用名稱、標籤、檔名、所在函式、該行內容、備註（含 #標籤、@來源）搜尋。
 */
export async function searchMarks(
  store: MarkStore,
  favorites: FavoritesModel,
  options: SearchMarksOptions = {},
): Promise<void> {
  const allItems = buildSearchMarkItems(store, favorites, options);
  if (allItems.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No bookmarks yet.'));
    return;
  }
  const qp = vscode.window.createQuickPick<MarkQuickPickItem>();
  qp.placeholder = vscode.l10n.t('Search bookmarks (name, tag, file, function, line or note)');
  qp.items = allItems;
  // 過濾交給 filterSearchMarkItems（使用 filter.ts），確保多行備註全文與 #tag / @source 都能搜到
  qp.onDidChangeValue((value) => {
    qp.items = filterSearchMarkItems(allItems, value);
  });
  const pick = await new Promise<MarkQuickPickItem | undefined>((resolve) => {
    let accepted: MarkQuickPickItem | undefined;
    qp.onDidAccept(() => {
      accepted = qp.selectedItems[0];
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(accepted);
    });
    qp.show();
  });
  if (pick) {
    if (pick.fav && options.openFavorite) {
      await options.openFavorite(pick.fav);
    } else if (pick.entry) {
      await jumpToBookmark({
        uri: pick.entry.uri,
        line: pick.entry.bookmark.line,
        file: pick.entry.bookmark.file,
        status: pick.entry.bookmark.status,
      });
    } else {
      await jumpToBookmark({ uri: pick.uri, line: pick.line });
    }
  }
}
