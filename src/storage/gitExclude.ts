/**
 * 書籤檔只給自己用，不應被提交。
 *
 * 做法是寫進 `.git/info/exclude`（只在本機生效、不會被提交），
 * 而不是改團隊共用的 `.gitignore`，避免在別人的專案裡留下修改。
 */

export const BOOKMARKS_FILE = '.vscode/function-bookmarks.json';

/** 不含前導／中間斜線或以 ** 開頭的泛用規則：在任何深度的子資料夾都生效。 */
const ANY_DEPTH_PATTERNS = new Set([
  `**/${BOOKMARKS_FILE}`,
  'function-bookmarks.json',
  '.vscode',
  '.vscode/',
  '**/.vscode',
  '**/.vscode/',
  '**/.vscode/*',
  '**/.vscode/**',
]);

/** 針對相對於 ignore 檔所在目錄的書籤檔路徑（例如 `.vscode/function-bookmarks.json` 或 `packages/web/.vscode/function-bookmarks.json`），列出所有可涵蓋它的常見規則。 */
function coveringPatternsFor(entry: string): Set<string> {
  const normalized = entry.replace(/\\/g, '/').replace(/^\/+/, '');
  const out = new Set<string>(ANY_DEPTH_PATTERNS);
  out.add(normalized);
  out.add(`/${normalized}`);
  out.add(`**/${normalized}`);
  const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
  if (dir) {
    out.add(dir);
    out.add(`${dir}/`);
    out.add(`/${dir}`);
    out.add(`/${dir}/`);
    out.add(`${dir}/*`);
    out.add(`/${dir}/*`);
    out.add(`${dir}/**`);
    out.add(`/${dir}/**`);
  }
  return out;
}

/** 判斷 ignore 檔內容是否已經涵蓋指定書籤檔路徑（只看常見寫法，不做完整 glob 判斷）。 */
export function isCovered(content: string | undefined, entry = BOOKMARKS_FILE): boolean {
  if (!content) {
    return false;
  }
  const patterns = coveringPatternsFor(entry);
  let covered = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('!')) {
      // 後面的例外規則把書籤檔加回來，例如 `!.vscode/function-bookmarks.json`
      if (patterns.has(line.slice(1))) {
        covered = false;
      }
      continue;
    }
    if (patterns.has(line)) {
      covered = true;
    }
  }
  return covered;
}

/** 回傳加上書籤檔路徑後的新內容；已涵蓋時回傳 undefined（不需要修改）。 */
export function withExcludeEntry(content: string | undefined, entry = BOOKMARKS_FILE): string | undefined {
  const normalized = entry.replace(/\\/g, '/').replace(/^\/+/, '');
  if (isCovered(content, normalized)) {
    return undefined;
  }
  const base = content ?? '';
  const sep = base === '' || base.endsWith('\n') ? '' : '\n';
  return `${base}${sep}# Function Bookmarks：個人書籤，不提交\n${normalized}\n`;
}

/** 解析 worktree／submodule 的 `.git` 檔案內容（`gitdir: <path>`）。 */
export function parseGitDirFile(content: string): string | undefined {
  const m = /^gitdir:\s*(.+)\s*$/m.exec(content);
  return m ? m[1].trim() : undefined;
}
