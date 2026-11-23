import { Syntax } from '../types';
import { blank, escapeStep } from './common';

/** C 家族各語言的註解與字串寫法差異。 */
export interface CFamilyOptions {
  /** 區塊註解可以巢狀（Rust、Kotlin、Swift）。 */
  nestedBlock?: boolean;
  /** `#` 也是行註解（PHP；`#[` 是屬性不算）。 */
  hashComment?: boolean;
  /** 單引號：'char' 字元（只遮一個字元或跳脫序列）、'rust'（另外要分辨生命週期 'a）、'string'（PHP：單引號字串，可跨行）。 */
  quote: 'char' | 'rust' | 'string';
  /** 雙引號字串可以跨行（Rust、PHP）。 */
  multilineString?: boolean;
  /** C++ raw string：R"delim( … )delim"。 */
  cppRaw?: boolean;
  /** Rust raw string：r"…"、r#"…"#、br"…"。 */
  rustRaw?: boolean;
  /** 反引號字串（Go raw string，可跨行）。 */
  backtick?: boolean;
  /** C# 逐字字串 @"…"（"" 為跳脫），以及 $@"…"、@$"…"。 */
  verbatim?: boolean;
  /** 三個雙引號的文字區塊（Java text block、C# raw string、Kotlin、Swift）。 */
  tripleQuote?: boolean;
  /** PHP heredoc／nowdoc：<<<EOT … EOT。 */
  heredoc?: boolean;
}

export const C_FAMILY: Partial<Record<Syntax, CFamilyOptions>> = {
  cpp: { quote: 'char', cppRaw: true },
  rust: { quote: 'rust', nestedBlock: true, multilineString: true, rustRaw: true },
  go: { quote: 'char', backtick: true },
  java: { quote: 'char', nestedBlock: false, tripleQuote: true },
  kotlin: { quote: 'char', nestedBlock: true, tripleQuote: true },
  csharp: { quote: 'char', verbatim: true, tripleQuote: true },
  php: { quote: 'string', hashComment: true, multilineString: true, heredoc: true },
  // Protocol Buffers：// 與 /* */ 註解，'…' 與 "…" 字串都不跨行
  proto: { quote: 'char' },
};

export function maskCFamily(text: string, o: CFamilyOptions): string {
  const out = text.split('');
  maskCFamilyInto(text, out, 0, o, false);
  return out.join('');
}

/**
 * 在 `out` 上就地遮掉 [start, …) 的註解與字串，回傳結束位置。
 * `phpClose`：遇到程式碼裡的 ?> 就停（回傳 ?> 的位置）。
 */
export function maskCFamilyInto(text: string, out: string[], start: number, o: CFamilyOptions, phpClose: boolean): number {
  const n = text.length;
  let i = start;
  /** 遮掉 [from, to) 並移到 to。 */
  const skip = (from: number, to: number) => {
    blank(out, text, from, Math.min(to, n));
    i = Math.min(to, n);
  };
  /** 一般字串：從開頭引號之後找到結束引號（處理 \ 跳脫），回傳結束引號之後的位置。 */
  const quoted = (start: number, q: string, multiline: boolean): number => {
    let j = start + 1;
    while (j < n && text[j] !== q && (multiline || text[j] !== '\n')) {
      j += escapeStep(text, j);
    }
    blank(out, text, start + 1, Math.min(j, n));
    return Math.min(j + 1, n);
  };
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (phpClose && ch === '?' && next === '>') {
      return i;
    }
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      skip(i, end === -1 ? n : end);
      continue;
    }
    if (o.hashComment && ch === '#' && next !== '[') {
      const end = text.indexOf('\n', i);
      skip(i, end === -1 ? n : end);
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else if (o.nestedBlock && text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else {
          j++;
        }
      }
      skip(i, j);
      continue;
    }
    const prevWord = i > 0 && /[\w$]/.test(text[i - 1]);
    // C++ raw string：R"delim( … )delim"（也可能有 u8R、LR 等前綴）
    if (o.cppRaw && ch === 'R' && next === '"') {
      const open = /^R"([^()\\\s]{0,16})\(/.exec(text.slice(i, i + 20));
      if (open) {
        const close = text.indexOf(`)${open[1]}"`, i + open[0].length);
        const stop = close === -1 ? n : close + open[1].length + 2;
        blank(out, text, i + 2, stop - 1);
        i = stop;
        continue;
      }
    }
    // Rust raw string：r"…"、r#"…"#（前面可有 b）
    if (o.rustRaw && ch === 'r' && (next === '"' || next === '#') && !(i > 0 && /[\w]/.test(text[i - 1]) && text[i - 1] !== 'b')) {
      const open = /^r(#*)"/.exec(text.slice(i, i + 40));
      if (open) {
        const closer = `"${open[1]}`;
        const close = text.indexOf(closer, i + open[0].length);
        const stop = close === -1 ? n : close + closer.length;
        blank(out, text, i + open[0].length, close === -1 ? n : close);
        i = stop;
        continue;
      }
    }
    // C# 逐字字串 @"…"、$@"…"、@$"…"："" 是跳脫
    if (o.verbatim && (ch === '@' || ch === '$') && (next === '"' || (/[@$]/.test(next ?? '') && text[i + 2] === '"'))) {
      const q = next === '"' ? i + 1 : i + 2;
      const prefix = text.slice(i, q);
      if (prefix.includes('@')) {
        let j = q + 1;
        while (j < n) {
          if (text[j] === '"') {
            if (text[j + 1] === '"') {
              j += 2;
              continue;
            }
            break;
          }
          j++;
        }
        blank(out, text, q + 1, j);
        i = Math.min(j + 1, n);
        continue;
      }
    }
    if (o.tripleQuote && ch === '"' && next === '"' && text[i + 2] === '"') {
      const close = text.indexOf('"""', i + 3);
      blank(out, text, i + 3, close === -1 ? n : close);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (o.heredoc && ch === '<' && text.startsWith('<<<', i)) {
      const open = /^<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1\r?\n/.exec(text.slice(i, i + 80));
      if (open) {
        const bodyStart = i + open[0].length;
        const endRe = new RegExp(`^[ \\t]*${open[2]}\\b`, 'm');
        const m = endRe.exec(text.slice(bodyStart));
        const close = m ? bodyStart + m.index : n;
        blank(out, text, bodyStart, close);
        i = close;
        continue;
      }
    }
    if (o.backtick && ch === '`') {
      const close = text.indexOf('`', i + 1);
      blank(out, text, i + 1, close === -1 ? n : close);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (ch === '"') {
      i = quoted(i, '"', !!o.multilineString);
      continue;
    }
    if (ch === '\'') {
      if (o.quote === 'string') {
        i = quoted(i, '\'', true);
        continue;
      }
      // 字元：'x'、'\n'、'\u{1F600}'、'\x41'
      const m = /^'(?:\\(?:u\{[0-9A-Fa-f]{1,6}\}|x[0-9A-Fa-f]{2}|[0-7]{1,3}|.)|[^\\'\n])'/u.exec(text.slice(i, i + 16));
      if (m) {
        blank(out, text, i + 1, i + m[0].length - 1);
        i += m[0].length;
        continue;
      }
      if (o.quote === 'rust' || prevWord) {
        // Rust 生命週期 'a、C++14 數字分隔 1'000：不是字元
        i++;
        continue;
      }
      i = quoted(i, '\'', false);
      continue;
    }
    i++;
  }
  return n;
}
