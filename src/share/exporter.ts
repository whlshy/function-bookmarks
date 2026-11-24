import * as os from 'os';
import * as vscode from 'vscode';
import { bookmarkTitle } from '../bookmarks/commands';
import { LineBookmark, makeAnchor } from '../bookmarks/model';
import { hashLine, splitLines } from '../bookmarks/relocate';
import { SECTION } from '../config';
import { findByPath } from '../detection/engine';
import { readHeadCommit, readRemoteUrl, readUserName } from '../git/branch';
import { BranchService } from '../git/branchService';
import { MarkStore } from '../storage/store';
import { loadSource } from '../symbols/documentSource';
import { FavoritesModel } from '../symbols/favorites';
import { SymbolService } from '../symbols/symbolService';
import { languageForPath } from '../util/paths';
import {
  encodeHashes,
  EXPORT_FORMAT,
  ExportedBookmark,
  ExportFile,
  ExportRow,
  extractFunctionSnippet,
  extractLineSnippet,
  GuideEntry,
  GuideSnippet,
  toCsv,
  toGuideMarkdown,
  toMarkdown,
} from './format';

export interface ShareDeps {
  store: MarkStore;
  favorites: FavoritesModel;
  branches: BranchService;
  service?: SymbolService;
}

export type ExportScope =
  | { kind: 'all' }
  | { kind: 'tag'; tag: string }
  | { kind: 'path'; rel: string }
  | { kind: 'pick'; ids: string[] };

export type ExportFormat = 'json' | 'markdown' | 'guide' | 'csv';

export interface ExportOptions {
  folder?: vscode.WorkspaceFolder;
  scope?: ExportScope;
  /** 也匯出從別人匯入的書籤（預設不含，避免轉來轉去）。 */
  includeImported?: boolean;
  format?: ExportFormat;
  includeCode?: boolean;
  /** clipboard、要寫入的檔案；沒給時詢問。 */
  target?: 'clipboard' | vscode.Uri;
}

interface Candidate {
  id: string;
  file: string;
  line: number;
  title: string;
  tags: string[];
  imported: boolean;
  number?: number;
  line_?: LineBookmark;
  symbol?: { path: string; kind: string; alias?: string; note?: string; startLine?: number; endLine?: number };
}

/** 匯出者名稱：設定 → git user.name → 系統使用者名稱。 */
export async function authorName(deps: ShareDeps, folder: vscode.WorkspaceFolder): Promise<string> {
  const configured = vscode.workspace.getConfiguration(SECTION, folder.uri).get<string>('authorName', '').trim();
  if (configured) {
    return configured;
  }
  const fromGit = await readUserName(await deps.branches.gitDirOf(folder), os.homedir());
  if (fromGit) {
    return fromGit;
  }
  try {
    return os.userInfo().username;
  } catch {
    return 'me';
  }
}

function candidates(deps: ShareDeps, folder: vscode.WorkspaceFolder): Candidate[] {
  const out: Candidate[] = [];
  for (const e of deps.store.allBookmarks()) {
    if (e.folder.uri.toString() !== folder.uri.toString()) {
      continue;
    }
    const b = e.bookmark;
    out.push({ id: b.id, file: b.file, line: b.line, title: bookmarkTitle(b), tags: b.tags ?? [], imported: !!b.source, number: b.number, line_: b });
  }
  for (const f of deps.favorites.all) {
    if (f.folder.uri.toString() !== folder.uri.toString()) {
      continue;
    }
    const m = f.mark;
    out.push({
      id: `fn:${m.file}:${m.kind}:${m.path}`,
      file: m.file,
      line: f.symbol?.nameLine ?? m.line ?? 0,
      title: m.alias ?? m.path.split('.').pop() ?? m.path,
      tags: m.tags ?? [],
      imported: false,
      number: m.number,
      symbol: {
        path: m.path,
        kind: m.kind,
        alias: m.alias,
        note: m.note,
        startLine: f.symbol?.startLine,
        endLine: f.symbol?.endLine,
      },
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function inScope(c: Candidate, scope: ExportScope): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'tag':
      return c.tags.includes(scope.tag);
    case 'path':
      return !scope.rel || c.file === scope.rel || c.file.startsWith(`${scope.rel}/`);
    case 'pick':
      return scope.ids.includes(c.id);
  }
}

async function pickFolder(deps: ShareDeps, uri?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (uri) {
    return vscode.workspace.getWorkspaceFolder(uri);
  }
  const withMarks = folders.filter((f) => candidates(deps, f).length);
  if (withMarks.length <= 1) {
    return withMarks[0] ?? folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('Export bookmarks of which folder?') });
}

async function askScope(deps: ShareDeps, folder: vscode.WorkspaceFolder, all: Candidate[]): Promise<ExportScope | undefined> {
  const tags = [...new Set(all.flatMap((c) => c.tags))].sort();
  const editor = vscode.window.activeTextEditor;
  const cur = editor ? deps.store.locate(editor.document.uri) : undefined;
  type Item = vscode.QuickPickItem & { scope?: ExportScope; action?: 'tag' | 'pick' };
  const items: Item[] = [
    { label: `$(bookmark) ${vscode.l10n.t('All bookmarks')}`, description: String(all.length), scope: { kind: 'all' } },
  ];
  if (tags.length) {
    items.push({ label: `$(tag) ${vscode.l10n.t('By tag…')}`, action: 'tag' });
  }
  if (cur && cur.folder.uri.toString() === folder.uri.toString()) {
    items.push({ label: `$(file) ${vscode.l10n.t('Current file')}`, description: cur.rel, scope: { kind: 'path', rel: cur.rel } });
  }
  items.push({ label: `$(checklist) ${vscode.l10n.t('Choose bookmarks…')}`, action: 'pick' });
  const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Export bookmarks'), placeHolder: vscode.l10n.t('What to export') });
  if (!pick) {
    return undefined;
  }
  if (pick.scope) {
    return pick.scope;
  }
  if (pick.action === 'tag') {
    const t = await vscode.window.showQuickPick(tags.map((x) => `#${x}`), { title: vscode.l10n.t('Export bookmarks with tag') });
    return t ? { kind: 'tag', tag: t.slice(1) } : undefined;
  }
  const chosen = await vscode.window.showQuickPick(
    all.map((c) => ({ label: `${c.symbol ? '$(symbol-function)' : '$(bookmark)'} ${c.title}`, description: `${c.file}:${c.line + 1}`, id: c.id })),
    { canPickMany: true, title: vscode.l10n.t('Choose bookmarks to export') },
  );
  return chosen?.length ? { kind: 'pick', ids: chosen.map((c) => c.id) } : undefined;
}

/** 匯出書籤（行號書籤＋函式書籤）。回傳匯出的筆數與內容。 */
export async function exportBookmarks(
  deps: ShareDeps,
  options: ExportOptions = {},
  uriArg?: vscode.Uri,
): Promise<{ count: number; text: string } | undefined> {
  const folder = options.folder ?? (await pickFolder(deps, uriArg));
  if (!folder) {
    return undefined;
  }
  const all = candidates(deps, folder);
  if (!all.length) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No bookmarks yet.'));
    return undefined;
  }
  const scope =
    options.scope ?? (uriArg ? { kind: 'path' as const, rel: deps.store.locate(uriArg)?.rel ?? '' } : await askScope(deps, folder, all));
  if (!scope) {
    return undefined;
  }
  let list = all.filter((c) => inScope(c, scope));
  let includeImported = options.includeImported;
  if (includeImported === undefined && list.some((c) => c.imported)) {
    const mineOnly = vscode.l10n.t('Only mine (recommended)');
    const pick = await vscode.window.showQuickPick([mineOnly, vscode.l10n.t('Also bookmarks imported from others')], {
      title: vscode.l10n.t('Export bookmarks'),
    });
    if (!pick) {
      return undefined;
    }
    includeImported = pick !== mineOnly;
  }
  list = list.filter((c) => includeImported || !c.imported);
  if (!list.length) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No bookmarks to export.'));
    return undefined;
  }
  let format = options.format;
  let target = options.target;
  if (!format) {
    type F = vscode.QuickPickItem & { format: ExportFormat; target?: 'clipboard' };
    const picks: F[] = [
      { label: `$(save) ${vscode.l10n.t('Save to file')}`, description: '*.fbookmarks.json', detail: vscode.l10n.t('Can be imported by others'), format: 'json' },
      { label: `$(clippy) ${vscode.l10n.t('Copy to clipboard')}`, detail: vscode.l10n.t('Can be imported by others; paste it into a chat'), format: 'json', target: 'clipboard' },
      { label: `$(book) ${vscode.l10n.t('Walkthrough document (Markdown)')}`, detail: vscode.l10n.t('Ordered by number with code snippets and notes, saved as a Markdown file'), format: 'guide' },
      { label: `$(markdown) ${vscode.l10n.t('Markdown table')}`, detail: vscode.l10n.t('Copied to the clipboard, e.g. for a pull request description'), format: 'markdown', target: 'clipboard' },
      { label: `$(table) ${vscode.l10n.t('CSV file')}`, detail: vscode.l10n.t('Opens in Excel'), format: 'csv' },
    ];
    const p = await vscode.window.showQuickPick(picks, { title: vscode.l10n.t('Export {0} bookmarks', list.length) });
    if (!p) {
      return undefined;
    }
    format = p.format;
    target = target ?? p.target;
  }
  let includeCode = options.includeCode;
  if (includeCode === undefined) {
    const yes = vscode.l10n.t('Include code');
    const no = vscode.l10n.t('Without code');
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t('The export contains the code of each bookmarked line and the lines around it.'),
      {
        modal: true,
        detail:
          format === 'json'
            ? vscode.l10n.t('Do not share it outside your team if the code is confidential. Without code, bookmarks are placed by line number only when imported.')
            : vscode.l10n.t('Do not share it outside your team if the code is confidential.'),
      },
      yes,
      no,
    );
    if (!pick) {
      return undefined;
    }
    includeCode = pick === yes;
  }

  // 依目前內容重新計算每個檔案的行雜湊與 anchor，確保兩者一致
  const contents = new Map<string, string[] | undefined>();
  for (const file of new Set(list.map((c) => c.file))) {
    const src = await loadSource(deps.store.uriOf(folder, file));
    contents.set(file, src ? splitLines(src.text) : undefined);
  }
  const lineOk = (c: Candidate) => !c.line_?.status;
  const text =
    format === 'json'
      ? JSON.stringify(await buildJson(deps, folder, list, contents, includeCode, lineOk), null, 2) + '\n'
      : format === 'guide'
        ? await buildGuide(deps, folder, list, contents, includeCode)
        : buildTable(list, contents, includeCode, format);

  if (!target) {
    const ext = format === 'json' ? 'fbookmarks.json' : format === 'markdown' || format === 'guide' ? 'md' : 'csv';
    const name = format === 'guide' ? `${folder.name}-guide.${ext}` : `${folder.name}-bookmarks.${ext}`;
    target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder.uri, name),
      filters: format === 'json' ? { 'Function Bookmarks': ['json'] } : format === 'markdown' || format === 'guide' ? { Markdown: ['md'] } : { CSV: ['csv'] },
    });
    if (!target) {
      return undefined;
    }
  }
  if (target === 'clipboard') {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(vscode.l10n.t('Copied {0} bookmarks to the clipboard.', list.length));
  } else {
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    void vscode.window.showInformationMessage(vscode.l10n.t('Exported {0} bookmarks to {1}.', list.length, vscode.workspace.asRelativePath(target)));
  }
  return { count: list.length, text };
}

async function buildJson(
  deps: ShareDeps,
  folder: vscode.WorkspaceFolder,
  list: Candidate[],
  contents: Map<string, string[] | undefined>,
  includeCode: boolean,
  lineOk: (c: Candidate) => boolean,
): Promise<ExportFile> {
  const gitDir = await deps.branches.gitDirOf(folder);
  const bookmarks: ExportedBookmark[] = list.map((c) => {
    const lines = contents.get(c.file);
    const e: ExportedBookmark = { kind: c.symbol ? 'symbol' : 'line', id: c.id, file: c.file, line: c.line };
    const label = c.symbol ? c.symbol.alias : c.line_?.label;
    if (label) {
      e.label = label;
    }
    if (c.tags.length) {
      e.tags = c.tags;
    }
    const note = c.symbol ? c.symbol.note : c.line_?.note;
    if (note) {
      e.note = note;
    }
    if (c.symbol) {
      e.path = c.symbol.path;
      e.symbolKind = c.symbol.kind;
    } else if (c.line_?.symbol) {
      // 從別人匯入的函式書籤，轉出去時仍是函式書籤
      e.kind = 'symbol';
      e.path = c.line_.symbol.path;
      e.symbolKind = c.line_.symbol.kind;
    }
    if (c.line_?.source) {
      e.author = c.line_.source.author;
    }
    if (includeCode) {
      if (lines && lineOk(c) && c.line < lines.length) {
        const old = c.line_?.anchor;
        e.anchor = makeAnchor(lines, c.line, old?.symbolPath ?? c.symbol?.path, undefined);
        if (old?.symbolOffset !== undefined) {
          e.anchor.symbolOffset = old.symbolOffset;
        }
      } else if (c.line_?.anchor) {
        e.anchor = c.line_.anchor;
      }
    }
    return e;
  });
  const files: Record<string, { hashes: string }> = {};
  if (includeCode) {
    for (const [file, lines] of contents) {
      if (lines) {
        files[file] = { hashes: encodeHashes(lines.map(hashLine)) };
      }
    }
  }
  const branch = deps.branches.current(folder);
  return {
    format: EXPORT_FORMAT,
    exportedBy: await authorName(deps, folder),
    exportedAt: new Date().toISOString(),
    repo: gitDir
      ? { remote: await readRemoteUrl(gitDir), branch: branch?.name, commit: await readHeadCommit(gitDir) }
      : undefined,
    includesCode: includeCode,
    ...(includeCode ? { files } : {}),
    bookmarks,
  };
}

function buildTable(list: Candidate[], contents: Map<string, string[] | undefined>, includeCode: boolean, format: ExportFormat): string {
  const rows: ExportRow[] = list.map((c) => {
    const lines = contents.get(c.file);
    const row: ExportRow = {
      file: c.file,
      line: c.line + 1,
      name: c.title,
      kind: c.symbol || c.line_?.symbol ? 'symbol' : 'line',
      tags: c.tags,
      note: c.symbol ? c.symbol.note : c.line_?.note,
      source: c.line_?.source?.author,
    };
    if (includeCode) {
      row.code = lines?.[c.line]?.trim() ?? c.line_?.anchor?.text ?? '';
    }
    return row;
  });
  const labels = {
    file: vscode.l10n.t('File'),
    line: vscode.l10n.t('Line'),
    name: vscode.l10n.t('Name'),
    kind: vscode.l10n.t('Kind'),
    tags: vscode.l10n.t('Tags'),
    note: vscode.l10n.t('Note'),
    code: vscode.l10n.t('Code'),
    source: vscode.l10n.t('Source'),
    fn: vscode.l10n.t('function'),
    lineKind: vscode.l10n.t('line'),
  };
  return format === 'markdown' ? toMarkdown(rows, labels) : toCsv(rows, labels);
}

/** 產出「導讀文件（Markdown）」：函式書籤取函式本體（最多 30 行），行號書籤取前後各 3 行。 */
async function buildGuide(
  deps: ShareDeps,
  folder: vscode.WorkspaceFolder,
  list: Candidate[],
  contents: Map<string, string[] | undefined>,
  includeCode: boolean,
): Promise<string> {
  const entries: GuideEntry[] = [];
  for (const c of list) {
    const lines = contents.get(c.file);
    let snippet: GuideSnippet | undefined;
    if (includeCode && lines) {
      const symTarget = c.symbol ?? c.line_?.symbol;
      if (symTarget) {
        let startLine = c.symbol?.startLine;
        let endLine = c.symbol?.endLine;
        if ((startLine === undefined || endLine === undefined) && deps.service) {
          const parsed = await deps.service.getForUri(deps.store.uriOf(folder, c.file)).catch(() => undefined);
          const found = parsed && findByPath(parsed.symbols, symTarget.path, symTarget.kind);
          if (found) {
            startLine = found.startLine;
            endLine = found.endLine;
          }
        }
        snippet =
          startLine !== undefined && endLine !== undefined
            ? extractFunctionSnippet(lines, startLine, endLine)
            : extractLineSnippet(lines, c.line);
      } else {
        snippet = extractLineSnippet(lines, c.line);
      }
    }
    entries.push({
      number: c.number,
      name: c.title,
      file: c.file,
      line: c.line + 1,
      tags: c.tags,
      note: c.symbol ? c.symbol.note : c.line_?.note,
      source: c.line_?.source?.author,
      language: languageForPath(c.file),
      snippet,
    });
  }
  return toGuideMarkdown(entries, {
    title: vscode.l10n.t('{0} — Walkthrough', folder.name),
    omittedLabel: (n) => vscode.l10n.t('… ({0} more line(s) omitted)', n),
  });
}
