import { blank, escapeStep } from './common';

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
export function maskJs(text: string, jsx: boolean): string {
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
      j += escapeStep(text, j);
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
