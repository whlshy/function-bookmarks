/**
 * 讀取 alefragnani Bookmarks 的 `.vscode/bookmarks.json`（需在該套件開啟 `bookmarks.saveBookmarksInProject`）。
 *
 * 支援的格式（依 alefragnani 的 Controller.loadFrom）：
 * - 目前版本：`{ "files": [{ "path": "src/a.ts", "bookmarks": [{ "line": 0, "column": 0, "label": "" }] }] }`
 * - 舊版：最上層直接是 files 陣列
 * - 更舊版：`{ "bookmarks": [{ "path" | "fsPath": "$ROOTPATH$\\a.ts", "bookmarks": [行號或 { line, label }] }] }`
 * 行號從 0 起算；路徑相對於工作區資料夾。
 */

export interface ForeignBookmark {
  /** 相對於工作區資料夾、以 / 分隔。 */
  file: string;
  line: number;
  label?: string;
}

interface RawFile {
  path?: unknown;
  fsPath?: unknown;
  bookmarks?: unknown;
}

function normalizePath(p: string): string | undefined {
  let s = p.replace(/^\$ROOTPATH\$[\\/]?/, '').replace(/\\/g, '/').replace(/^\.\//, '');
  s = s.replace(/^\/+/, '');
  if (!s || s.startsWith('../') || s === '..' || /^Untitled-\d+$/.test(s) || /^[a-zA-Z]:\//.test(s)) {
    return undefined;
  }
  return s;
}

export function parseAlefragnani(json: unknown): ForeignBookmark[] {
  let files: unknown;
  if (Array.isArray(json)) {
    files = json;
  } else if (json && typeof json === 'object') {
    const o = json as { files?: unknown; bookmarks?: unknown };
    files = o.files ?? o.bookmarks;
  }
  if (!Array.isArray(files)) {
    return [];
  }
  const out: ForeignBookmark[] = [];
  const seen = new Set<string>();
  for (const f of files as RawFile[]) {
    if (!f || typeof f !== 'object') {
      continue;
    }
    const raw = typeof f.path === 'string' ? f.path : typeof f.fsPath === 'string' ? f.fsPath : undefined;
    const file = raw === undefined ? undefined : normalizePath(raw);
    if (!file || !Array.isArray(f.bookmarks)) {
      continue;
    }
    for (const b of f.bookmarks as unknown[]) {
      let line: unknown;
      let label: unknown;
      if (typeof b === 'number') {
        line = b;
      } else if (b && typeof b === 'object') {
        line = (b as { line?: unknown }).line;
        label = (b as { label?: unknown }).label;
      }
      if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
        continue;
      }
      const key = `${file}:${line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const entry: ForeignBookmark = { file, line };
      if (typeof label === 'string' && label.trim()) {
        entry.label = label.trim();
      }
      out.push(entry);
    }
  }
  return out;
}
