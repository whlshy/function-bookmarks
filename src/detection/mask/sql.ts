import { blank } from './common';

/**
 * SQL：-- 行註解與 /* 區塊註解、'…' 字串（'' 是跳脫，可跨行）、PostgreSQL 的 $$ … $$、$tag$ … $tag$。
 * 雙引號、反引號、[…] 是識別字（名稱），保留。
 * 用了 MySQL 的 DELIMITER 時 $$ 是敘述結尾，不當成字串。
 */
export function maskSql(text: string): string {
  const out = text.split('');
  const n = text.length;
  const dollarQuotes = !/^[ \t]*DELIMITER[ \t]/im.test(text);
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    if (ch === '\'') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\'') {
          if (text[j + 1] === '\'') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      blank(out, text, i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
      continue;
    }
    if (dollarQuotes && ch === '$' && !(i > 0 && /[\w$]/.test(text[i - 1]))) {
      const open = /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 64));
      if (open) {
        const close = text.indexOf(open[0], i + open[0].length);
        const stop = close === -1 ? n : close;
        blank(out, text, i + open[0].length, stop);
        i = close === -1 ? n : close + open[0].length;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}
