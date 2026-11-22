import * as vscode from 'vscode';
import { findByPath } from '../detection/engine';
import { DetectedSymbol } from '../detection/types';
import { LineBookmark, makeAnchor, newBookmarkId } from '../bookmarks/model';
import { relocateBookmarks, splitLines } from '../bookmarks/relocate';
import { readRemoteUrl } from '../git/branch';
import { loadSource } from '../symbols/documentSource';
import { SymbolService } from '../symbols/symbolService';
import { parseAlefragnani } from '../bookmarks/alefragnani';
import { AlefragnaniImportResult, importAlefragnaniItems } from '../bookmarks/importAlefragnani';
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

/** 讀取要匯入的內容；從檔案時一併回傳檔案位置（用來決定匯入到哪個資料夾）。 */
async function readText(options: ImportOptions): Promise<{ text: string; uri?: vscode.Uri } | undefined> {
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
    // 專案裡有 alefragnani Bookmarks 的書籤檔時，直接開在 .vscode 資料夾
    let defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (await exists(vscode.Uri.joinPath(f.uri, '.vscode', 'bookmarks.json'))) {
        defaultUri = vscode.Uri.joinPath(f.uri, '.vscode', 'bookmarks.json');
        break;
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
 * 匯入別人匯出的書籤：輸入來源註記、預覽、同來源取代或合併，並依本機的檔案內容重新定位：
 * 有行雜湊就比對差異換算；沒有就用 anchor 後備定位；函式書籤用名稱重新找；都找不到標成需確認。
 */
export async function importBookmarks(
  deps: ShareDeps,
  service: SymbolService,
  options: ImportOptions = {},
): Promise<ImportResult | AlefragnaniImportResult | undefined> {
  const input = await readText(options);
  if (input === undefined) {
    return undefined;
  }
  const { text } = input;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const pickFolder = async () =>
    options.folder ??
    (input.uri ? vscode.workspace.getWorkspaceFolder(input.uri) : undefined) ??
    (folders.length > 1 ? await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('Import into which folder?') }) : folders[0]);
  const parsed = parseExport(text);
  if ('error' in parsed) {
    // 也支援 alefragnani Bookmarks 的 .vscode/bookmarks.json（自己在舊套件加的書籤，匯入成自己的）
    if (parsed.error === 'format') {
      const old = parseAlefragnani(JSON.parse(text));
      if (old.length) {
        const folder = await pickFolder();
        return folder ? importAlefragnaniItems(deps.store, service, folder, old, options.confirmed) : undefined;
      }
    }
    void vscode.window.showErrorMessage(
      parsed.error === 'json'
        ? vscode.l10n.t('This is not valid JSON.')
        : vscode.l10n.t('This is not a Function Bookmarks export or a .vscode/bookmarks.json of the Bookmarks extension (alefragnani).'),
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
    if (src && items.some((b) => b.kind === 'symbol')) {
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
      for (const r of relocateBookmarks(withInfo.map((b) => ({ id: b.id, line: b.line, anchor: b.anchor })), theirHashes, lines)) {
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
        createdAt: importedAt,
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
        const sym = bm.symbol ? findByPath(symbols, bm.symbol.path, bm.symbol.kind) : undefined;
        bm.anchor = makeAnchor(lines, p.line, sym?.path ?? b.anchor?.symbolPath, sym?.startLine);
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
