import { DetectionRule } from '../types';
import { LanguageDef } from './define';
import { PARAMS } from './fragments';

/** 回傳型別：可以有 error{A, B}!T、struct { … } 這類帶大括號的型別，本體的 { 不會被當成型別。 */
const Z_RET = String.raw`(?:(?:error|struct|enum|union|opaque)[ \t]*(?:\([^)\n]*\))?[ \t]*\{[^{}]*\}|[^{};\n])*`;
const Z_FN = String.raw`^[ \t]*(?:(?:pub|export|inline|noinline)[ \t]+|extern(?:[ \t]+"[^"\n]*")?[ \t]+)*fn[ \t]+(?<name>[A-Za-z_]\w*)[ \t]*${PARAMS}${Z_RET}`;

const rules: DetectionRule[] = [
  // ---------- Zig ----------
  {
    id: 'zig-type',
    label: 'const Xxx = struct／enum／union {}',
    languages: ['zig'],
    pattern: String.raw`^[ \t]*(?:pub[ \t]+)?(?:const|var)[ \t]+(?<name>[A-Za-z_]\w*)(?:[ \t]*:[^=\n]+)?[ \t]*=[ \t]*(?:extern[ \t]+|packed[ \t]+)?(?:struct|enum|union|opaque)\b(?:[ \t]*\([^)\n]*\))?(?=[ \t]*\{)`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'zig-method',
    // Zig 的函式裡不能直接定義函式：出現在 fn 裡的 fn 一定在回傳的 struct 裡（泛型寫法 fn List(T) type { return struct { … } }）
    label: '型別內的 fn xxx() {}',
    languages: ['zig'],
    pattern: Z_FN,
    kind: 'method',
    body: 'brace',
    within: ['class', 'function'],
  },
  {
    id: 'zig-fn',
    label: 'fn xxx() {}',
    languages: ['zig'],
    pattern: Z_FN,
    kind: 'function',
    body: 'brace',
  },
  {
    id: 'zig-test',
    label: 'test "xxx" {}',
    languages: ['zig'],
    pattern: String.raw`^[ \t]*test[ \t]+"(?<name>[^"\n]+)"(?=[ \t]*\{)`,
    matchRaw: true,
    kind: 'block',
    body: 'brace',
  },
];

export const zig: LanguageDef = {
  syntax: { zig: 'zig' },
  extensions: { '.zig': 'zig' },
  projectExtensions: ['zig'],
  rules,
};
