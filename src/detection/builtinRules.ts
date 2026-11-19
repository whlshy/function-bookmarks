import { DetectionRule } from './types';

/** 內建 Django／HTML 規則的 include 會在執行時換成設定 `detection.templateFiles` 的值。 */
export const TEMPLATE_FILES_PLACEHOLDER = '${templateFiles}';

const JS_LANGS = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];
const TEMPLATE_LANGS = ['html', 'django-html', 'jinja-html', 'jinja'];
const ID = '[A-Za-z_$][\\w$]*';
const KEYWORDS = 'if|for|while|switch|catch|function|return|with|else|do|try|new|typeof|await|yield|super|this';
const TPL_INCLUDE = [TEMPLATE_FILES_PLACEHOLDER];

// ---- 事件監聽與 ajax 用的片段（matchRaw：可讀取字串內容） ----
/** 字串：'x'、"x"、`x`，內容放進指定群組。 */
const str = (q: string, g: string) => String.raw`(?<${q}>['"\x60])(?<${g}>[^'"\x60\n]+)\k<${q}>`;
/** jQuery 選取：$('#id')、$("…")、$(this)、$(document)、$(window)、$(變數) */
const JQ = String.raw`(?<![\w$.])(?:\$|jQuery)\(\s*(?:${str('q', 'sel')}|(?<obj>this|document|window|[A-Za-z_$][\w$]*))\s*\)`;
/** 中間串接的呼叫，例如 .off('click') */
const CHAIN = String.raw`(?:\s*\.\s*[A-Za-z_$][\w$]*\([^()\n]*\))*`;
/** 行內的處理函式：function、箭頭函式 */
const HANDLER = String.raw`(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)`;
/** addEventListener／onclick 的對象，例如 document.getElementById('x')、btn、window */
const TARGET = String.raw`(?<![\w$.])(?<target>(?:[A-Za-z_$][\w$]*(?:\([^()\n]*\))?\s*\.\s*)*?[A-Za-z_$][\w$]*(?:\([^()\n]*\))?)`;
const URL = String.raw`(?:${str('q', 'url')}|(?<urlVar>[A-Za-z_$][\w$.]*))`;
/** 物件字面值內（允許兩層巢狀）往後找某個屬性 */
const IN_OBJECT = String.raw`\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?`;
/**
 * 可有可無的前瞻比對（用來取出後面的屬性值）。
 * 不能寫成 `(?=…)?`：JavaScript 會把不佔字元的重複當成比對 0 次，群組永遠取不到值。
 */
const optional = (lookahead: string) => `(?:(?=${lookahead})|)`;
/** ajax 底下不顯示的回呼：success、error、complete、beforeSend 等 */
const CALLBACK_RULES = ['ts-object-fn', 'ts-method', 'ts-function-expr'];
const JQ_EVENTS =
  'click|dblclick|change|submit|keyup|keydown|keypress|focus|focusin|focusout|blur|input|hover|mouseenter|mouseleave|mouseover|mouseout|scroll|resize|select';

/**
 * 內建規則。順序有意義：同一個名稱被多條規則抓到時，排在前面的優先。
 * 每條規則都有對應的測試範例（test/unit/builtinRules.test.ts）。
 */
export const BUILTIN_RULES: DetectionRule[] = [
  // ---------- TypeScript / JavaScript ----------
  {
    id: 'ts-class',
    label: 'class',
    languages: JS_LANGS,
    pattern: `^[ \\t]*(?:export[ \\t]+)?(?:default[ \\t]+)?(?:declare[ \\t]+)?(?:abstract[ \\t]+)?class[ \\t]+(?<name>${ID})`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'ts-function',
    label: 'function xxx() {}',
    languages: JS_LANGS,
    pattern: `^[ \\t]*(?:export[ \\t]+)?(?:default[ \\t]+)?(?:declare[ \\t]+)?(?:async[ \\t]+)?function[ \\t]*\\*?[ \\t]*(?<name>${ID})(?=[ \\t]*[<(])`,
    kind: 'function',
    body: 'brace',
  },
  {
    id: 'ts-arrow',
    label: 'const xxx = () => {}',
    languages: JS_LANGS,
    pattern: `^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+(?<name>${ID})[ \\t]*(?::[^=\\n]+)?=[ \\t]*(?:async[ \\t]+)?(?:<[^>\\n]*>[ \\t]*)?(?:\\([^)]*\\)|${ID})[ \\t]*(?::[^=\\n]+?)?=>`,
    kind: 'function',
    body: 'brace',
  },
  {
    id: 'ts-function-expr',
    label: 'const xxx = function () {}',
    languages: JS_LANGS,
    pattern: `^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+(?<name>${ID})[ \\t]*(?::[^=\\n]+)?=[ \\t]*(?:async[ \\t]+)?function\\b`,
    kind: 'function',
    body: 'brace',
  },
  {
    id: 'ts-class-arrow',
    label: 'class 內的 xxx = () => {}',
    languages: JS_LANGS,
    pattern: `^[ \\t]*(?:(?:public|private|protected|static|readonly|override)[ \\t]+)*(?<name>#?${ID})[ \\t]*(?::[^=\\n]+)?=[ \\t]*(?:async[ \\t]+)?(?:\\([^)]*\\)|${ID})[ \\t]*(?::[^=\\n]+?)?=>`,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
  {
    id: 'ts-method',
    label: 'xxx() {}',
    languages: JS_LANGS,
    pattern: `^[ \\t]*(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)[ \\t]+)*\\*?[ \\t]*(?!(?:${KEYWORDS})\\b)(?!(?:\\$|jQuery)[ \\t]*\\()(?<name>#?${ID})[ \\t]*(?:<[^>\\n]*>)?(?=[ \\t]*\\([^()]*\\)[ \\t]*(?::[^{;\\n]+)?\\{)`,
    kind: 'method',
    body: 'brace',
  },
  {
    id: 'ts-object-fn',
    label: 'xxx: () => {}',
    languages: JS_LANGS,
    pattern: `^[ \\t]*(?<name>${ID})[ \\t]*:[ \\t]*(?:async[ \\t]+)?(?:function\\b|(?:\\([^)]*\\)|${ID})[ \\t]*(?::[^=\\n]+?)?=>(?=[ \\t]*\\{))`,
    kind: 'function',
    body: 'brace',
  },

  // ---------- 事件監聽（jQuery、DOM） ----------
  {
    id: 'js-jquery-event',
    label: "$('#id').on('click', function () {})",
    languages: JS_LANGS,
    pattern: String.raw`${JQ}${CHAIN}\s*\.\s*(?:on|one|bind|delegate|live)\(\s*${str('q2', 'event')}\s*,\s*(?:${str('q3', 'child')}\s*,\s*)?(?:[A-Za-z_$][\w$]*\s*,\s*)?${HANDLER}`,
    nameTemplate: '${sel}${obj} ${event} ${child}',
    matchRaw: true,
    kind: 'event',
    body: 'call',
  },
  {
    id: 'js-jquery-shorthand',
    label: "$('#id').click(function () {})",
    languages: JS_LANGS,
    pattern: String.raw`${JQ}${CHAIN}\s*\.\s*(?<event>${JQ_EVENTS})\(\s*${HANDLER}`,
    nameTemplate: '${sel}${obj} ${event}',
    matchRaw: true,
    kind: 'event',
    body: 'call',
  },
  {
    id: 'js-ready',
    label: '$(document).ready(function () {}) / $(function () {})',
    languages: JS_LANGS,
    pattern: String.raw`(?<![\w$.])(?:\$|jQuery)\(\s*(?:document\s*\)\s*\.\s*ready\(\s*${HANDLER}|(?:async\s+)?(?:function\b|\(\s*\)\s*=>))`,
    nameTemplate: 'document ready',
    matchRaw: true,
    kind: 'event',
    body: 'call',
  },
  {
    id: 'js-add-listener',
    label: "el.addEventListener('click', function () {})",
    languages: JS_LANGS,
    pattern: String.raw`${TARGET}\s*\.\s*addEventListener\(\s*${str('q', 'event')}\s*,\s*${HANDLER}`,
    nameTemplate: '${target} ${event}',
    matchRaw: true,
    kind: 'event',
    body: 'call',
  },
  {
    id: 'js-on-prop',
    label: 'el.onclick = function () {}',
    languages: JS_LANGS,
    pattern: String.raw`${TARGET}\s*\.\s*on(?<event>[a-z]+)\s*=\s*${HANDLER}`,
    nameTemplate: '${target} ${event}',
    matchRaw: true,
    kind: 'event',
    body: 'brace',
  },

  // ---------- 網路請求（ajax、fetch、axios）：success／error 等回呼會收在底下 ----------
  {
    id: 'js-ajax',
    label: "$.ajax({ url: '/x', type: 'GET' })",
    languages: JS_LANGS,
    pattern: String.raw`(?<![\w$.])(?:\$|jQuery)\.ajax\(\s*${optional(String.raw`${IN_OBJECT}\burl\s*:\s*${URL}`)}${optional(String.raw`${IN_OBJECT}\b(?:type|method)\s*:\s*${str('q2', 'type')}`)}`,
    nameTemplate: '${type:upper|AJAX} ${url}${urlVar}',
    matchRaw: true,
    hideChildren: CALLBACK_RULES,
    kind: 'request',
    body: 'call',
  },
  {
    id: 'js-ajax-short',
    label: "$.get('/x', …) / $.post / $.getJSON",
    languages: JS_LANGS,
    pattern: String.raw`(?<![\w$.])(?:\$|jQuery)\.(?<method>get|post|getJSON|getScript)\(\s*${URL}`,
    nameTemplate: '${method:upper} ${url}${urlVar}',
    matchRaw: true,
    hideChildren: CALLBACK_RULES,
    kind: 'request',
    body: 'call',
  },
  {
    id: 'js-fetch',
    label: "fetch('/x', { method: 'POST' })",
    languages: JS_LANGS,
    pattern: String.raw`(?<![\w$.])fetch\(\s*${URL}${optional(String.raw`[^;]*?\bmethod\s*:\s*${str('q2', 'method')}`)}`,
    nameTemplate: '${method:upper|GET} ${url}${urlVar}',
    matchRaw: true,
    hideChildren: CALLBACK_RULES,
    kind: 'request',
    body: 'call',
  },
  {
    id: 'js-axios',
    label: "axios.get('/x')",
    languages: JS_LANGS,
    pattern: String.raw`(?<![\w$.])axios\.(?<method>get|post|put|patch|delete|head|options)\(\s*${URL}`,
    nameTemplate: '${method:upper} ${url}${urlVar}',
    matchRaw: true,
    hideChildren: CALLBACK_RULES,
    kind: 'request',
    body: 'call',
  },

  // ---------- Python ----------
  {
    id: 'py-class',
    label: 'class Xxx:',
    languages: ['python'],
    pattern: '^[ \\t]*class[ \\t]+(?<name>[A-Za-z_]\\w*)',
    kind: 'class',
    body: 'indent',
  },
  {
    id: 'py-method',
    label: 'class 內的 def xxx():',
    languages: ['python'],
    pattern: '^[ \\t]*(?:async[ \\t]+)?def[ \\t]+(?<name>[A-Za-z_]\\w*)(?=[ \\t]*[\\[(])',
    kind: 'method',
    body: 'indent',
    within: ['class'],
  },
  {
    id: 'py-def',
    label: 'def xxx():',
    languages: ['python'],
    pattern: '^[ \\t]*(?:async[ \\t]+)?def[ \\t]+(?<name>[A-Za-z_]\\w*)(?=[ \\t]*[\\[(])',
    kind: 'function',
    body: 'indent',
  },

  // ---------- Markdown：標題當成目錄 ----------
  {
    id: 'md-heading',
    label: '# 標題',
    languages: ['markdown'],
    pattern: String.raw`^[ \t]{0,3}(?<level>#{1,6})[ \t]+(?<name>[^\r\n]*?[^\s#][^\r\n]*?)(?:[ \t]+#+)?[ \t]*$`,
    kind: 'heading',
    body: 'heading',
  },
  {
    id: 'md-setext',
    label: '標題\n=====',
    languages: ['markdown'],
    pattern: String.raw`^(?![ \t]*(?:[-*+>#|]|\d+[.)])[ \t])[ \t]{0,3}(?<name>[^\s][^\r\n]*?)[ \t]*\r?\n[ \t]{0,3}(?<under>=+|-+)[ \t]*$`,
    kind: 'heading',
    body: 'heading',
  },

  // ---------- Django / Jinja template ----------
  {
    id: 'dj-block',
    label: '{% block %}',
    languages: TEMPLATE_LANGS,
    pattern: '\\{%-?[ \\t]*block[ \\t]+(?<name>\\w+)[ \\t]*-?%\\}',
    end: '\\{%-?[ \\t]*endblock(?:[ \\t]+\\w+)?[ \\t]*-?%\\}',
    kind: 'block',
    body: 'pair',
    include: TPL_INCLUDE,
  },
  {
    id: 'dj-partial',
    label: '{% partialdef %}',
    languages: TEMPLATE_LANGS,
    pattern: '\\{%-?[ \\t]*partialdef[ \\t]+(?<name>[\\w-]+)(?:[ \\t]+inline)?[ \\t]*-?%\\}',
    end: '\\{%-?[ \\t]*endpartialdef(?:[ \\t]+[\\w-]+)?[ \\t]*-?%\\}',
    kind: 'partial',
    body: 'pair',
    include: TPL_INCLUDE,
  },
  {
    id: 'jinja-macro',
    label: '{% macro %}',
    languages: TEMPLATE_LANGS,
    pattern: '\\{%-?[ \\t]*macro[ \\t]+(?<name>\\w+)[ \\t]*\\(',
    end: '\\{%-?[ \\t]*endmacro[ \\t]*-?%\\}',
    kind: 'macro',
    body: 'pair',
    include: TPL_INCLUDE,
  },
  {
    id: 'dj-extends',
    label: '{% extends %}',
    languages: TEMPLATE_LANGS,
    pattern: '\\{%-?[ \\t]*extends[ \\t]+(?<q>["\'])(?<name>(?<target>[^"\'\\n]+))\\k<q>',
    kind: 'reference',
    body: 'line',
    include: TPL_INCLUDE,
  },
  {
    id: 'dj-include',
    label: '{% include %}',
    languages: TEMPLATE_LANGS,
    pattern: '\\{%-?[ \\t]*include[ \\t]+(?<q>["\'])(?<name>(?<target>[^"\'\\n]+))\\k<q>',
    kind: 'reference',
    body: 'line',
    include: TPL_INCLUDE,
  },
  {
    id: 'html-script',
    label: '<script> 內的 JS',
    languages: TEMPLATE_LANGS,
    pattern: '<script\\b(?![^>]*\\bsrc[ \\t]*=)[^>]*>',
    end: '</script[ \\t]*>',
    kind: 'block',
    body: 'embedded',
    embeddedLanguage: 'javascript',
    include: TPL_INCLUDE,
  },
  {
    id: 'html-event-attr',
    label: '<button onclick="…">',
    languages: TEMPLATE_LANGS,
    pattern: String.raw`<(?<tag>[a-zA-Z][\w-]*)\b[^>]*?\bon(?<event>[a-z]+)[ \t]*=[ \t]*(?<q>["'])(?<handler>[^"'\n]{1,80})\k<q>`,
    nameTemplate: '${tag} on${event} → ${handler}',
    kind: 'event',
    body: 'line',
    include: TPL_INCLUDE,
  },
  {
    id: 'html-id',
    label: '<tag id="xxx">',
    languages: TEMPLATE_LANGS,
    pattern: '<[a-zA-Z][\\w-]*\\b[^>]*?\\bid[ \\t]*=[ \\t]*["\'](?<name>[^"\'\\n{}]+)["\']',
    kind: 'block',
    body: 'line',
    include: TPL_INCLUDE,
  },
];
