import { DetectionRule } from './types';

/** 內建 Django／HTML 規則的 include 會在執行時換成設定 `detection.templateFiles` 的值。 */
export const TEMPLATE_FILES_PLACEHOLDER = '${templateFiles}';

const JS_LANGS = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];
const TEMPLATE_LANGS = ['html', 'django-html', 'jinja-html', 'jinja'];
const ID = '[A-Za-z_$][\\w$]*';
const KEYWORDS = 'if|for|while|switch|catch|function|return|with|else|do|try|new|typeof|await|yield|super|this';
const TPL_INCLUDE = [TEMPLATE_FILES_PLACEHOLDER];

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
    pattern: `^[ \\t]*(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)[ \\t]+)*\\*?[ \\t]*(?!(?:${KEYWORDS})\\b)(?<name>#?${ID})[ \\t]*(?:<[^>\\n]*>)?(?=[ \\t]*\\([^)]*\\)[ \\t]*(?::[^{;\\n]+)?\\{)`,
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
    id: 'html-id',
    label: '<tag id="xxx">',
    languages: TEMPLATE_LANGS,
    pattern: '<[a-zA-Z][\\w-]*\\b[^>]*?\\bid[ \\t]*=[ \\t]*["\'](?<name>[^"\'\\n{}]+)["\']',
    kind: 'block',
    body: 'line',
    include: TPL_INCLUDE,
  },
];
