import { DetectionRule } from '../types';
import { LanguageDef } from './define';
import { GENERIC, HAS_BODY } from './fragments';

const C_LANGS = ['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp'];
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

const rules: DetectionRule[] = [
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
];

export const cCpp: LanguageDef = {
  syntax: { c: 'cpp', cpp: 'cpp', 'cuda-cpp': 'cpp', 'objective-c': 'cpp', 'objective-cpp': 'cpp' },
  extensions: { '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c++': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.ipp': 'cpp', '.inl': 'cpp', '.cu': 'cuda-cpp', '.cuh': 'cuda-cpp', '.m': 'objective-c', '.mm': 'objective-cpp' },
  projectExtensions: ['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'cu', 'cuh', 'm', 'mm'],
  rules,
};
