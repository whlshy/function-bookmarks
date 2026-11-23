import { blank } from './common';

/** 在這些字元之後的 # 是註解開頭（# 要在一個詞的開頭；$#、${#x}、a#b 不是註解）。 */
const BEFORE_COMMENT = ' \t\n;|&()<>';

/**
 * Shell（sh、bash、zsh）：# 註解、'…'（不跳脫，可跨行）、$'…'（可跳脫）、"…"（可跳脫，可跨行）、
 * `…`、heredoc（<<EOF、<<-EOF、<<'EOF'；<<< 是 here-string 不算）。
 */
export function maskShell(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  /** heredoc：標頭那一行結束後，跳過主體（from → to）。 */
  const pending: { from: number; to: number }[] = [];
  /** 從 start（開頭引號）找結束引號，回傳結束引號之後的位置。 */
  const quoted = (start: number, q: string, escapes: boolean): number => {
    let j = start + 1;
    while (j < n && text[j] !== q) {
      j += escapes && text[j] === '\\' ? 2 : 1;
    }
    blank(out, text, start + 1, Math.min(j, n));
    return Math.min(j + 1, n);
  };
  while (i < n) {
    const ch = text[i];
    if (ch === '\n' && pending.length) {
      const h = pending.shift()!;
      blank(out, text, h.from, h.to);
      i = Math.max(i + 1, h.to);
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '#' && (i === 0 || BEFORE_COMMENT.includes(text[i - 1]))) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    if (ch === '\'') {
      i = quoted(i, '\'', text[i - 1] === '$');
      continue;
    }
    // case 的匹配樣式 {) 、}) ：只是要比對的文字，不是區塊（否則大括號配錯）
    if ((ch === '{' || ch === '}') && text[i + 1] === ')' && (i === 0 || /[\s|(]/.test(text[i - 1]))) {
      blank(out, text, i, i + 1);
      i += 2;
      continue;
    }
    if (ch === '"' || ch === '`') {
      i = quoted(i, ch, true);
      continue;
    }
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      const open = /^<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1/.exec(text.slice(i, i + 80));
      const lineEnd = text.indexOf('\n', i);
      if (open && lineEnd !== -1) {
        const searchFrom = pending.length ? pending[pending.length - 1].to : lineEnd + 1;
        const word = open[2].replace(/[-]/g, '\\-');
        const m = new RegExp(`^[ \\t]*${word}[ \\t]*\\r?$`, 'm').exec(text.slice(searchFrom));
        const close = m ? searchFrom + m.index : n;
        pending.push({ from: searchFrom, to: close });
        i += open[0].length;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}
