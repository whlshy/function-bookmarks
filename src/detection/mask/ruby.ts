import { blank } from './common';

/** Ruby：# 註解、=begin … =end、字串（可跨行）、heredoc（<<~EOS、<<-EOS）。 */
export function maskRuby(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  /** heredoc：標頭那一行結束後，跳過主體（from → to）。 */
  const pending: { from: number; to: number }[] = [];
  while (i < n) {
    const ch = text[i];
    if (ch === '\n' && pending.length) {
      const h = pending.shift()!;
      blank(out, text, h.from, h.to);
      i = Math.max(i + 1, h.to);
      continue;
    }
    const lineStart = i === 0 || text[i - 1] === '\n';
    if (lineStart && text.startsWith('=begin', i)) {
      const m = /^=end\b.*$/m.exec(text.slice(i));
      const stop = m ? i + m.index + m[0].length : n;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    if (ch === '#') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    // heredoc：<<~EOS、<<-EOS、<<EOS（大寫識別字，避免把 a << b 當成 heredoc）
    if (ch === '<' && text[i + 1] === '<') {
      const open = /^<<[~-]?(['"]?)([A-Z_][A-Z0-9_]*)\1/.exec(text.slice(i, i + 80));
      const lineEnd = text.indexOf('\n', i);
      if (open && lineEnd !== -1) {
        const searchFrom = pending.length ? pending[pending.length - 1].to : lineEnd + 1;
        const endRe = new RegExp(`^[ \\t]*${open[2]}[ \\t]*$`, 'm');
        const m = endRe.exec(text.slice(searchFrom));
        const close = m ? searchFrom + m.index : n;
        pending.push({ from: searchFrom, to: close });
        i += open[0].length;
        continue;
      }
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      let j = i + 1;
      while (j < n && text[j] !== ch) {
        j += text[j] === '\\' ? 2 : 1;
      }
      blank(out, text, i + 1, Math.min(j, n));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}
