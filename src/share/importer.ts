import * as vscode from 'vscode';
import { findByPath } from '../detection/engine';
import { DetectedSymbol } from '../detection/types';
import { LineBookmark, makeAnchor, newBookmarkId, visibleOnBranch } from '../bookmarks/model';
import { relocateBookmarks, splitLines } from '../bookmarks/relocate';
import { readRemoteUrl } from '../git/branch';
import { loadSource } from '../symbols/documentSource';
import { SymbolService } from '../symbols/symbolService';
import { parseAlefragnani } from '../bookmarks/alefragnani';
import { AlefragnaniImportResult, importAlefragnaniItems } from '../bookmarks/importAlefragnani';
import { BOOKMARKS_FILE } from '../storage/gitExclude';
import { dedupeStoreNumbers, favorites, hasStoreData, mergeStoreData, parseStoreFileImport, StoreData } from '../storage/marks';
import { reconcileFile } from '../storage/reconcile';
import { stripBom } from '../util/bom';
import { uriKey } from '../util/uris';
import { ShareDeps } from './exporter';
import { applyImport, decodeHashes, existingCounts, ExportedBookmark, ImportMode, normalizeRemote, parseExport } from './format';

export interface ImportOptions {
  /** 直接給匯出檔內容（測試、剪貼簿）。 */
  text?: string;
  uri?: vscode.Uri;
  from?: 'file' | 'clipboard';
  folder?: vscode.WorkspaceFolder;
  /** 來源註記；沒給時詢問（預設為匯出者）。 */
  author?: string;
  /** 同一來源之前匯入過時：取代或合併；沒給時詢問。 */
  mode?: ImportMode;
  /** 略過所有確認（測試用）。 */
  confirmed?: boolean;
}

export interface ImportResult {
  author: string;
  imported: number;
  /** 匯入後找不到位置（需確認）的筆數。 */
  lost: number;
  missingFiles: number;
  mode: ImportMode;
}

/** 匯入套件自己的書籤檔（.vscode/function-bookmarks.json）的結果。 */
export interface StoreImportResult {
  format: 'store';
  imported: number;
  /** 匯入後找不到位置（需確認）的筆數。 */
  lost: number;
  missingFiles: number;
  mode: ImportMode;
  /** 匯入的書籤中，因 scope='branch' 且限定於其他分支而目前隱藏的筆數。 */
  hiddenOnBranch?: number;
  /** 匯入的標籤顏色數（僅含 tagColors 時可用來辨識）。 */
  tagColors?: number;
  /** 選到目前正在使用的書籤檔，略過匯入。 */
  alreadyActive?: boolean;
}

/** 讀取要匯入的內容；從檔案時一併回傳檔案位置（用來決定匯入到哪個資料夾）。 */
async function readText(deps: ShareDeps, options: ImportOptions): Promise<{ text: string; uri?: vscode.Uri } | undefined> {
  if (options.text !== undefined) {
    return { text: options.text };
  }
  let from = options.from;
  let uri = options.uri;
  if (!uri && !from) {
    const file = vscode.l10n.t('From a file…');
    const pick = await vscode.window.showQuickPick([file, vscode.l10n.t('From the clipboard')], { title: vscode.l10n.t('Import bookmarks') });
    if (!pick) {
      return undefined;
    }
    from = pick === file ? 'file' : 'clipboard';
  }
  if (!uri && from === 'clipboard') {
    return { text: await vscode.env.clipboard.readText() };
  }
  if (!uri) {
    // 若專案在 workspaceState 模式且磁碟上有 .vscode/function-bookmarks.json，或有 alefragnani 的 bookmarks.json，直接開到該檔案
    let defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const candidates =
      deps.store.effectiveStorageMode() === 'workspaceState'
        ? [BOOKMARKS_FILE.split('/'), ['.vscode', 'bookmarks.json']]
        : [['.vscode', 'bookmarks.json']];
    outer: for (const parts of candidates) {
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        const u = vscode.Uri.joinPath(f.uri, ...parts);
        if (await exists(u)) {
          defaultUri = u;
          break outer;
        }
      }
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri,
      filters: { 'Function Bookmarks': ['json'] },
      title: vscode.l10n.t('Import bookmarks'),
    });
    uri = picked?.[0];
  }
  if (!uri) {
    return undefined;
  }
  return { text: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), uri };
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * 匯入套件自己的書籤檔（.vscode/function-bookmarks.json）：
 * 視為使用者自己的書籤，檔案內已含的其他來源資料照原樣保留；
 * 匯入前先依目前檔案內容重新定位（函式標記用 reconcileFile，行號書籤用 relocateBookmarks，找不到的標成需確認）。
 */
async function importStoreData(
  deps: ShareDeps,
  service: SymbolService,
  folder: vscode.WorkspaceFolder,
  storeData: StoreData,
  options: ImportOptions,
  sourceUri?: vscode.Uri,
): Promise<StoreImportResult | undefined> {
  if (!hasStoreData(storeData)) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There are no bookmarks to import.'));
    return undefined;
  }

  const curBranch = deps.store.branchOf(folder);
  const visibleIncoming = storeData.bookmarks.filter((b) => visibleOnBranch(b, curBranch));
  const hiddenIncoming = storeData.bookmarks.filter((b) => !visibleOnBranch(b, curBranch));
  const files = [...new Set([...storeData.symbols.map((m) => m.file), ...visibleIncoming.map((b) => b.file)])];
  const present = new Map<string, boolean>();
  for (const f of files) {
    present.set(f, await exists(deps.store.uriOf(folder, f)));
  }
  const missingCount =
    favorites(storeData).filter((m) => !present.get(m.file)).length +
    visibleIncoming.filter((b) => !present.get(b.file)).length;
  const itemCount = favorites(storeData).length + storeData.bookmarks.length || storeData.symbols.length;
  const tagColorCount = Object.keys(storeData.tagColors ?? {}).length;
  const tagColorsOnly = itemCount === 0 && tagColorCount > 0;

  const hasExisting = deps.store.hasData(folder);
  let mode: ImportMode = options.mode ?? (hasExisting ? 'merge' : 'replace');
  if (!options.confirmed) {
    const merge = vscode.l10n.t('Merge');
    const replace = vscode.l10n.t('Replace');
    const ok = vscode.l10n.t('Import');
    const detail = [
      missingCount
        ? vscode.l10n.t('{0} of them are in files that do not exist in this project; they are kept and marked as needs checking.', missingCount)
        : '',
      hiddenIncoming.length
        ? vscode.l10n.t('{0} of them are limited to another branch and will be hidden until you switch to that branch.', hiddenIncoming.length)
        : '',
      hasExisting
        ? vscode.l10n.t(
            'This workspace already has bookmarks. Merge: keep existing bookmarks and add new ones. Replace: overwrite existing bookmarks with this file.',
          )
        : tagColorsOnly
          ? ''
          : vscode.l10n.t('They are added as your own bookmarks; any bookmarks from other sources in the file are kept as-is.'),
    ]
      .filter(Boolean)
      .join('\n\n');
    const title = tagColorsOnly
      ? vscode.l10n.t('Import {0} tag color(s) from this Function Bookmarks file?', tagColorCount)
      : vscode.l10n.t('Import {0} bookmarks from this Function Bookmarks file?', itemCount);
    const pick = await vscode.window.showInformationMessage(
      title,
      { modal: true, detail: detail || undefined },
      ...(hasExisting ? [merge, replace] : [ok]),
    );
    if (!pick) {
      return undefined;
    }
    if (hasExisting) {
      mode = pick === replace ? 'replace' : 'merge';
    }
  }

  // 依本機最新內容重新定位函式標記與目前分支可見的行號書籤；限定其他分支的書籤保持原樣不破壞其位置與 anchor
  let relocatedSymbols = [...storeData.symbols];
  const relocatedBookmarks: LineBookmark[] = hiddenIncoming.map((b) => ({ ...b }));
  let lost = 0;

  for (const file of files) {
    const uri = deps.store.uriOf(folder, file);
    const src = present.get(file) ? await loadSource(uri) : undefined;
    const lines = src ? splitLines(src.text) : undefined;
    const fileSymbols = relocatedSymbols.filter((m) => m.file === file);
    const fileBookmarks = visibleIncoming.filter((b) => b.file === file);

    let detectedSymbols: DetectedSymbol[] = [];
    if (src && (fileSymbols.length > 0 || fileBookmarks.some((b) => b.symbol || b.anchor?.symbolPath))) {
      try {
        detectedSymbols = (await service.getForSource(src)).symbols;
      } catch {
        // 偵測失敗：函式標記維持原記錄，行號書籤改用行號與 anchor 定位
      }
    }

    // 1. 函式標記（收藏、別名、備註）
    if (fileSymbols.length > 0) {
      if (lines) {
        relocatedSymbols = reconcileFile({ version: 1, symbols: relocatedSymbols, bookmarks: [] }, file, detectedSymbols).symbols;
        for (const m of relocatedSymbols.filter((x) => x.file === file && x.favorite)) {
          if (!findByPath(detectedSymbols, m.path, m.kind)) {
            lost++;
          }
        }
      } else {
        lost += fileSymbols.filter((m) => m.favorite).length;
      }
    }

    // 2. 行號書籤（含檔案中原本保存的他方來源書籤）
    if (!lines) {
      for (const b of fileBookmarks) {
        relocatedBookmarks.push({ ...b, status: 'lost' });
        lost++;
      }
      continue;
    }

    const placed = new Map<string, { line: number; lost: boolean }>();
    const byLine: LineBookmark[] = [];
    for (const b of fileBookmarks) {
      const sym = b.symbol ? findByPath(detectedSymbols, b.symbol.path, b.symbol.kind) : undefined;
      if (sym) {
        placed.set(b.id, { line: sym.nameLine, lost: false });
      } else {
        byLine.push(b);
      }
    }
    const withAnchor = byLine.filter((b) => b.anchor);
    if (withAnchor.length) {
      const symbolStart = (p: string) => findByPath(detectedSymbols, p)?.startLine;
      for (const r of relocateBookmarks(withAnchor, undefined, lines, symbolStart)) {
        placed.set(r.id, { line: r.line, lost: r.status === 'lost' });
      }
    }
    for (const b of byLine.filter((x) => !x.anchor)) {
      if (b.line < lines.length) {
        placed.set(b.id, { line: b.line, lost: false });
      } else {
        placed.set(b.id, { line: Math.max(0, lines.length - 1), lost: true });
      }
    }

    for (const b of fileBookmarks) {
      const p = placed.get(b.id) ?? { line: b.line, lost: true };
      const next: LineBookmark = { ...b, line: p.line };
      // 目前分支的位置已重新對齊本機內容，清掉該分支過期的舊 positions 紀錄（其他分支的紀錄保留）
      if (curBranch && next.positions && Object.prototype.hasOwnProperty.call(next.positions, curBranch)) {
        const rest = { ...next.positions };
        delete rest[curBranch];
        if (Object.keys(rest).length) {
          next.positions = rest;
        } else {
          delete next.positions;
        }
      }
      if (p.lost) {
        next.status = 'lost';
        lost++;
      } else {
        delete next.status;
        if (p.line < lines.length) {
          const symPath = next.symbol?.path ?? next.anchor?.symbolPath;
          const sym = symPath ? findByPath(detectedSymbols, symPath, next.symbol?.kind) : undefined;
          next.anchor = makeAnchor(lines, p.line, sym?.path ?? symPath, sym?.startLine);
        }
      }
      relocatedBookmarks.push(next);
    }
  }

  const relocated: StoreData = {
    version: 1,
    symbols: relocatedSymbols,
    bookmarks: relocatedBookmarks,
    ...(storeData.tagColors ? { tagColors: storeData.tagColors } : {}),
  };

  // 多資料夾工作區下，避開其他資料夾已經佔用的 1～9 號；replace 模式也一併去除檔案內部的重複號碼
  const otherFolderNumbers = new Set<number>();
  const targetFolderKey = uriKey(folder.uri);
  for (const [n, entry] of deps.store.numbered()) {
    if (uriKey(entry.folder.uri) !== targetFolderKey) {
      otherFolderNumbers.add(n);
    }
  }
  await deps.store.update(folder, (cur) =>
    mode === 'merge'
      ? mergeStoreData(cur, relocated, otherFolderNumbers)
      : dedupeStoreNumbers(relocated, otherFolderNumbers),
  );
  // 若匯入的正是另一端存放位置的資料（例如 workspaceState 模式下直接匯入 .vscode/function-bookmarks.json），
  // 記為已處理，避免之後清空或重開又重複提示複製
  await deps.store.markOppositeHandledIfMatches(folder, storeData, sourceUri);

  const foreignAuthors = [...new Set(relocatedBookmarks.map((b) => b.source?.author).filter((a): a is string => !!a))];
  if (foreignAuthors.length) {
    deps.store.showSources(foreignAuthors);
  }

  const importedCount = favorites(relocated).length + relocated.bookmarks.length || relocated.symbols.length;
  const hiddenCount = hiddenIncoming.length;
  const infoMsg = tagColorsOnly
    ? vscode.l10n.t('Imported {0} tag color(s).', tagColorCount)
    : lost && hiddenCount
      ? vscode.l10n.t('Imported {0} bookmarks ({1} need checking, {2} hidden on this branch).', importedCount, lost, hiddenCount)
      : hiddenCount
        ? vscode.l10n.t('Imported {0} bookmarks ({1} hidden on this branch).', importedCount, hiddenCount)
        : lost
          ? vscode.l10n.t('Imported {0} bookmarks ({1} need checking).', importedCount, lost)
          : vscode.l10n.t('Imported {0} bookmarks.', importedCount);
  void vscode.window.showInformationMessage(infoMsg);
  return {
    format: 'store',
    imported: importedCount,
    lost,
    missingFiles: missingCount,
    mode,
    ...(hiddenCount ? { hiddenOnBranch: hiddenCount } : {}),
    ...(tagColorCount ? { tagColors: tagColorCount } : {}),
  };
}

/**
 * 匯入別人匯出的書籤：輸入來源註記、預覽、同來源取代或合併，並依本機的檔案內容重新定位：
 * 有行雜湊就比對差異換算；沒有就用 anchor 後備定位；函式書籤用名稱重新找；都找不到標成需確認。
 * 也自動辨識套件自己的書籤檔（.vscode/function-bookmarks.json）與 alefragnani Bookmarks 的 .vscode/bookmarks.json。
 */
export async function importBookmarks(
  deps: ShareDeps,
  service: SymbolService,
  options: ImportOptions = {},
): Promise<ImportResult | StoreImportResult | AlefragnaniImportResult | undefined> {
  const input = await readText(deps, options);
  if (input === undefined) {
    return undefined;
  }
  const text = stripBom(input.text);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const pickFolder = async () =>
    options.folder ??
    (input.uri ? vscode.workspace.getWorkspaceFolder(input.uri) : undefined) ??
    (folders.length > 1 ? await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('Import into which folder?') }) : folders[0]);
  const parsed = parseExport(text);
  if ('error' in parsed) {
    if (parsed.error === 'format') {
      // 支援套件自己的書籤檔（.vscode/function-bookmarks.json）
      const storeData = parseStoreFileImport(text);
      if (storeData) {
        const folder = await pickFolder();
        if (!folder) {
          return undefined;
        }
        if (input.uri && deps.store.isActiveBookmarksFile(folder, input.uri)) {
          void vscode.window.showInformationMessage(
            vscode.l10n.t('This file is already the active bookmarks file for this workspace. No import is needed.'),
          );
          return { format: 'store', imported: 0, lost: 0, missingFiles: 0, mode: 'merge', alreadyActive: true };
        }
        return importStoreData(deps, service, folder, storeData, options, input.uri);
      }
      // 也支援 alefragnani Bookmarks 的 .vscode/bookmarks.json（自己在舊套件加的書籤，匯入成自己的）
      const old = parseAlefragnani(JSON.parse(text));
      if (old.length) {
        const folder = await pickFolder();
        return folder ? importAlefragnaniItems(deps.store, service, folder, old, options.confirmed) : undefined;
      }
    }
    void vscode.window.showErrorMessage(
      parsed.error === 'json'
        ? vscode.l10n.t('This is not valid JSON.')
        : vscode.l10n.t('This file does not match the Function Bookmarks bookmark format.'),
    );
    return undefined;
  }
  if (!parsed.bookmarks.length) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There are no bookmarks to import.'));
    return undefined;
  }
  const folder = await pickFolder();
  if (!folder) {
    return undefined;
  }

  // 1. 不是同一個專案時提醒
  if (!options.confirmed && parsed.repo?.remote) {
    const gitDir = await deps.branches.gitDirOf(folder);
    const local = gitDir ? normalizeRemote(await readRemoteUrl(gitDir)) : undefined;
    const theirs = normalizeRemote(parsed.repo.remote);
    if (local && theirs && local !== theirs) {
      const go = vscode.l10n.t('Import anyway');
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t('These bookmarks were exported from another repository ({0}).', theirs),
        { modal: true },
        go,
      );
      if (pick !== go) {
        return undefined;
      }
    }
  }

  // 2. 來源註記
  let author = options.author?.trim();
  if (!author) {
    author = (
      await vscode.window.showInputBox({
        title: vscode.l10n.t('Who are these bookmarks from?'),
        prompt: vscode.l10n.t('A source note, e.g. alex.chen. Bookmarks with the same note are treated as one source and can be filtered.'),
        value: parsed.exportedBy,
        validateInput: (v) => (v.trim() ? undefined : vscode.l10n.t('Enter a source note.')),
      })
    )?.trim();
  }
  if (!author) {
    return undefined;
  }
  const authorOf = (b: ExportedBookmark) => b.author ?? author!;

  // 3. 預覽與同來源處理方式
  const files = [...new Set(parsed.bookmarks.map((b) => b.file))];
  const present = new Map<string, boolean>();
  for (const f of files) {
    present.set(f, await exists(deps.store.uriOf(folder, f)));
  }
  const missingCount = parsed.bookmarks.filter((b) => !present.get(b.file)).length;
  const authors = [...new Set(parsed.bookmarks.map(authorOf))];
  const data = deps.store.allBookmarks({ includeHidden: true }).filter((e) => e.folder.uri.toString() === folder.uri.toString());
  const before = existingCounts({ version: 1, symbols: [], bookmarks: data.map((e) => e.bookmark) }, authors);
  let mode = options.mode ?? 'replace';
  if (!options.confirmed) {
    const replace = vscode.l10n.t('Replace');
    const merge = vscode.l10n.t('Merge');
    const ok = vscode.l10n.t('Import');
    const prevTotal = [...before.values()].reduce((a, b) => a + b, 0);
    const detail = [
      missingCount ? vscode.l10n.t('{0} of them are in files that do not exist in this project; they are kept and marked as needs checking.', missingCount) : '',
      prevTotal
        ? vscode.l10n.t('{0} bookmarks from {1} were imported before. Replace: remove them and use these. Merge: update the same bookmarks and add new ones.', prevTotal, [...before.keys()].join(', '))
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t('Import {0} bookmarks from {1}?', parsed.bookmarks.length, author),
      { modal: true, detail: detail || undefined },
      ...(prevTotal ? [replace, merge] : [ok]),
    );
    if (!pick) {
      return undefined;
    }
    mode = pick === merge ? 'merge' : 'replace';
  }

  // 4. 依本機內容重新定位
  const importId = newBookmarkId();
  const importedAt = new Date().toISOString();
  const created: LineBookmark[] = [];
  for (const file of files) {
    const items = parsed.bookmarks.filter((b) => b.file === file);
    const uri = deps.store.uriOf(folder, file);
    const src = present.get(file) ? await loadSource(uri) : undefined;
    const lines = src ? splitLines(src.text) : undefined;
    let symbols: DetectedSymbol[] = [];
    if (src && items.some((b) => b.kind === 'symbol' || b.anchor?.symbolPath)) {
      try {
        symbols = (await service.getForSource(src)).symbols;
      } catch {
        // 偵測失敗：函式書籤改用行號定位
      }
    }
    const hashesText = parsed.files?.[file]?.hashes;
    const theirHashes = hashesText ? decodeHashes(hashesText) : undefined;
    const placed = new Map<string, { line: number; lost: boolean }>();
    const byLine: ExportedBookmark[] = [];
    for (const b of items) {
      const sym = b.kind === 'symbol' && b.path ? findByPath(symbols, b.path, b.symbolKind) : undefined;
      if (sym) {
        placed.set(b.id, { line: sym.nameLine, lost: false });
      } else {
        byLine.push(b);
      }
    }
    if (lines) {
      const withInfo = byLine.filter((b) => b.anchor || theirHashes);
      const symbolStart = (p: string) => findByPath(symbols, p)?.startLine;
      for (const r of relocateBookmarks(withInfo.map((b) => ({ id: b.id, line: b.line, anchor: b.anchor })), theirHashes, lines, symbolStart)) {
        placed.set(r.id, { line: r.line, lost: r.status === 'lost' });
      }
      // 不含程式碼內容的匯出：只能照行號
      for (const b of byLine.filter((x) => !x.anchor && !theirHashes)) {
        placed.set(b.id, { line: Math.min(b.line, Math.max(0, lines.length - 1)), lost: false });
      }
    }
    for (const b of items) {
      const p = placed.get(b.id) ?? { line: b.line, lost: true };
      const bm: LineBookmark = {
        id: newBookmarkId(),
        file,
        line: p.line,
        source: { author: authorOf(b), importId, originalId: b.id, importedAt },
        createdAt: b.createdAt ?? importedAt,
      };
      if (b.label) {
        bm.label = b.label;
      }
      if (b.tags?.length) {
        bm.tags = b.tags;
      }
      if (b.note) {
        bm.note = b.note;
      }
      if (b.kind === 'symbol' && b.path) {
        bm.symbol = { path: b.path, kind: b.symbolKind ?? 'function' };
      }
      if (lines && !p.lost && p.line < lines.length) {
        const symPath = bm.symbol?.path ?? b.anchor?.symbolPath;
        const sym = symPath ? findByPath(symbols, symPath, bm.symbol?.kind) : undefined;
        bm.anchor = makeAnchor(lines, p.line, sym?.path ?? symPath, sym?.startLine);
      } else if (b.anchor) {
        bm.anchor = b.anchor;
      }
      if (p.lost) {
        bm.status = 'lost';
      }
      created.push(bm);
    }
  }
  await deps.store.update(folder, (d) => applyImport(d, created, mode));
  const lost = created.filter((b) => b.status === 'lost').length;
  deps.store.showSources(authors);
  void vscode.window.showInformationMessage(
    lost
      ? vscode.l10n.t('Imported {0} bookmarks from {1} ({2} need checking).', created.length, author, lost)
      : vscode.l10n.t('Imported {0} bookmarks from {1}.', created.length, author),
  );
  return { author, imported: created.length, lost, missingFiles: missingCount, mode };
}
