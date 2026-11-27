import { blank, escapeStep } from './common';

/** 內插裡再有字串、字串裡再有內插的層數上限：沒有閉合的內插不會一路遞迴到堆疊用完。 */
const MAX_NEST = 8;

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };

/**
 * Elixir：# 註解、"…" '…' 字串（可跨行，#{…} 內插裡可以再有字串）、""" ''' heredoc、
 * ~s(…)、~r/…/、~w[…]、~S"""…""" 這類 sigil，以及 ?a、?" 字元。
 */
export function maskElixir(text: string): string {
  const out = text.split('');
  const n = text.length;

  /** 從 `start`（內容第一個字元）找到結尾 `closer`，處理跳脫與 #{…} 內插；回傳結尾之後的位置。 */
  const skipBody = (start: number, closer: string, interpolate: boolean, opener?: string, level = 0): number => {
    let j = start;
    let depth = 0;
    while (j < n) {
      if (text[j] === '\\') {
        j += escapeStep(text, j);
        continue;
      }
      if (interpolate && level < MAX_NEST && text[j] === '#' && text[j + 1] === '{') {
        j = skipInterpolation(j + 2, level + 1);
        continue;
      }
      if (opener && text[j] === opener) {
        depth++;
      } else if (text.startsWith(closer, j)) {
        if (depth === 0) {
          blank(out, text, start, j);
          return j + closer.length;
        }
        depth--;
      }
      j++;
    }
    blank(out, text, start, n);
    return n;
  };

  /** #{ 之後的程式碼：配對大括號，裡面的字串另外略過。回傳 } 之後的位置。 */
  const skipInterpolation = (start: number, level: number): number => {
    let j = start;
    let depth = 1;
    while (j < n) {
      const c = text[j];
      if (c === '"' || c === '\'') {
        j = skipBody(j + 1, c, c === '"', undefined, level);
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
    if (ch === '#') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    // ?a、?"、?\n：字元（前面是名稱的一部分時是函式名稱結尾的 ?）
    if (ch === '?' && i + 1 < n && !(i > 0 && /[\w?!]/.test(text[i - 1]))) {
      const len = text[i + 1] === '\\' ? 3 : 2;
      blank(out, text, i + 1, Math.min(i + len, n));
      i += len;
      continue;
    }
    if (ch === '~' && /[A-Za-z]/.test(text[i + 1] ?? '')) {
      const m = /^~([a-z]|[A-Z][A-Z0-9]*)("""|'''|[/|"'([{<])/.exec(text.slice(i, i + 20));
      if (m) {
        const delim = m[2];
        const interpolate = /^[a-z]$/.test(m[1]);
        const bodyStart = i + m[0].length;
        if (delim.length === 3) {
          i = skipBody(bodyStart, delim, interpolate);
        } else if (PAIRS[delim]) {
          i = skipBody(bodyStart, PAIRS[delim], interpolate, delim);
        } else {
          i = skipBody(bodyStart, delim, interpolate);
        }
        continue;
      }
    }
    if ((ch === '"' || ch === '\'') && text.startsWith(ch.repeat(3), i)) {
      i = skipBody(i + 3, ch.repeat(3), ch === '"');
      continue;
    }
    if (ch === '"' || ch === '\'') {
      i = skipBody(i + 1, ch, true);
      continue;
    }
    i++;
  }
  return out.join('');
}
