import { blank } from './common';

/** 子運算式裡再有字串、字串裡再有子運算式的層數上限：沒有閉合時不會一路遞迴到堆疊用完。 */
const MAX_NEST = 8;

/**
 * PowerShell：# 行註解、<# … #> 區塊註解、"…"（` 跳脫、"" 跳脫、$( … ) 子運算式）、'…'（'' 跳脫）、
 * @" … "@ 與 @' … '@ here-string。字串都可以跨行。
 */
export function maskPowerShell(text: string): string {
  const out = text.split('');
  const n = text.length;

  /** 從開頭引號之後找到結尾引號：`"` 時處理 ` 跳脫與 $( … )。回傳結尾引號之後的位置。 */
  const skipQuoted = (start: number, q: string, level = 0): number => {
    let j = start;
    while (j < n) {
      const c = text[j];
      if (q === '"' && c === '`') {
        j += 2;
        continue;
      }
      if (q === '"' && level < MAX_NEST && c === '$' && text[j + 1] === '(') {
        j = skipSubexpression(j + 2, level + 1);
        continue;
      }
      if (c === q) {
        if (text[j + 1] === q) {
          j += 2;
          continue;
        }
        blank(out, text, start, j);
        return j + 1;
      }
      j++;
    }
    blank(out, text, start, n);
    return n;
  };

  /** $( 之後的程式碼：配對小括號，裡面的字串另外略過。 */
  const skipSubexpression = (start: number, level: number): number => {
    let j = start;
    let depth = 1;
    while (j < n) {
      const c = text[j];
      if (c === '"' || c === '\'') {
        j = skipQuoted(j + 1, c, level);
        continue;
      }
      if (c === '(') {
        depth++;
      } else if (c === ')') {
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
    const prev = i > 0 ? text[i - 1] : '\n';
    if (ch === '<' && text[i + 1] === '#') {
      const close = text.indexOf('#>', i + 2);
      const stop = close === -1 ? n : close + 2;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    // # 只有在字詞開頭才是註解（a#b 是名稱的一部分）
    if (ch === '#' && /[\s;|(){}]/.test(prev)) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    if (ch === '@' && (text[i + 1] === '"' || text[i + 1] === '\'') && /^@["'][ \t]*\r?\n/.test(text.slice(i, i + 8))) {
      const q = text[i + 1];
      const m = new RegExp(`^${q}@`, 'm').exec(text.slice(i + 2));
      const close = m ? i + 2 + m.index : n;
      blank(out, text, i + 2, close);
      i = close === n ? n : close + 2;
      continue;
    }
    if (ch === '`') {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      i = skipQuoted(i + 1, ch);
      continue;
    }
    i++;
  }
  return out.join('');
}
