/**
 * 書籤的匯出檔格式（*.fbookmarks.json）與匯入規則、Markdown／CSV 輸出。全部是純函式。
 */
import { BookmarkAnchor, LineBookmark } from '../bookmarks/model';
import { StoreData } from '../storage/marks';

export const EXPORT_FORMAT = 'function-bookmarks/v1';

export interface ExportedBookmark {
  /** line：行號書籤；symbol：函式書籤（以名稱路徑記錄）。 */
  kind: 'line' | 'symbol';
  id: string;
  file: string;
  /** 0 起算。函式書籤為函式名稱所在的行。 */
  line: number;
  label?: string;
  tags?: string[];
  note?: string;
  /** 函式書籤：名稱路徑與種類。 */
  path?: string;
  symbolKind?: string;
  /** 匯出別人的書籤時：原本的來源註記。 */
  author?: string;
  /** 不含程式碼內容時沒有。 */
  anchor?: BookmarkAnchor;
}

export interface ExportFile {
  format: string;
  exportedBy: string;
  exportedAt: string;
  repo?: { remote?: string; branch?: string; commit?: string };
  /** false：不含程式碼內容（沒有 anchor 與行雜湊，匯入時只能照行號）。 */
  includesCode: boolean;
  /** 書籤所在檔案的行雜湊（base64），匯入時與本機內容比對換算位置。 */
  files?: Record<string, { hashes: string }>;
  bookmarks: ExportedBookmark[];
}

/** 行雜湊（uint32）壓縮成 base64。 */
export function encodeHashes(hashes: number[]): string {
  const buf = Buffer.alloc(hashes.length * 4);
  hashes.forEach((h, i) => buf.writeUInt32LE(h >>> 0, i * 4));
  return buf.toString('base64');
}

export function decodeHashes(text: string): number[] | undefined {
  try {
    const buf = Buffer.from(text, 'base64');
    if (buf.length % 4 !== 0) {
      return undefined;
    }
    const out: number[] = [];
    for (let i = 0; i < buf.length; i += 4) {
      out.push(buf.readUInt32LE(i));
    }
    return out;
  } catch {
    return undefined;
  }
}

/** 去掉 remote 網址的差異（協定、帳號、.git 結尾、ssh 寫法），用來判斷是不是同一個專案。 */
export function normalizeRemote(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  let s = url.trim();
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(s); // git@github.com:a/b.git
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  }
  return s.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

function strings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out = v.filter((x): x is string => typeof x === 'string' && !!x.trim());
  return out.length ? out : undefined;
}

function parseAnchor(v: unknown): BookmarkAnchor | undefined {
  const a = v as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object' || typeof a.text !== 'string') {
    return undefined;
  }
  return {
    text: a.text,
    before: (Array.isArray(a.before) ? a.before : []).filter((x): x is string => typeof x === 'string'),
    after: (Array.isArray(a.after) ? a.after : []).filter((x): x is string => typeof x === 'string'),
    symbolPath: typeof a.symbolPath === 'string' ? a.symbolPath : undefined,
    symbolOffset: typeof a.symbolOffset === 'number' ? a.symbolOffset : undefined,
  };
}

/** 讀取匯出檔；格式不對回傳錯誤原因。 */
export function parseExport(text: string): ExportFile | { error: 'json' | 'format' } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'json' };
  }
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object' || typeof o.format !== 'string' || !o.format.startsWith('function-bookmarks/') || !Array.isArray(o.bookmarks)) {
    return { error: 'format' };
  }
  const bookmarks: ExportedBookmark[] = [];
  for (const item of o.bookmarks as unknown[]) {
    const b = item as Record<string, unknown>;
    if (!b || typeof b !== 'object' || typeof b.file !== 'string' || typeof b.line !== 'number' || b.line < 0) {
      continue;
    }
    const kind = b.kind === 'symbol' && typeof b.path === 'string' ? 'symbol' : 'line';
    const e: ExportedBookmark = {
      kind,
      id: typeof b.id === 'string' && b.id ? b.id : `${b.file}:${b.line}:${kind}`,
      file: b.file.replace(/\\/g, '/').replace(/^\/+/, ''),
      line: Math.floor(b.line),
    };
    if (typeof b.label === 'string' && b.label.trim()) {
      e.label = b.label;
    }
    const tags = strings(b.tags);
    if (tags) {
      e.tags = tags;
    }
    if (typeof b.note === 'string' && b.note.trim()) {
      e.note = b.note;
    }
    if (kind === 'symbol') {
      e.path = b.path as string;
      e.symbolKind = typeof b.symbolKind === 'string' ? b.symbolKind : 'function';
    }
    if (typeof b.author === 'string' && b.author.trim()) {
      e.author = b.author.trim();
    }
    const anchor = parseAnchor(b.anchor);
    if (anchor) {
      e.anchor = anchor;
    }
    if (e.file && !e.file.split('/').includes('..')) {
      bookmarks.push(e);
    }
  }
  const files: Record<string, { hashes: string }> = {};
  if (o.files && typeof o.files === 'object') {
    for (const [f, v] of Object.entries(o.files as Record<string, unknown>)) {
      const h = (v as { hashes?: unknown } | undefined)?.hashes;
      if (typeof h === 'string') {
        files[f.replace(/\\/g, '/')] = { hashes: h };
      }
    }
  }
  const repo = o.repo as Record<string, unknown> | undefined;
  return {
    format: o.format,
    exportedBy: typeof o.exportedBy === 'string' && o.exportedBy.trim() ? o.exportedBy.trim() : '',
    exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : '',
    repo:
      repo && typeof repo === 'object'
        ? {
            remote: typeof repo.remote === 'string' ? repo.remote : undefined,
            branch: typeof repo.branch === 'string' ? repo.branch : undefined,
            commit: typeof repo.commit === 'string' ? repo.commit : undefined,
          }
        : undefined,
    includesCode: o.includesCode !== false,
    files,
    bookmarks,
  };
}

export type ImportMode = 'replace' | 'merge';

/**
 * 把匯入的書籤寫進資料：
 * - replace：刪掉這些來源之前匯入的書籤，換成這次的
 * - merge：以（來源、原始 id）比對，相同的更新（沿用本機的 id 與分支紀錄），新的加入
 * 自己的書籤與其他來源不受影響。
 */
export function applyImport(data: StoreData, incoming: LineBookmark[], mode: ImportMode): StoreData {
  const authors = new Set(incoming.map((b) => b.source?.author).filter((a): a is string => !!a));
  const existing = data.bookmarks ?? [];
  if (mode === 'replace') {
    const kept = existing.filter((b) => !b.source || !authors.has(b.source.author));
    return { ...data, bookmarks: [...kept, ...incoming] };
  }
  const key = (b: LineBookmark) => `${b.source?.author}\u0000${b.source?.originalId}`;
  const byKey = new Map(incoming.map((b) => [key(b), b]));
  const used = new Set<string>();
  const merged = existing.map((b) => {
    if (!b.source) {
      return b;
    }
    const k = key(b);
    const next = byKey.get(k);
    if (!next) {
      return b;
    }
    used.add(k);
    // 本機自己加的號碼與顏色也保留
    return { ...next, id: b.id, positions: b.positions, scope: b.scope, homeBranch: b.homeBranch, number: b.number, color: b.color };
  });
  return { ...data, bookmarks: [...merged, ...incoming.filter((b) => !used.has(key(b)))] };
}

/** 匯入前預覽：每個來源之前匯入過幾筆。 */
export function existingCounts(data: StoreData, authors: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of data.bookmarks ?? []) {
    if (b.source && authors.includes(b.source.author)) {
      out.set(b.source.author, (out.get(b.source.author) ?? 0) + 1);
    }
  }
  return out;
}

/** Markdown／CSV 的一列。 */
export interface ExportRow {
  file: string;
  /** 1 起算。 */
  line: number;
  name: string;
  kind: 'line' | 'symbol';
  tags: string[];
  note?: string;
  code?: string;
  source?: string;
}

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

export function toMarkdown(rows: ExportRow[], labels: { file: string; line: string; name: string; tags: string; note: string; code: string; source: string; fn: string }): string {
  const withCode = rows.some((r) => r.code !== undefined);
  const withSource = rows.some((r) => r.source);
  const head = [labels.file, labels.line, labels.name, labels.tags, labels.note, ...(withCode ? [labels.code] : []), ...(withSource ? [labels.source] : [])];
  const out = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of rows) {
    const cells = [
      mdCell(r.file),
      String(r.line),
      mdCell(r.kind === 'symbol' ? `${r.name} (${labels.fn})` : r.name),
      mdCell(r.tags.map((t) => `#${t}`).join(' ')),
      mdCell(r.note ?? ''),
      ...(withCode ? [r.code ? `\`${r.code.replace(/`/g, "'").replace(/\|/g, '\\|')}\`` : ''] : []),
      ...(withSource ? [mdCell(r.source ?? '')] : []),
    ];
    out.push(`| ${cells.join(' | ')} |`);
  }
  return out.join('\n') + '\n';
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV（開頭加 BOM，Excel 才會用 UTF-8 開啟中文）。 */
export function toCsv(rows: ExportRow[], labels: { file: string; line: string; name: string; kind: string; tags: string; note: string; code: string; source: string; fn: string; lineKind: string }): string {
  const withCode = rows.some((r) => r.code !== undefined);
  const head = [labels.file, labels.line, labels.name, labels.kind, labels.tags, labels.note, ...(withCode ? [labels.code] : []), labels.source];
  const out = [head.map(csvCell).join(',')];
  for (const r of rows) {
    out.push(
      [
        r.file,
        String(r.line),
        r.name,
        r.kind === 'symbol' ? labels.fn : labels.lineKind,
        r.tags.map((t) => `#${t}`).join(' '),
        r.note ?? '',
        ...(withCode ? [r.code ?? ''] : []),
        r.source ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return '\uFEFF' + out.join('\r\n') + '\r\n';
}

/** 導讀文件：函式本體最多擷取的行數，超過時截斷並註明。 */
export const GUIDE_MAX_FUNCTION_LINES = 30;
/** 導讀文件：行號書籤前後各擷取的行數。 */
export const GUIDE_LINE_CONTEXT = 3;

export interface GuideSnippet {
  code: string;
  /** 超過上限時截斷掉的行數；未截斷時為 0。 */
  omittedLines: number;
}

export interface GuideEntry {
  number?: number;
  name: string;
  file: string;
  /** 1 起算。 */
  line: number;
  tags: string[];
  note?: string;
  source?: string;
  language?: string;
  snippet?: GuideSnippet;
}

/** 導讀文件排序：有編號的依 1→9 排最前，其餘依檔案、行號接在後面。 */
export function sortGuideEntries<T extends { number?: number; file: string; line: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const na = a.number ?? Number.MAX_SAFE_INTEGER;
    const nb = b.number ?? Number.MAX_SAFE_INTEGER;
    return na - nb || a.file.localeCompare(b.file) || a.line - b.line;
  });
}

/** 擷取函式本體程式碼片段（0 起算起訖行，含頭尾），超過 maxLines 行時截斷。 */
export function extractFunctionSnippet(
  lines: string[],
  startLine: number,
  endLine: number,
  maxLines = GUIDE_MAX_FUNCTION_LINES,
): GuideSnippet | undefined {
  if (!lines.length || startLine < 0 || startLine >= lines.length) {
    return undefined;
  }
  const from = Math.max(0, startLine);
  const to = Math.min(lines.length - 1, Math.max(from, endLine));
  const total = to - from + 1;
  if (total <= maxLines) {
    return { code: lines.slice(from, to + 1).join('\n'), omittedLines: 0 };
  }
  return { code: lines.slice(from, from + maxLines).join('\n'), omittedLines: total - maxLines };
}

/** 擷取行號書籤前後各 context 行的程式碼片段（0 起算行號）。 */
export function extractLineSnippet(
  lines: string[],
  line: number,
  context = GUIDE_LINE_CONTEXT,
): GuideSnippet | undefined {
  if (!lines.length || line < 0 || line >= lines.length) {
    return undefined;
  }
  const from = Math.max(0, line - context);
  const to = Math.min(lines.length - 1, line + context);
  return { code: lines.slice(from, to + 1).join('\n'), omittedLines: 0 };
}

/** 選用不會與程式碼內容衝突的反引號圍欄長度（至少 3 個 `）。 */
function codeFence(code: string): string {
  let maxRun = 0;
  for (const m of code.matchAll(/`+/g)) {
    if (m[0].length > maxRun) {
      maxRun = m[0].length;
    }
  }
  return '`'.repeat(Math.max(3, maxRun + 1));
}

/** 輸出「導讀文件（Markdown）」：依編號與位置順序，含標題、路徑:行號、程式碼片段與備註原文。 */
export function toGuideMarkdown(
  entries: GuideEntry[],
  options: { title: string; omittedLabel: (count: number) => string },
): string {
  const ordered = sortGuideEntries(entries);
  const sections: string[] = [`# ${options.title}`];
  for (const e of ordered) {
    const parts: string[] = [];
    parts.push(`## ${e.number !== undefined ? `${e.number}. ` : ''}${e.name}`);
    const meta = [
      `\`${e.file}:${e.line}\``,
      e.tags.length ? e.tags.map((t) => `#${t}`).join(' ') : undefined,
      e.source ? `@${e.source}` : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    parts.push(meta);
    if (e.snippet && e.snippet.code.length > 0) {
      const fence = codeFence(e.snippet.code);
      const lang = e.language ?? '';
      parts.push(`${fence}${lang}\n${e.snippet.code}\n${fence}`);
      if (e.snippet.omittedLines > 0) {
        parts.push(`*${options.omittedLabel(e.snippet.omittedLines)}*`);
      }
    }
    if (e.note) {
      parts.push(e.note);
    }
    sections.push(parts.join('\n\n'));
  }
  return sections.join('\n\n') + '\n';
}
