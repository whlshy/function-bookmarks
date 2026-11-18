/**
 * 書籤檔只給自己用，不應被提交。
 *
 * 做法是寫進 `.git/info/exclude`（只在本機生效、不會被提交），
 * 而不是改團隊共用的 `.gitignore`，避免在別人的專案裡留下修改。
 */

export const BOOKMARKS_FILE = '.vscode/function-bookmarks.json';

const COVERING_PATTERNS = new Set([
  BOOKMARKS_FILE,
  `/${BOOKMARKS_FILE}`,
  `**/${BOOKMARKS_FILE}`,
  'function-bookmarks.json',
  '.vscode',
  '.vscode/',
  '/.vscode',
  '/.vscode/',
  '.vscode/*',
  '/.vscode/*',
  '.vscode/**',
]);

/** 判斷 ignore 檔內容是否已經涵蓋書籤檔（只看常見寫法，不做完整 glob 判斷）。 */
export function isCovered(content: string | undefined): boolean {
  if (!content) {
    return false;
  }
  let covered = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('!')) {
      // 後面的例外規則把書籤檔加回來，例如 `!.vscode/function-bookmarks.json`
      if (COVERING_PATTERNS.has(line.slice(1))) {
        covered = false;
      }
      continue;
    }
    if (COVERING_PATTERNS.has(line)) {
      covered = true;
    }
  }
  return covered;
}

/** 回傳加上書籤檔後的新內容；已涵蓋時回傳 undefined（不需要修改）。 */
export function withExcludeEntry(content: string | undefined): string | undefined {
  if (isCovered(content)) {
    return undefined;
  }
  const base = content ?? '';
  const sep = base === '' || base.endsWith('\n') ? '' : '\n';
  return `${base}${sep}# Function Bookmarks：個人書籤，不提交\n${BOOKMARKS_FILE}\n`;
}

/** 解析 worktree／submodule 的 `.git` 檔案內容（`gitdir: <path>`）。 */
export function parseGitDirFile(content: string): string | undefined {
  const m = /^gitdir:\s*(.+)\s*$/m.exec(content);
  return m ? m[1].trim() : undefined;
}
