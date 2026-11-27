import { blank, escapeStep } from './common';

/** Zig：// 註解、"…" 字串、'x' 字元、\\ 開頭的多行字串（每行到行尾）。 */
export function maskZig(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if ((ch === '/' && text[i + 1] === '/') || (ch === '\\' && text[i + 1] === '\\')) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(out, text, ch === '/' ? i : i + 2, stop);
      i = stop;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"' && text[j] !== '\n') {
        j += escapeStep(text, j);
      }
      blank(out, text, i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
      continue;
    }
    if (ch === '\'') {
      const m = /^'(?:\\(?:u\{[0-9A-Fa-f]{1,6}\}|x[0-9A-Fa-f]{2}|.)|[^\\'\n]{1,2})'/u.exec(text.slice(i, i + 16));
      if (m) {
        blank(out, text, i + 1, i + m[0].length - 1);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}
