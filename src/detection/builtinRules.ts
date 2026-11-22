import { DetectionRule } from './types';

/** 內建 Django／HTML 規則的 include 會在執行時換成設定 `detection.templateFiles` 的值。 */
export const TEMPLATE_FILES_PLACEHOLDER = '${templateFiles}';

const JS_LANGS = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];
const TEMPLATE_LANGS = ['html', 'django-html', 'jinja-html', 'jinja'];
const ID = '[A-Za-z_$][\\w$]*';
/**
 * 箭頭函式的參數列 (…)：可跨行、可有一層括號（now = Date.now()）、可有泛型 Array<T>；
 * 不能有 JSX 的 <Tag（const x = (<div>…</div>) 不是函式），也排除立即執行的 (() => …)()。
 */
const PARAMS = String.raw`\((?:[^()<]|\([^()]*\)|(?<=\w)<)*\)`;
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

// ---- C 家族共用片段 ----
/** 樣板參數 <…>：最多三層巢狀，< 與 > 必須成對（只有一種切法，長行也不會卡住）。 */
const G_TEXT = String.raw`[^;{}()<>\n]*`;
const GENERIC = String.raw`<${G_TEXT}(?:<${G_TEXT}(?:<${G_TEXT}>${G_TEXT})*>${G_TEXT})*>`;
const C_LANGS = ['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp'];
/** 後面先遇到 { 才算有本體（遇到 ; 或 } 表示只是宣告或呼叫）。 */
const HAS_BODY = String.raw`(?=[^;{}]*\{)`;
/**
 * 型別名稱後面接本體：可有 final、繼承（: public Base），然後是 {（可在下一行）。
 * 排除 struct point p = { 1, 2 }; 這類初始化，以及 struct point *make_point() 這種回傳型別。
 */
const TYPE_BODY = String.raw`(?=[ \t]*(?:final\b[ \t]*)?(?::[^;{}()=]*)?\s*\{)`;
/** 不會是函式定義開頭或名稱的關鍵字（struct、enum 可以是回傳型別的開頭，例如 struct foo *create()，不放這裡）。 */
const C_KW =
  'if|else|for|while|do|switch|case|default|return|sizeof|alignof|decltype|catch|try|throw|new|delete|goto|using|typedef|namespace|template|static_assert|co_return|co_await|co_yield';
/** 回傳型別的一個詞：int、std::vector<int>、unsigned、const… */
const C_TYPE = String.raw`[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:${GENERIC})?`;
/** 函式名稱：foo、Class::foo、ns::Class<T>::foo、~Foo、operator== */
const C_NAME = String.raw`(?:[A-Za-z_]\w*(?:${GENERIC})?::)*(?:~?[A-Za-z_]\w*|operator[ \t]*(?:\(\)|[^\s(]+))`;
/** 有回傳型別的函式定義（至少一個型別詞，指標、參考可以黏在名稱前）。 */
const C_FUNCTION = String.raw`^[ \t]*(?!(?:${C_KW})\b)(?:${C_TYPE}[ \t*&]+)+(?!(?:${C_KW})\b)(?<name>${C_NAME})[ \t]*\(${HAS_BODY}`;
/** Rust 的可見性：pub、pub(crate)… */
const RS_VIS = String.raw`(?:pub(?:\([^)\n]*\))?[ \t]+)?`;
const RUST_FN = String.raw`^[ \t]*${RS_VIS}(?:(?:default|const|async|unsafe|extern(?:[ \t]+"[^"\n]*")?)[ \t]+)*fn[ \t]+(?<name>[A-Za-z_]\w*)(?=[^;{}]*\{)`;
/** Java／Kotlin 的 @Annotation（同一行）。 */
const ANNOTATIONS = String.raw`(?:@[A-Za-z_][\w.]*(?:\([^)\n]*\))?[ \t]+)*`;
const JAVA_MOD = String.raw`(?:(?:public|protected|private|static|abstract|final|sealed|non-sealed|strictfp|synchronized|native|default|transient)[ \t]+)*`;
const J_KW = 'if|else|for|while|do|switch|case|return|new|throw|try|catch|finally|synchronized|assert|yield|import|package|throws';
/** Java／C# 的型別：String、List<Map<K, V>>、int[]、java.util.List */
const JVM_TYPE = String.raw`[A-Za-z_][\w.]*(?:${GENERIC})?(?:\[[, ]*\])*`;
/** C# 的 [Attribute]（同一行）。 */
const CS_ATTRS = String.raw`(?:\[[^\]\n]*\][ \t]*)*`;
const CS_MOD = String.raw`(?:(?:public|protected|private|internal|static|abstract|sealed|virtual|override|async|extern|unsafe|new|partial|readonly|ref|file|required|const|volatile)[ \t]+)*`;
const KOTLIN_FUN = String.raw`^[ \t]*${ANNOTATIONS}(?:(?:public|private|protected|internal|override|open|abstract|final|suspend|inline|operator|infix|tailrec|external|actual|expect)[ \t]+)*fun[ \t]+(?:<[^>\n]*>[ \t]*)?(?:[A-Za-z_][\w.]*(?:<[^>\n]*>)?\??\.)?(?<name>[A-Za-z_]\w*)`;
const SWIFT_FUNC = String.raw`^[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]+)*(?:(?:public|private|fileprivate|internal|open|final|static|class|override|mutating|nonmutating|convenience|required|nonisolated)[ \t]+)*(?:func[ \t]+|(?=(?:init|deinit)[?!]?[ \t]*[<({]))(?<name>[A-Za-z_]\w*)`;
const RUBY_DEF = String.raw`^[ \t]*(?:(?:private|protected|public|module_function)[ \t]+)?def[ \t]+(?<name>(?:self\.)?[A-Za-z_]\w*[?!=]?)`;

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
    pattern: `^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+(?<name>${ID})[ \\t]*(?::[^=\\n]+)?=[ \\t]*(?:async[ \\t]+)?(?:<[^>\\n]*>[ \\t]*)?(?:${PARAMS}|${ID})[ \\t]*(?::[^=\\n]+?)?=>`,
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
    id: 'ts-wrapped',
    label: 'const Xxx = memo(() => {})／forwardRef／useCallback',
    languages: JS_LANGS,
    pattern: String.raw`^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+(?<name>${ID})[ \t]*(?::[^=\n]+)?=[ \t]*(?:React\.)?(?:memo|forwardRef|useCallback|observer)[ \t]*(?:<[^>\n]*>)?\(\s*(?:async[ \t]+)?(?:function\b[^(\n]*${PARAMS}|${PARAMS}[ \t]*(?::[^=\n]+?)?=>|${ID}[ \t]*=>)`,
    kind: 'function',
    body: 'call',
  },
  {
    id: 'ts-class-arrow',
    label: 'class 內的 xxx = () => {}',
    languages: JS_LANGS,
    pattern: `^[ \\t]*(?:(?:public|private|protected|static|readonly|override)[ \\t]+)*(?<name>#?${ID})[ \\t]*(?::[^=\\n]+)?=[ \\t]*(?:async[ \\t]+)?(?:${PARAMS}|${ID})[ \\t]*(?::[^=\\n]+?)?=>`,
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
    pattern: `^[ \\t]*(?<name>${ID})[ \\t]*:[ \\t]*(?:async[ \\t]+)?(?:function\\b|(?:${PARAMS}|${ID})[ \\t]*(?::[^=\\n]+?)?=>(?=[ \\t]*\\{))`,
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

  // ---------- C／C++（也適用 CUDA、Objective-C 的 C 部分） ----------
  // 只抓有本體的定義（後面先遇到 { 才算），只有宣告（; 結尾）的不抓
  {
    id: 'cpp-namespace',
    label: 'namespace xxx {}',
    languages: C_LANGS,
    pattern: String.raw`^[ \t]*(?:inline[ \t]+)?namespace[ \t]+(?<name>[A-Za-z_][\w:]*)(?=[^;{}]*\{)`,
    kind: 'block',
    body: 'brace',
  },
  {
    id: 'cpp-class',
    label: 'class／struct／union xxx {}',
    languages: C_LANGS,
    pattern: String.raw`^[ \t]*(?:template[ \t]*<[^\n]*>[ \t]*)?(?:typedef[ \t]+)?(?:class|struct|union)[ \t]+(?:(?:alignas\([^)\n]*\)|__declspec\([^)\n]*\)|__attribute__\(\([^\n]*?\)\)|[A-Z][A-Z0-9_]*_(?:API|EXPORT|DLL)[A-Z0-9_]*)[ \t]+)*(?<name>[A-Za-z_]\w*)${TYPE_BODY}`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'cpp-enum',
    label: 'enum (class) xxx {}',
    languages: C_LANGS,
    pattern: String.raw`^[ \t]*(?:typedef[ \t]+)?enum(?:[ \t]+(?:class|struct))?[ \t]+(?<name>[A-Za-z_]\w*)${TYPE_BODY}`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'cpp-method',
    label: 'class 內的 type xxx() {}',
    languages: C_LANGS,
    pattern: C_FUNCTION,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
  {
    id: 'cpp-ctor',
    label: 'class 內的建構子 Xxx() {}',
    languages: C_LANGS,
    pattern: String.raw`^[ \t]*(?:(?:explicit|inline|constexpr|virtual)[ \t]+)*(?!(?:${C_KW})\b)(?<name>~?[A-Za-z_]\w*)[ \t]*\(${HAS_BODY}`,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
  {
    id: 'cpp-function',
    label: 'type xxx() {}、type Class::xxx() {}',
    languages: C_LANGS,
    pattern: C_FUNCTION,
    kind: 'function',
    body: 'brace',
  },
  {
    id: 'cpp-qualified',
    label: 'Class::Class() {}（類別外的建構子、解構子）',
    languages: C_LANGS,
    pattern: String.raw`^[ \t]*(?:(?:inline|constexpr)[ \t]+)?(?<name>(?:[A-Za-z_]\w*(?:${GENERIC})?::)+~?[A-Za-z_]\w*)[ \t]*\(${HAS_BODY}`,
    kind: 'method',
    body: 'brace',
  },

  // ---------- Rust ----------
  {
    id: 'rust-impl-trait',
    label: 'impl Trait for Type {}',
    languages: ['rust'],
    pattern: String.raw`^[ \t]*(?:unsafe[ \t]+)?impl(?:[ \t]*<[^{\n]*?>)?[ \t]+!?(?<trait>[A-Za-z_][\w:]*(?:<[^{\n]*?>)?)[ \t]+for[ \t]+(?<name>[A-Za-z_][\w:]*)`,
    nameTemplate: '${trait} for ${name}',
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'rust-impl',
    label: 'impl Type {}',
    languages: ['rust'],
    pattern: String.raw`^[ \t]*(?:unsafe[ \t]+)?impl(?:[ \t]*<[^{\n]*?>)?[ \t]+(?<name>[A-Za-z_][\w:]*)(?:<[^{\n]*?>)?(?=[ \t]*(?:\{|where\b|\r?\n))`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'rust-type',
    label: 'struct／enum／trait／union xxx',
    languages: ['rust'],
    pattern: String.raw`^[ \t]*${RS_VIS}(?:unsafe[ \t]+)?(?:struct|enum|trait|union)[ \t]+(?<name>[A-Za-z_]\w*)`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'rust-mod',
    label: 'mod xxx {}',
    languages: ['rust'],
    pattern: String.raw`^[ \t]*${RS_VIS}mod[ \t]+(?<name>[A-Za-z_]\w*)(?=[ \t]*\{)`,
    kind: 'block',
    body: 'brace',
  },
  {
    id: 'rust-method',
    label: 'impl／trait 內的 fn xxx() {}',
    languages: ['rust'],
    pattern: RUST_FN,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
  {
    id: 'rust-fn',
    label: 'fn xxx() {}',
    languages: ['rust'],
    pattern: RUST_FN,
    kind: 'function',
    body: 'brace',
  },
  {
    id: 'rust-macro',
    label: 'macro_rules! xxx {}',
    languages: ['rust'],
    pattern: String.raw`^[ \t]*macro_rules![ \t]*(?<name>[A-Za-z_]\w*)`,
    kind: 'macro',
    body: 'brace',
  },

  // ---------- Go ----------
  {
    id: 'go-method',
    label: 'func (s *Server) Xxx() {}',
    languages: ['go'],
    pattern: String.raw`^func[ \t]*\([ \t]*(?:[A-Za-z_]\w*[ \t]+)?\*?[ \t]*(?<recv>[A-Za-z_]\w*)(?:\[[^\]\n]*\])?[ \t]*\)[ \t]*(?<name>[A-Za-z_]\w*)`,
    nameTemplate: '${recv}.${name}',
    kind: 'method',
    body: 'brace',
  },
  {
    id: 'go-func',
    label: 'func Xxx() {}',
    languages: ['go'],
    pattern: String.raw`^func[ \t]+(?<name>[A-Za-z_]\w*)`,
    kind: 'function',
    body: 'brace',
  },
  {
    id: 'go-type',
    label: 'type Xxx struct／interface {}',
    languages: ['go'],
    pattern: String.raw`^[ \t]*(?:type[ \t]+)?(?<name>[A-Za-z_]\w*)(?:\[[^\]\n]*\])?[ \t]+(?:struct|interface)(?=[ \t]*\{)`,
    kind: 'class',
    body: 'brace',
  },

  // ---------- Java ----------
  {
    id: 'java-type',
    label: 'class／interface／enum／record Xxx',
    languages: ['java'],
    pattern: String.raw`^[ \t]*${ANNOTATIONS}${JAVA_MOD}(?:class|interface|enum|record|@interface)[ \t]+(?<name>[A-Za-z_]\w*)`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'java-method',
    label: 'class 內的 Type xxx() {}',
    languages: ['java'],
    pattern: String.raw`^[ \t]*${ANNOTATIONS}${JAVA_MOD}(?:<[^>\n]*>[ \t]*)?(?!(?:${J_KW})\b)${JVM_TYPE}[ \t]+(?!(?:${J_KW})\b)(?<name>[A-Za-z_]\w*)[ \t]*\(${HAS_BODY}`,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
  {
    id: 'java-ctor',
    label: 'class 內的建構子 Xxx() {}',
    languages: ['java'],
    pattern: String.raw`^[ \t]*${ANNOTATIONS}(?:(?:public|protected|private)[ \t]+)?(?<name>[A-Z]\w*)[ \t]*\(${HAS_BODY}`,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },

  // ---------- C# ----------
  {
    id: 'cs-namespace',
    label: 'namespace Xxx',
    languages: ['csharp'],
    pattern: String.raw`^[ \t]*namespace[ \t]+(?<name>[A-Za-z_][\w.]*)`,
    kind: 'block',
    body: 'brace',
  },
  {
    id: 'cs-type',
    label: 'class／struct／interface／enum／record Xxx',
    languages: ['csharp'],
    pattern: String.raw`^[ \t]*${CS_ATTRS}${CS_MOD}(?:class|struct|interface|enum|record(?:[ \t]+(?:class|struct))?)[ \t]+(?<name>[A-Za-z_]\w*)`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'cs-method',
    label: 'class 內的 Type Xxx() {}／=> …',
    languages: ['csharp'],
    pattern: String.raw`^[ \t]*${CS_ATTRS}${CS_MOD}(?!(?:${J_KW}|await|using|lock|foreach|fixed|checked|unchecked)\b)${JVM_TYPE}\??[ \t]+(?!(?:${J_KW})\b)(?<name>[A-Za-z_]\w*)[ \t]*(?:<[^>\n]*>)?[ \t]*\((?=[^;{}]*(?:\{|=>))`,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
  {
    id: 'cs-ctor',
    label: 'class 內的建構子 Xxx() {}',
    languages: ['csharp'],
    pattern: String.raw`^[ \t]*${CS_ATTRS}(?:(?:public|protected|private|internal|static)[ \t]+)*(?<name>[A-Z]\w*)[ \t]*\(${HAS_BODY}`,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },

  // ---------- Kotlin ----------
  {
    id: 'kt-type',
    label: 'class／interface／object Xxx',
    languages: ['kotlin'],
    pattern: String.raw`^[ \t]*${ANNOTATIONS}(?:(?:public|private|protected|internal|open|abstract|sealed|data|enum|annotation|inner|value|inline|companion|fun)[ \t]+)*(?:class|interface|object)[ \t]+(?<name>[A-Za-z_]\w*)`,
    kind: 'class',
    body: 'brace',
    optionalBody: true,
  },
  {
    id: 'kt-method',
    label: 'class 內的 fun xxx()',
    languages: ['kotlin'],
    pattern: KOTLIN_FUN,
    kind: 'method',
    body: 'brace',
    optionalBody: true,
    within: ['class'],
  },
  {
    id: 'kt-fun',
    label: 'fun xxx()',
    languages: ['kotlin'],
    pattern: KOTLIN_FUN,
    kind: 'function',
    body: 'brace',
    optionalBody: true,
  },

  // ---------- Swift ----------
  {
    id: 'swift-type',
    label: 'class／struct／enum／protocol／extension Xxx',
    languages: ['swift'],
    pattern: String.raw`^[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]+)*(?:(?:public|private|fileprivate|internal|open|final|indirect)[ \t]+)*(?:class|struct|enum|protocol|extension|actor)[ \t]+(?<name>[A-Za-z_][\w.]*)`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'swift-method',
    label: '型別內的 func xxx()／init()',
    languages: ['swift'],
    pattern: SWIFT_FUNC,
    kind: 'method',
    body: 'brace',
    optionalBody: true,
    within: ['class'],
  },
  {
    id: 'swift-func',
    label: 'func xxx()',
    languages: ['swift'],
    pattern: SWIFT_FUNC,
    kind: 'function',
    body: 'brace',
    optionalBody: true,
  },

  // ---------- PHP ----------
  {
    id: 'php-type',
    label: 'class／interface／trait／enum Xxx',
    languages: ['php'],
    pattern: String.raw`^[ \t]*(?:(?:abstract|final|readonly)[ \t]+)*(?:class|interface|trait|enum)[ \t]+(?<name>[A-Za-z_]\w*)`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'php-method',
    label: 'class 內的 function xxx() {}',
    languages: ['php'],
    pattern: String.raw`^[ \t]*(?:(?:public|protected|private|static|abstract|final)[ \t]+)*function[ \t]+&?[ \t]*(?<name>[A-Za-z_]\w*)[ \t]*\(${HAS_BODY}`,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
  {
    id: 'php-function',
    label: 'function xxx() {}',
    languages: ['php'],
    pattern: String.raw`^[ \t]*function[ \t]+&?[ \t]*(?<name>[A-Za-z_]\w*)[ \t]*\(${HAS_BODY}`,
    kind: 'function',
    body: 'brace',
  },

  // ---------- Ruby（以縮排對齊的 end 結尾） ----------
  {
    id: 'rb-class',
    label: 'class／module Xxx … end',
    languages: ['ruby'],
    pattern: String.raw`^[ \t]*(?:class|module)[ \t]+(?<name>[A-Z]\w*(?:::[A-Z]\w*)*)`,
    kind: 'class',
    body: 'end',
  },
  {
    id: 'rb-method',
    label: 'class 內的 def xxx … end',
    languages: ['ruby'],
    pattern: RUBY_DEF,
    kind: 'method',
    body: 'end',
    within: ['class'],
  },
  {
    id: 'rb-def',
    label: 'def xxx … end',
    languages: ['ruby'],
    pattern: RUBY_DEF,
    kind: 'function',
    body: 'end',
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
