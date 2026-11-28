/**
 * CLI 的指令：給 AI 助理（透過 Skill）在編輯器外查詢、新增、修改書籤。
 * 輸出英文（AI 讀得懂、也不必依編輯器語系）；行號一律從 1 開始，與編輯器顯示相同。
 */
import * as path from 'path';
import { parseTags } from '../bookmarks/model';
import { guideEntries, itemFromBookmark, itemFromFavorite } from '../core/exportItems';
import { newLineBookmark, symbolAtNameLine } from '../core/resolve';
import { findByPath } from '../detection/engine';
import { DetectedSymbol } from '../detection/types';
import { ExportStatus, extractFunctionSnippet, extractLineSnippet, toGuideMarkdown } from '../share/format';
import {
  addBookmark,
  findMark,
  MarkKey,
  removeBookmarks,
  setAlias,
  setFavorite,
  setNote,
  setSymbolExtras,
  setTags,
  StoreData,
  updateBookmark,
  validNumber,
} from '../storage/marks';
import { CliError, findProjectRoot, functionRef, Project, ResolvedItem } from './project';

export interface CliIO {
  cwd: string;
  /** 已知的專案根目錄（複製到專案 skills 資料夾的 CLI 由自己的位置得知）；--root 優先。 */
  root?: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

export const USAGE = `Function Bookmarks CLI — read and change the bookmarks of this project.
Line numbers start at 1. A <ref> is a number 1-9, a bookmark id, <file>#<Function.path> or <file>:<line>.

  fb info                                 project root, bookmarks file, branch, counts
  fb list [--file <path>] [--tag <tag>] [--query <text>]
                                          bookmarks with their current position
  fb show <ref>                           one bookmark with its note and code
  fb functions <file>                     functions detected in a file (to pick one to bookmark)
  fb add <file>#<Function.path> | <file>:<line> [--label <text>] [--note <text>] [--tags a,b] [--number <1-9>] [--line]
                                          add a bookmark; on a line with a function name it bookmarks the
                                          function (like the editor), --line forces a line bookmark
  fb set <ref> [--label <text>] [--note <text>] [--append-note <text>] [--tags a,b] [--add-tag t] [--remove-tag t] [--number <1-9|0>]
                                          change a bookmark; an empty --label or --note clears it, --number 0 removes the number
  fb remove <ref>                         remove a bookmark
  fb guide [--tag <tag>] [--file <path>] [--no-code]
                                          walkthrough document (Markdown): numbered bookmarks first, with notes and code

Add --json to info, list, show, functions, add, set or remove for JSON output.
Do not edit .vscode/function-bookmarks.json by hand; the editor picks up changes made with this CLI.`;

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(['json', 'line', 'no-code', 'help']);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let value: string;
      if (eq > 0) {
        value = a.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(name)) {
        value = 'true';
      } else {
        if (i + 1 >= argv.length) {
          throw new CliError(`--${name} needs a value.`);
        }
        value = argv[++i];
      }
      flags.set(name, [...(flags.get(name) ?? []), value]);
    } else if (a === '-h') {
      flags.set('help', ['true']);
    } else {
      positional.push(a);
    }
  }
  return { command: positional.shift(), positional, flags };
}

const one = (p: Parsed, name: string) => p.flags.get(name)?.at(-1);
const has = (p: Parsed, name: string) => p.flags.has(name);

const STATUS_TEXT: Record<ExportStatus, string> = {
  lost: 'needs checking',
  notOnBranch: 'not on this branch',
  missing: 'function not found',
  noFile: 'file not found',
};

function displayName(item: ResolvedItem): string {
  if (item.kind === 'function') {
    return item.mark.alias ? `${item.mark.path} "${item.mark.alias}"` : item.mark.path;
  }
  const b = item.bookmark;
  return b.label ? `"${b.label}"` : (b.anchor?.text ?? '').slice(0, 60);
}

function tagsOf(item: ResolvedItem): string[] {
  return (item.kind === 'function' ? item.mark.tags : item.bookmark.tags) ?? [];
}

function noteOf(item: ResolvedItem): string | undefined {
  return item.kind === 'function' ? item.mark.note : item.bookmark.note;
}

function numberOf(item: ResolvedItem): number | undefined {
  return item.kind === 'function' ? item.mark.number : item.bookmark.number;
}

function toJson(item: ResolvedItem) {
  return {
    ref: item.ref,
    kind: item.kind,
    file: item.file,
    line: item.line + 1,
    ...(item.kind === 'function'
      ? {
          function: item.mark.path,
          functionKind: item.mark.kind,
          name: item.mark.alias,
          endLine: item.symbol ? item.symbol.endLine + 1 : undefined,
          unverified: item.unverified || undefined,
        }
      : { name: item.bookmark.label, code: item.bookmark.anchor?.text, source: item.bookmark.source?.author }),
    number: numberOf(item),
    tags: tagsOf(item).length ? tagsOf(item) : undefined,
    note: noteOf(item),
    status: item.status ? STATUS_TEXT[item.status] : undefined,
  };
}

function listLine(item: ResolvedItem): string {
  const parts = [`${item.file}:${item.line + 1}`, item.kind === 'function' ? item.mark.kind : 'line', displayName(item)];
  const n = numberOf(item);
  if (n) {
    parts.push(`[${n}]`);
  }
  for (const t of tagsOf(item)) {
    parts.push(`#${t}`);
  }
  if (noteOf(item)) {
    parts.push('(note)');
  }
  if (item.status) {
    parts.push(`[${STATUS_TEXT[item.status]}]`);
  }
  if (item.kind === 'function' && item.unverified) {
    parts.push('[position not checked: no built-in rules for this file type]');
  }
  parts.push(`ref=${item.ref}`);
  return parts.filter(Boolean).join('  ');
}

/** 依 ref 找書籤：號碼、書籤 id、檔案#函式、檔案:行號。 */
async function findItem(project: Project, items: ResolvedItem[], ref: string, cwd: string): Promise<ResolvedItem> {
  if (/^[1-9]$/.test(ref)) {
    const hit = items.find((i) => numberOf(i) === Number(ref));
    if (hit) {
      return hit;
    }
    throw new CliError(`No bookmark has number ${ref}.`);
  }
  const byRef = items.find((i) => i.ref === ref);
  if (byRef) {
    return byRef;
  }
  const hash = ref.lastIndexOf('#');
  if (hash > 0) {
    const file = await project.relPath(ref.slice(0, hash), cwd);
    const fn = items.find((i) => i.kind === 'function' && i.file === file && i.mark.path === ref.slice(hash + 1));
    if (fn) {
      return fn;
    }
  }
  const m = /^(.*):(\d+)$/.exec(ref);
  if (m) {
    const file = await project.relPath(m[1], cwd);
    const line = Number(m[2]) - 1;
    const atLine = items.filter((i) => i.file === file && i.line === line);
    if (atLine.length) {
      return atLine.find((i) => i.kind === 'line') ?? atLine[0];
    }
  }
  throw new CliError(`No bookmark matches "${ref}". Run "fb list" to see the refs.`);
}

function flatten(list: DetectedSymbol[], depth = 0, out: { s: DetectedSymbol; depth: number }[] = []) {
  for (const s of list) {
    if (s.kind !== 'reference') {
      out.push({ s, depth });
    }
    flatten(s.children, depth + 1, out);
  }
  return out;
}

function usedNumbers(data: StoreData, except?: { bookmarkId?: string; key?: MarkKey }): Map<number, string> {
  const out = new Map<number, string>();
  for (const b of data.bookmarks ?? []) {
    if (b.number && b.id !== except?.bookmarkId) {
      out.set(b.number, b.id);
    }
  }
  for (const m of data.symbols) {
    const same = except?.key && m.file === except.key.file && m.path === except.key.path && m.kind === except.key.kind;
    if (m.number && !same) {
      out.set(m.number, functionRef(m.file, m.path));
    }
  }
  return out;
}

function parseNumber(p: Parsed, data: StoreData, except?: { bookmarkId?: string; key?: MarkKey }): number | null | undefined {
  const raw = one(p, 'number');
  if (raw === undefined) {
    return undefined;
  }
  if (raw === '0' || raw === '') {
    return null;
  }
  const n = Number(raw);
  if (!validNumber(n)) {
    throw new CliError('--number must be 1-9 (or 0 to remove it).');
  }
  const owner = usedNumbers(data, except).get(n);
  if (owner) {
    throw new CliError(`Number ${n} is already used by ${owner}. Remove it there first ("fb set ${owner} --number 0").`);
  }
  return n;
}

function tagsFlag(p: Parsed): string[] | undefined {
  const list = p.flags.get('tags');
  return list ? parseTags(list.join(',')) : undefined;
}

export async function run(argv: string[], io: CliIO): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (!p.command || p.command === 'help' || has(p, 'help')) {
    io.out(USAGE);
    return p.command && p.command !== 'help' && !has(p, 'help') ? 1 : 0;
  }
  try {
    const given = one(p, 'root');
    // --root 照給的路徑用（相對目前資料夾）；否則用 CLI 所在位置得知的專案，再不然從目前資料夾往上找
    const root = given ? path.resolve(io.cwd, given) : (io.root ?? (await findProjectRoot(io.cwd)));
    const project = await Project.open(root);
    const json = has(p, 'json');
    const print = (text: string, value: unknown) => io.out(json ? JSON.stringify(value, null, 2) : text);
    switch (p.command) {
      case 'info':
        return await info(project, print);
      case 'list':
        return await list(project, p, io, print);
      case 'show':
        return await show(project, p, io, print);
      case 'functions':
        return await functions(project, p, io, print);
      case 'add':
        return await add(project, p, io, print);
      case 'set':
        return await set(project, p, io, print);
      case 'remove':
        return await remove(project, p, io, print);
      case 'guide':
        return await guide(project, p, io);
      default:
        throw new CliError(`Unknown command "${p.command}".\n\n${USAGE}`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      io.err(err.message);
      return err.code;
    }
    io.err(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  }
}

type Print = (text: string, value: unknown) => void;

async function info(project: Project, print: Print): Promise<number> {
  const { data, exists } = await project.readStore();
  const items = await project.resolveAll(data);
  const value = {
    root: project.root,
    bookmarksFile: project.storeFile,
    bookmarksFileExists: exists,
    storedInEditor: project.storedInEditor,
    branch: project.branch,
    functions: items.filter((i) => i.kind === 'function').length,
    lines: items.filter((i) => i.kind === 'line').length,
    needsChecking: items.filter((i) => i.status).length,
  };
  const lines = [
    `Project: ${value.root}`,
    `Bookmarks file: ${value.bookmarksFile}${exists ? '' : ' (not created yet)'}`,
    `Branch: ${value.branch ?? '(none)'}`,
    `Bookmarks: ${value.functions} function, ${value.lines} line${value.needsChecking ? `, ${value.needsChecking} need checking` : ''}`,
  ];
  if (project.storedInEditor) {
    lines.push('Note: this project stores bookmarks inside the editor (functionBookmarks.storage = workspaceState); the CLI cannot see or change them.');
  }
  print(lines.join('\n'), value);
  return 0;
}

async function list(project: Project, p: Parsed, io: CliIO, print: Print): Promise<number> {
  const { data } = await project.readStore();
  let items = await project.resolveAll(data);
  const file = one(p, 'file');
  if (file) {
    const rel = await project.relPath(file, io.cwd);
    items = items.filter((i) => i.file === rel || i.file.startsWith(`${rel}/`));
  }
  const tag = one(p, 'tag')?.replace(/^#/, '');
  if (tag) {
    items = items.filter((i) => tagsOf(i).includes(tag));
  }
  const q = one(p, 'query')?.toLowerCase();
  if (q) {
    items = items.filter((i) => [displayName(i), noteOf(i) ?? '', i.file, ...tagsOf(i)].some((s) => s.toLowerCase().includes(q)));
  }
  print(items.length ? items.map(listLine).join('\n') : 'No bookmarks.', items.map(toJson));
  return 0;
}

async function show(project: Project, p: Parsed, io: CliIO, print: Print): Promise<number> {
  const ref = p.positional[0];
  if (!ref) {
    throw new CliError('Usage: fb show <ref>');
  }
  const { data } = await project.readStore();
  const item = await findItem(project, await project.resolveAll(data), ref, io.cwd);
  const src = await project.source(item.file);
  let code: { start: number; text: string; omitted: number } | undefined;
  if (src && !item.status) {
    if (item.kind === 'function' && item.symbol) {
      const s = extractFunctionSnippet(src.lines, item.symbol.startLine, item.symbol.endLine);
      code = s && { start: item.symbol.startLine + 1, text: s.code, omitted: s.omittedLines };
    } else {
      const s = extractLineSnippet(src.lines, item.line);
      code = s && { start: Math.max(0, item.line - 3) + 1, text: s.code, omitted: 0 };
    }
  }
  const value = { ...toJson(item), code: code?.text, codeStartLine: code?.start, omittedLines: code?.omitted || undefined };
  const lines = [listLine(item)];
  if (item.status === 'lost' && item.kind === 'line') {
    lines.push(`Last remembered line: ${item.bookmark.anchor?.text ?? '(unknown)'}`);
  }
  if (noteOf(item)) {
    lines.push('', 'Note:', noteOf(item)!);
  }
  if (code) {
    lines.push('', `Code (from line ${code.start}):`, code.text);
    if (code.omitted) {
      lines.push(`… ${code.omitted} more line(s)`);
    }
  }
  print(lines.join('\n'), value);
  return 0;
}

async function functions(project: Project, p: Parsed, io: CliIO, print: Print): Promise<number> {
  const input = p.positional[0];
  if (!input) {
    throw new CliError('Usage: fb functions <file>');
  }
  const file = await project.relPath(input, io.cwd);
  const src = await project.source(file);
  if (!src) {
    throw new CliError(`Cannot read ${file}.`);
  }
  if (!src.covered) {
    throw new CliError(`There are no built-in rules for ${file}; the editor uses the language server for it, which the CLI cannot use. Bookmark a line instead: fb add ${file}:<line> --line`);
  }
  const { data } = await project.readStore();
  const rows = flatten(src.symbols).map(({ s, depth }) => ({
    function: s.path,
    kind: s.kind,
    line: s.nameLine + 1,
    endLine: s.endLine + 1,
    depth,
    bookmarked: !!findMark(data, { file, path: s.path, kind: s.kind })?.favorite,
  }));
  print(
    rows.length
      ? rows.map((r) => `${'  '.repeat(r.depth)}${r.kind} ${r.function}  lines ${r.line}-${r.endLine}${r.bookmarked ? '  [bookmarked]' : ''}`).join('\n')
      : `No functions found in ${file}.`,
    rows,
  );
  return 0;
}

async function add(project: Project, p: Parsed, io: CliIO, print: Print): Promise<number> {
  const target = p.positional[0];
  if (!target) {
    throw new CliError('Usage: fb add <file>#<Function.path> | <file>:<line> [--label …] [--note …] [--tags a,b] [--number n] [--line]');
  }
  const hash = target.lastIndexOf('#');
  const colon = /^(.*):(\d+)$/.exec(target);
  const file = await project.relPath(hash > 0 ? target.slice(0, hash) : colon ? colon[1] : target, io.cwd);
  const src = await project.source(file);
  if (!src) {
    throw new CliError(`Cannot read ${file}.`);
  }
  let symbol: DetectedSymbol | undefined;
  let line: number;
  if (hash > 0) {
    const fnPath = target.slice(hash + 1);
    symbol = findByPath(src.symbols, fnPath);
    if (!symbol) {
      throw new CliError(`Function ${fnPath} was not found in ${file}. Run "fb functions ${file}" to see the names.`);
    }
    line = symbol.nameLine;
  } else if (colon) {
    line = Number(colon[2]) - 1;
    if (line < 0 || line >= src.lines.length) {
      throw new CliError(`${file} has ${src.lines.length} lines; line ${line + 1} does not exist.`);
    }
    symbol = has(p, 'line') ? undefined : symbolAtNameLine(src.symbols, line);
  } else {
    throw new CliError('Give a function (<file>#<Function.path>) or a line (<file>:<line>).');
  }
  const label = one(p, 'label');
  const note = one(p, 'note');
  const tags = tagsFlag(p);
  let ref = '';
  await project.updateStore((data) => {
    if (symbol) {
      const key: MarkKey = { file, path: symbol.path, kind: symbol.kind };
      const number = parseNumber(p, data, { key });
      let next = setFavorite(data, key, true, symbol.nameLine);
      if (label !== undefined) {
        next = setAlias(next, key, label, symbol.name);
      }
      if (note !== undefined) {
        next = setNote(next, key, note, symbol.nameLine);
      }
      if (tags) {
        next = setTags(next, key, tags);
      }
      if (number !== undefined) {
        next = setSymbolExtras(next, key, { number });
      }
      ref = functionRef(file, symbol.path);
      return next;
    }
    if ((data.bookmarks ?? []).some((b) => b.file === file && b.line === line)) {
      throw new CliError(`${file}:${line + 1} already has a bookmark. Use "fb set ${file}:${line + 1} …" to change it.`);
    }
    const number = parseNumber(p, data);
    const bm = newLineBookmark(src.lines, src.symbols, file, line, label);
    if (note?.trim()) {
      bm.note = note.trim();
    }
    if (tags?.length) {
      bm.tags = tags;
    }
    if (number) {
      bm.number = number;
    }
    ref = bm.id;
    return addBookmark(data, bm);
  });
  const { data } = await project.readStore();
  const item = await findItem(project, await project.resolveAll(data), ref, io.cwd);
  print(`Added: ${listLine(item)}`, toJson(item));
  return 0;
}

async function set(project: Project, p: Parsed, io: CliIO, print: Print): Promise<number> {
  const ref = p.positional[0];
  if (!ref) {
    throw new CliError('Usage: fb set <ref> [--label …] [--note …] [--append-note …] [--tags a,b] [--add-tag t] [--remove-tag t] [--number n]');
  }
  const { data: current } = await project.readStore();
  const item = await findItem(project, await project.resolveAll(current), ref, io.cwd);
  const label = one(p, 'label');
  const note = one(p, 'note');
  const append = one(p, 'append-note');
  const replaceTags = tagsFlag(p);
  const addTags = parseTags((p.flags.get('add-tag') ?? []).join(','));
  const removeTags = parseTags((p.flags.get('remove-tag') ?? []).join(','));
  const nextTags = (old: string[] | undefined) => {
    let t = replaceTags ?? old ?? [];
    t = [...t, ...addTags.filter((x) => !t.includes(x))].filter((x) => !removeTags.includes(x));
    return t;
  };
  const tagsChanged = !!replaceTags || addTags.length > 0 || removeTags.length > 0;
  const nextNote = (old: string | undefined) => (append !== undefined ? [old, append].filter((x) => x?.trim()).join('\n\n') : note);
  await project.updateStore((data) => {
    if (item.kind === 'function') {
      const key: MarkKey = { file: item.mark.file, path: item.mark.path, kind: item.mark.kind };
      const mark = findMark(data, key);
      if (!mark) {
        throw new CliError(`The bookmark ${item.ref} was removed meanwhile.`);
      }
      const number = parseNumber(p, data, { key });
      let next = data;
      if (label !== undefined) {
        next = setAlias(next, key, label, key.path.split('.').pop() ?? key.path);
      }
      if (note !== undefined || append !== undefined) {
        next = setNote(next, key, nextNote(mark.note));
      }
      if (tagsChanged) {
        next = setTags(next, key, nextTags(mark.tags));
      }
      if (number !== undefined) {
        next = setSymbolExtras(next, key, { number });
      }
      return next;
    }
    const number = parseNumber(p, data, { bookmarkId: item.bookmark.id });
    return updateBookmark(data, item.bookmark.id, (b) => {
      if (label !== undefined) {
        b.label = label.trim() || undefined;
      }
      if (note !== undefined || append !== undefined) {
        b.note = nextNote(b.note)?.trim() || undefined;
      }
      if (tagsChanged) {
        const t = nextTags(b.tags);
        b.tags = t.length ? t : undefined;
      }
      if (number !== undefined) {
        b.number = number ?? undefined;
      }
      return b;
    });
  });
  const { data } = await project.readStore();
  const after = await findItem(project, await project.resolveAll(data), item.ref, io.cwd);
  print(`Updated: ${listLine(after)}`, toJson(after));
  return 0;
}

async function remove(project: Project, p: Parsed, io: CliIO, print: Print): Promise<number> {
  const ref = p.positional[0];
  if (!ref) {
    throw new CliError('Usage: fb remove <ref>');
  }
  const { data: current } = await project.readStore();
  const item = await findItem(project, await project.resolveAll(current), ref, io.cwd);
  await project.updateStore((data) =>
    item.kind === 'function'
      ? setFavorite(data, { file: item.mark.file, path: item.mark.path, kind: item.mark.kind }, false)
      : removeBookmarks(data, [item.bookmark.id]),
  );
  print(`Removed: ${listLine(item)}`, { removed: item.ref });
  return 0;
}

async function guide(project: Project, p: Parsed, io: CliIO): Promise<number> {
  const { data } = await project.readStore();
  let items = await project.resolveAll(data);
  const file = one(p, 'file');
  if (file) {
    const rel = await project.relPath(file, io.cwd);
    items = items.filter((i) => i.file === rel || i.file.startsWith(`${rel}/`));
  }
  const tag = one(p, 'tag')?.replace(/^#/, '');
  if (tag) {
    items = items.filter((i) => tagsOf(i).includes(tag));
  }
  const exportItems = items.map((i) =>
    i.kind === 'function'
      ? itemFromFavorite(i.mark, i.symbol, i.unverified ? 'ok' : (i.status ?? 'ok'))
      : { ...itemFromBookmark({ ...i.bookmark, line: i.line }), status: i.status },
  );
  const contents = new Map<string, string[] | undefined>();
  for (const f of new Set(exportItems.map((i) => i.file))) {
    contents.set(f, (await project.source(f))?.lines);
  }
  const entries = await guideEntries(exportItems, contents, !has(p, 'no-code'));
  io.out(
    toGuideMarkdown(entries, {
      title: `${project.name} — Walkthrough`,
      omittedLabel: (n) => `… (${n} more line(s) omitted)`,
      warningLabel: (status, hasCode) => {
        const base = STATUS_TEXT[status];
        return status === 'lost' && hasCode ? `${base}: below is the last remembered content.` : `${base}.`;
      },
    }),
  );
  return 0;
}
