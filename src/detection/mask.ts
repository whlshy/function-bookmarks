import { Syntax } from './types';

/**
 * 把註解與字串內容換成空白（換行保留），長度與原文相同，
 * 讓規則比對與括號配對不會被註解、字串裡的文字干擾。
 */
export function maskText(text: string, syntax: Syntax): string {
  // 檔案開頭的 BOM 當成空白（長度不變），第一行的 # 標題、def 才比對得到
  if (text.charCodeAt(0) === 0xfeff) {
    return maskText(` ${text.slice(1)}`, syntax);
  }
  switch (syntax) {
    case 'c':
      return maskJs(text, false);
    case 'jsx':
      return maskJs(text, true);
    case 'python':
      return maskPython(text);
    case 'template':
      return maskTemplate(text);
    case 'markdown':
      return maskMarkdown(text);
    case 'ruby':
      return maskRuby(text);
    case 'php':
      return maskPhp(text);
    default: {
      const family = C_FAMILY[syntax];
      return family ? maskCFamily(text, family) : text;
    }
  }
}

/** C 家族各語言的註解與字串寫法差異。 */
interface CFamilyOptions {
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

const C_FAMILY: Partial<Record<Syntax, CFamilyOptions>> = {
  cpp: { quote: 'char', cppRaw: true },
  rust: { quote: 'rust', nestedBlock: true, multilineString: true, rustRaw: true },
  go: { quote: 'char', backtick: true },
  java: { quote: 'char', nestedBlock: false, tripleQuote: true },
  kotlin: { quote: 'char', nestedBlock: true, tripleQuote: true },
  csharp: { quote: 'char', verbatim: true, tripleQuote: true },
  php: { quote: 'string', hashComment: true, multilineString: true, heredoc: true },
};

function maskCFamily(text: string, o: CFamilyOptions): string {
  const out = text.split('');
  maskCFamilyInto(text, out, 0, o, false);
  return out.join('');
}

/**
 * 在 `out` 上就地遮掉 [start, …) 的註解與字串，回傳結束位置。
 * `phpClose`：遇到程式碼裡的 ?> 就停（回傳 ?> 的位置）。
 */
function maskCFamilyInto(text: string, out: string[], start: number, o: CFamilyOptions, phpClose: boolean): number {
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
      j += text[j] === '\\' ? 2 : 1;
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

/**
 * PHP：只有 <?php … ?>（或 <?= … ?>）裡面是程式碼，用 C 家族的方式遮；
 * 外面的 HTML 全部遮掉（英文的 don't 之類不會被當成字串開頭，也不會抓到 HTML 裡的文字）。
 * 字串、註解裡的 ?> 不算結束（// 註解裡的 ?> 在 PHP 其實會結束，這裡不處理）。
 */
function maskPhp(text: string): string {
  const out = text.split('');
  const open = /<\?(?:php\b|=)?/g;
  let pos = 0;
  while (pos < text.length) {
    open.lastIndex = pos;
    const m = open.exec(text);
    if (!m) {
      blank(out, text, pos, text.length);
      break;
    }
    blank(out, text, pos, m.index);
    const close = maskCFamilyInto(text, out, m.index + m[0].length, C_FAMILY.php!, true);
    pos = close + 2;
  }
  return out.join('');
}

/** Ruby：# 註解、=begin … =end、字串（可跨行）、heredoc（<<~EOS、<<-EOS）。 */
function maskRuby(text: string): string {
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

export function syntaxForLanguage(languageId: string): Syntax {
  switch (languageId) {
    case 'typescript':
      // .ts 不認 JSX：<型別>值 是型別斷言
      return 'c';
    case 'typescriptreact':
    case 'javascript':
    case 'javascriptreact':
      // React 專案常用 .js 寫 JSX；純 JS 在運算式開頭不會出現 <，不會誤判
      return 'jsx';
    case 'python':
      return 'python';
    case 'html':
    case 'django-html':
    case 'jinja-html':
    case 'jinja':
      return 'template';
    case 'markdown':
      return 'markdown';
    case 'c':
    case 'cpp':
    case 'cuda-cpp':
    case 'objective-c':
    case 'objective-cpp':
      return 'cpp';
    case 'rust':
      return 'rust';
    case 'go':
      return 'go';
    case 'java':
      return 'java';
    case 'kotlin':
    case 'swift':
      return 'kotlin';
    case 'csharp':
      return 'csharp';
    case 'php':
      return 'php';
    case 'ruby':
      return 'ruby';
    default:
      return 'none';
  }
}

function blank(out: string[], text: string, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const ch = text[i];
    out[i] = ch === '\n' || ch === '\r' ? ch : ' ';
  }
}

/** 判斷 `/` 是否為正規表示式字面值的開頭。 */
function regexCanStart(text: string, index: number): boolean {
  let j = index - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) {
    j--;
  }
  if (j < 0 || text[j] === '\n') {
    return true;
  }
  const prev = text[j];
  if ('(,=:[!&|?{};+-*%<>~^'.includes(prev)) {
    return true;
  }
  const word = /([A-Za-z_$][\w$]*)$/.exec(text.slice(Math.max(0, j - 10), j + 1));
  return !!word && ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await'].includes(word[1]);
}

/** JSX 的 < 是否可能在這裡開始：前面是運算式開頭的位置（=、(、return、=>、&&、? 等）。 */
function jsxCanStart(text: string, index: number): boolean {
  const next = text[index + 1] ?? '';
  if (!/[A-Za-z_$>]/.test(next)) {
    return false;
  }
  // TSX 的泛型箭頭函式：<T,>(x) => …、<T extends X>(x) => …
  if (/^<[A-Za-z_$][\w$]*\s*(?:,|extends\b)/.test(text.slice(index, index + 80))) {
    return false;
  }
  let j = index - 1;
  while (j >= 0 && /\s/.test(text[j])) {
    j--;
  }
  if (j < 0) {
    return true;
  }
  if ('(,=:[!&|?{};>'.includes(text[j])) {
    return true;
  }
  const word = /([A-Za-z_$][\w$]*)$/.exec(text.slice(Math.max(0, j - 10), j + 1));
  return !!word && ['return', 'yield', 'default', 'case', 'else', 'do', 'await'].includes(word[1]);
}

/**
 * JavaScript／TypeScript：註解、字串、樣板字串（${} 內照程式碼）、正規表示式。
 * `jsx`：認得 JSX——標籤之間的文字、屬性值當文字遮掉，{…} 裡面照程式碼處理
 * （否則 <p>Don't</p> 的 ' 會被當成字串、</a> 的 / 會被當成正規表示式，大括號就配錯了）。
 */
function maskJs(text: string, jsx: boolean): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  /** 目前的巢狀層數（JSX 元素、樣板字串的 ${}、JSX 的 {…}）。 */
  let nest = 0;
  const MAX_NEST = 300;

  const lineComment = () => {
    const end = text.indexOf('\n', i);
    const stop = end === -1 ? n : end;
    blank(out, text, i, stop);
    i = stop;
  };
  const blockComment = () => {
    const end = text.indexOf('*/', i + 2);
    const stop = end === -1 ? n : end + 2;
    blank(out, text, i, stop);
    i = stop;
  };
  const quoted = (q: string) => {
    let j = i + 1;
    while (j < n && text[j] !== q && text[j] !== '\n') {
      j += text[j] === '\\' ? 2 : 1;
    }
    blank(out, text, i + 1, Math.min(j, n));
    i = Math.min(j + 1, n);
  };
  /** 正規表示式字面值；不是的話回傳 false（當成除號）。 */
  const regex = (): boolean => {
    let j = i + 1;
    let inClass = false;
    while (j < n && text[j] !== '\n') {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '[') {
        inClass = true;
      } else if (c === ']') {
        inClass = false;
      } else if (c === '/' && !inClass) {
        blank(out, text, i + 1, j);
        i = j + 1;
        return true;
      }
      j++;
    }
    return false;
  };
  /** 樣板字串（目前在反引號）：文字遮掉，${…} 照程式碼。 */
  const template = () => {
    i++;
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') {
        blank(out, text, i, Math.min(n, i + 2));
        i += 2;
        continue;
      }
      if (ch === '`') {
        i++;
        return;
      }
      if (ch === '$' && text[i + 1] === '{') {
        i += 2;
        code(true);
        i++;
        continue;
      }
      blank(out, text, i, i + 1);
      i++;
    }
  };
  /** 程式碼；`closeBrace` 時遇到不成對的 } 就停（i 停在 } 上）。 */
  function code(closeBrace: boolean): void {
    if (closeBrace && nest >= MAX_NEST) {
      return;
    }
    nest++;
    try {
      codeBody(closeBrace);
    } finally {
      nest--;
    }
  }
  function codeBody(closeBrace: boolean): void {
    let depth = 0;
    while (i < n) {
      const ch = text[i];
      const next = text[i + 1];
      if (ch === '/' && next === '/') {
        lineComment();
        continue;
      }
      if (ch === '/' && next === '*') {
        blockComment();
        continue;
      }
      if (ch === '\'' || ch === '"') {
        quoted(ch);
        continue;
      }
      if (ch === '`') {
        template();
        continue;
      }
      if (ch === '/' && regexCanStart(text, i) && regex()) {
        continue;
      }
      if (jsx && ch === '<' && jsxCanStart(text, i)) {
        element();
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        if (depth === 0 && closeBrace) {
          return;
        }
        depth--;
      }
      i++;
    }
  }
  /** JSX 元素（目前在 <）：屬性值遮掉，{…} 照程式碼，接著處理子元素。 */
  function element(): void {
    // 極端的巢狀（上千層）不再往下遞迴，避免堆疊爆掉；只影響遮罩精準度
    if (nest >= MAX_NEST) {
      i++;
      return;
    }
    nest++;
    try {
      elementBody();
    } finally {
      nest--;
    }
  }
  function elementBody(): void {
    i++;
    if (text[i] === '>') {
      i++;
      children(); // <>…</>
      return;
    }
    while (i < n && /[\w$.:-]/.test(text[i])) {
      i++;
    }
    while (i < n) {
      const ch = text[i];
      if (ch === '/' && text[i + 1] === '>') {
        i += 2;
        return;
      }
      if (ch === '>') {
        i++;
        children();
        return;
      }
      if (ch === '{') {
        i++;
        code(true);
        i++;
        continue;
      }
      if (ch === '"' || ch === '\'') {
        const close = text.indexOf(ch, i + 1);
        const stop = close === -1 ? n : close;
        blank(out, text, i + 1, stop);
        i = stop + 1;
        continue;
      }
      i++;
    }
  }
  /** JSX 子元素：文字遮掉，{…} 照程式碼，巢狀元素，遇到結束標籤就回到上一層。 */
  function children(): void {
    while (i < n) {
      const ch = text[i];
      if (ch === '<') {
        if (text[i + 1] === '/') {
          const close = text.indexOf('>', i);
          i = close === -1 ? n : close + 1;
          return;
        }
        element();
        continue;
      }
      if (ch === '{') {
        i++;
        code(true);
        i++;
        continue;
      }
      blank(out, text, i, i + 1);
      i++;
    }
  }

  code(false);
  return out.join('');
}

function maskPython(text: string): string {
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
        const close = text.indexOf(ch.repeat(3), i + 3);
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

const TEMPLATE_COMMENT_RE = /\{#[\s\S]*?#\}|\{%-?\s*comment\b[\s\S]*?\{%-?\s*endcomment\s*-?%\}|<!--[\s\S]*?-->/g;

function maskTemplate(text: string): string {
  const out = text.split('');
  for (const m of text.matchAll(TEMPLATE_COMMENT_RE)) {
    blank(out, text, m.index!, m.index! + m[0].length);
  }
  return out.join('');
}

/** Markdown：遮蔽程式碼區塊（``` 與 ~~~）、HTML 註解、檔案開頭的 YAML front matter。 */
function maskMarkdown(text: string): string {
  const out = text.split('');
  const fm = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/.exec(text);
  if (fm) {
    blank(out, text, 0, fm[0].length);
  }
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) {
    blank(out, text, m.index!, m.index! + m[0].length);
  }
  const fence = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open: { index: number; marker: string } | undefined;
  for (const m of text.matchAll(fence)) {
    const marker = m[1];
    if (!open) {
      if (marker[0] === '`' && m[0].slice(m[0].indexOf(marker) + marker.length).includes('`')) {
        continue; // ```js` 這種行內寫法不是區塊
      }
      open = { index: m.index!, marker };
      continue;
    }
    if (marker[0] === open.marker[0] && marker.length >= open.marker.length && m[0].trim() === marker) {
      blank(out, text, open.index, m.index! + m[0].length);
      open = undefined;
    }
  }
  if (open) {
    blank(out, text, open.index, text.length);
  }
  return out.join('');
}
