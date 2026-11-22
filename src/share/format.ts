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
    return { ...next, id: b.id, positions: b.positions, scope: b.scope, homeBranch: b.homeBranch };
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
