import { blank, escapeStep } from './common';

const CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * R：# 註解、"…" '…' 字串（可跨行）、r"(…)"、R'[…]'、r"---{…}---" 原始字串。
 * 反引號名稱（`%||%`）不遮，規則才抓得到這種名稱。
 */
export function maskR(text: string): string {
  const out = text.split('');
  const n = text.length;
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
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if ((ch === 'r' || ch === 'R') && !(i > 0 && /[\w.]/.test(text[i - 1]))) {
      const m = /^[rR](["'])(-*)([([{])/.exec(text.slice(i, i + 40));
      if (m) {
        const closer = `${CLOSE[m[3]]}${m[2]}${m[1]}`;
        const close = text.indexOf(closer, i + m[0].length);
        blank(out, text, i + m[0].length, close === -1 ? n : close);
        i = close === -1 ? n : close + closer.length;
        continue;
      }
    }
    if (ch === '"' || ch === '\'') {
      let j = i + 1;
      while (j < n && text[j] !== ch) {
        j += escapeStep(text, j);
      }
      blank(out, text, i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
      continue;
    }
    i++;
  }
  return out.join('');
}
