import { blank, escapeStep } from './common';

/** 運算子字元：-- 前後接著這些字元時是運算子（-->、|--），不是註解。 */
const SYMBOL = /[!#$%&*+./<=>?@\\^|~:-]/;

/**
 * Haskell：-- 行註解、{- … -} 區塊註解（可巢狀，含 {-# 編譯指示 #-}）、"…" 字串、'x' 字元。
 * 名稱裡的 '（foldl'）與 TH 的 'name、''Type 不是字元。
 */
export function maskHaskell(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '{' && text[i + 1] === '-') {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (text[j] === '{' && text[j + 1] === '-') {
          depth++;
          j += 2;
        } else if (text[j] === '-' && text[j + 1] === '}') {
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
    if (ch === '-' && text[i + 1] === '-' && !(i > 0 && SYMBOL.test(text[i - 1]))) {
      let j = i + 2;
      while (text[j] === '-') {
        j++;
      }
      if (j >= n || !SYMBOL.test(text[j])) {
        const end = text.indexOf('\n', i);
        const stop = end === -1 ? n : end;
        blank(out, text, i, stop);
        i = stop;
        continue;
      }
      i = j;
      continue;
    }
    if (ch === '"') {
      // 字串可以用 \ … \ 斷行（string gap），所以不在換行停下
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        j += escapeStep(text, j);
      }
      blank(out, text, i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
      continue;
    }
    if (ch === '\'' && !(i > 0 && /[\w']/.test(text[i - 1]))) {
      const m = /^'(?:\\[^'\n]{1,8}|[^\\'\n])'/.exec(text.slice(i, i + 12));
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
