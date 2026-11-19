import { Syntax } from './types';

/**
 * 把註解與字串內容換成空白（換行保留），長度與原文相同，
 * 讓規則比對與括號配對不會被註解、字串裡的文字干擾。
 */
export function maskText(text: string, syntax: Syntax): string {
  switch (syntax) {
    case 'c':
      return maskCLike(text);
    case 'python':
      return maskPython(text);
    case 'template':
      return maskTemplate(text);
    case 'markdown':
      return maskMarkdown(text);
    default:
      return text;
  }
}

export function syntaxForLanguage(languageId: string): Syntax {
  switch (languageId) {
    case 'typescript':
    case 'typescriptreact':
    case 'javascript':
    case 'javascriptreact':
      return 'c';
    case 'python':
      return 'python';
    case 'html':
    case 'django-html':
    case 'jinja-html':
    case 'jinja':
      return 'template';
    case 'markdown':
      return 'markdown';
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

function maskCLike(text: string): string {
  const out = text.split('');
  const n = text.length;
  // 堆疊：樣板字串內的 ${ } 運算式要當成程式碼處理
  const templateStack: number[] = [];
  let braceDepth = 0;
  let i = 0;

  const maskTemplateBody = (): void => {
    // 目前位置在樣板字串內（反引號之後）
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
        templateStack.push(braceDepth);
        braceDepth++;
        i += 2;
        return;
      }
      blank(out, text, i, i + 1);
      i++;
    }
  };

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(out, text, i, stop);
      i = stop;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== ch && text[j] !== '\n') {
        j += text[j] === '\\' ? 2 : 1;
      }
      blank(out, text, i + 1, Math.min(j, n));
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      i++;
      maskTemplateBody();
      continue;
    }
    if (ch === '/' && regexCanStart(text, i)) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
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
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        blank(out, text, i + 1, j);
        i = j + 1;
        continue;
      }
    }
    if (ch === '{') {
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (templateStack.length && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop();
        i++;
        maskTemplateBody();
        continue;
      }
    }
    i++;
  }
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
        const close = text.indexOf(ch.repeat(3), i + 3);
        const stop = close === -1 ? n : close;
        blank(out, text, i + 3, stop);
        i = close === -1 ? n : close + 3;
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
