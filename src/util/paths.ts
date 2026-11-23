import picomatch from 'picomatch';
import { EXT_LANGUAGE } from '../detection/languages';

/**
 * 依副檔名猜語言，用在「不開檔案」讀取內容時（收藏區、整個專案）。
 * 猜不到回傳 undefined，呼叫端改用編輯器開啟文件取得語言。
 */
export function languageForPath(filePath: string): string | undefined {
  const m = /(\.[^./\\]+)$/.exec(filePath.toLowerCase());
  return m ? EXT_LANGUAGE[m[1]] : undefined;
}

const matcherCache = new Map<string, picomatch.Matcher>();

function matcher(pattern: string): picomatch.Matcher {
  let m = matcherCache.get(pattern);
  if (!m) {
    m = picomatch(pattern, { dot: true, nocase: process.platform === 'win32' });
    matcherCache.set(pattern, m);
  }
  return m;
}

/** 任一 glob 符合相對路徑（以 / 分隔）即為 true。 */
export function matchesAny(patterns: string[], relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, '/');
  return patterns.some((g) => matcher(g)(p));
}

/**
 * Windows 的磁碟代號在不同來源可能大小寫不同（`/D:/x` 與 `/d:/x`），
 * 比對前統一成小寫，與 VS Code 的 `Uri.file()` 一致。
 */
export function normalizeDrive(uriPath: string): string {
  return uriPath.replace(/^\/([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}:`);
}

/** `target` 相對於 `base` 的路徑（以 / 分隔）；不在 `base` 之下時回傳 undefined。 */
export function relativeUnder(basePath: string, targetPath: string): string | undefined {
  const base = normalizeDrive(basePath).replace(/\/+$/, '');
  const target = normalizeDrive(targetPath);
  if (!target.startsWith(`${base}/`)) {
    return undefined;
  }
  const rel = target.slice(base.length + 1);
  return rel && !rel.split('/').includes('..') ? rel : undefined;
}

/** 從 `a/b/c.py` 取出顯示用的上層資料夾，例如 `a/b`。 */
export function dirnamePosix(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

export function basenamePosix(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? rel : rel.slice(i + 1);
}
