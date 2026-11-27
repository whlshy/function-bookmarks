import { blank, escapeStep } from './common';

/** 內插裡再有字串、字串裡再有內插的層數上限：沒有閉合的內插不會一路遞迴到堆疊用完。 */
const MAX_NEST = 8;

/**
 * Dart：// 與 /* *\/ 註解（可巢狀）、'…' "…" 字串、''' """ 多行字串、r'…' 原始字串，
 * 以及 ${…} 內插（裡面可以再有字串）。
 */
export function maskDart(text: string): string {
  const out = text.split('');
  const n = text.length;

  /** `start` 是開頭引號的位置；回傳結尾引號之後的位置，內容換成空白。 */
  const skipString = (start: number, raw: boolean, level = 0): number => {
    const q = text[start];
    const triple = text.startsWith(q.repeat(3), start);
    const closer = triple ? q.repeat(3) : q;
    const bodyStart = start + closer.length;
    let j = bodyStart;
    while (j < n) {
      if (!triple && text[j] === '\n') {
        break; // 沒有閉合的單行字串：到那一行為止
      }
      if (!raw && text[j] === '\\') {
        j += escapeStep(text, j);
        continue;
      }
      if (!raw && level < MAX_NEST && text[j] === '$' && text[j + 1] === '{') {
        j = skipInterpolation(j + 2, level + 1);
        continue;
      }
      if (text.startsWith(closer, j)) {
        blank(out, text, bodyStart, j);
        return j + closer.length;
      }
      j++;
    }
    blank(out, text, bodyStart, Math.min(j, n));
    return Math.min(j, n);
  };

  /** ${ 之後的程式碼：配對大括號，裡面的字串另外略過。 */
  const skipInterpolation = (start: number, level: number): number => {
    let j = start;
    let depth = 1;
    while (j < n) {
      const c = text[j];
      if (c === '"' || c === '\'') {
        j = skipString(j, false, level);
        continue;
      }
      if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          return j + 1;
        }
      }
      j++;
    }
    return n;
  };

  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      blank(out, text, i, j);
      i = j;
      continue;
    }
    if (ch === 'r' && (next === '"' || next === '\'') && !(i > 0 && /[\w$]/.test(text[i - 1]))) {
      i = skipString(i + 1, true);
      continue;
    }
    if (ch === '"' || ch === '\'') {
      i = skipString(i, false);
      continue;
    }
    i++;
  }
  return out.join('');
}
