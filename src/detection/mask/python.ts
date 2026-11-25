import { blank, escapeStep } from './common';

/** Python：# 註解、字串、三個引號的多行字串。 */
export function maskPython(text: string): string {
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
    if (ch === '\'' || ch === '"') {
      const triple = text.startsWith(ch.repeat(3), i);
      if (triple) {
        // 多行字串連同前綴（f、r、b、u…）與引號整段遮掉：內容常從第 0 欄開始寫，
        // 留下的 f""" 或 """ 會被縮排判斷當成「回到外層」，函式就提早結束了
        let start = i;
        while (start > 0 && i - start < 2 && /[rRbBuUfFtT]/.test(text[start - 1])) {
          start--;
        }
        if (start > 0 && /\w/.test(text[start - 1])) {
          start = i; // 前面是識別字的一部分，不是字串前綴
        }
        const delim = ch.repeat(3);
        // Python 三引號字串（含 raw string）裡，反斜線皆會跳脫下一個字元，避免把 \"\"\" 誤當成結尾
        let j = i + 3;
        let close = -1;
        while (j < n) {
          if (text[j] === '\\') {
            j += escapeStep(text, j);
            continue;
          }
          if (text.startsWith(delim, j)) {
            close = j;
            break;
          }
          j++;
        }
        const stop = close === -1 ? n : close + 3;
        // 開頭的引號有縮排時保留（只有 docstring 的 class／def 本體才不會變成空的）；在第 0 欄才一起遮掉
        const atColumn0 = start === 0 || text[start - 1] === '\n';
        // 結尾的引號：縮排不少於開頭那一行時保留（範圍才會包含整段 docstring），否則遮掉
        const indentOf = (pos: number) => {
          const ls = text.lastIndexOf('\n', pos - 1) + 1;
          return /^[ \t]*/.exec(text.slice(ls, pos))![0].length;
        };
        const closeLineStart = close === -1 ? -1 : text.lastIndexOf('\n', close - 1) + 1;
        const closeIndented = close !== -1 && /^[ \t]+$/.test(text.slice(closeLineStart, close));
        const keepClose = !atColumn0 && closeIndented && close - closeLineStart >= indentOf(start);
        blank(out, text, atColumn0 ? start : i + 3, keepClose ? close : stop);
        i = stop;
        continue;
      }
      let j = i + 1;
      while (j < n && text[j] !== ch && text[j] !== '\n') {
        j += escapeStep(text, j);
      }
      blank(out, text, i + 1, Math.min(j, n));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}
