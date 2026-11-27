import { blank, escapeStep } from './common';

/** `[[`、`[==[` 這類長括號的開頭：回傳等號數與開頭長度。 */
function longBracket(text: string, at: number): { level: number; len: number } | undefined {
  const m = /^\[(=*)\[/.exec(text.slice(at, at + 40));
  return m ? { level: m[1].length, len: m[0].length } : undefined;
}

/** Lua：-- 行註解、--[[ … ]]／--[==[ … ]==] 區塊註解、'…' "…" 字串、[[ … ]]／[==[ … ]==] 長字串。 */
export function maskLua(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '-' && text[i + 1] === '-') {
      const open = text[i + 2] === '[' ? longBracket(text, i + 2) : undefined;
      if (open) {
        const closer = `]${'='.repeat(open.level)}]`;
        const close = text.indexOf(closer, i + 2 + open.len);
        const stop = close === -1 ? n : close + closer.length;
        blank(out, text, i, stop);
        i = stop;
        continue;
      }
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    if (ch === '[') {
      const open = longBracket(text, i);
      if (open) {
        const closer = `]${'='.repeat(open.level)}]`;
        const close = text.indexOf(closer, i + open.len);
        blank(out, text, i + open.len, close === -1 ? n : close);
        i = close === -1 ? n : close + closer.length;
        continue;
      }
    }
    if (ch === '"' || ch === '\'') {
      // 反斜線接換行是字串內的換行；沒有跳脫的換行就是字串沒有閉合，到那一行為止
      let j = i + 1;
      while (j < n && text[j] !== ch && text[j] !== '\n') {
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
