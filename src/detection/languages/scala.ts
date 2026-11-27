import { DetectionRule } from '../types';
import { LanguageDef } from './define';

const S_ANN = String.raw`(?:@[A-Za-z_][\w.]*(?:\([^)\n]*\))?[ \t]+)*`;
const S_MOD = String.raw`(?:(?:private|protected)(?:\[[^\]\n]*\])?[ \t]+|(?:final|sealed|abstract|implicit|case|lazy|override|open|transparent|inline|infix|opaque)[ \t]+)*`;
/** 名稱：一般名稱（可接 _= 這類運算子尾巴）、運算子（++、::、+=）、反引號名稱。 */
const S_OP = String.raw`[!#%&*+\-/:<=>?@\\^|~]+`;
const S_DEF = String.raw`^[ \t]*${S_ANN}${S_MOD}def[ \t]+(?<name>[A-Za-z_]\w*(?:_${S_OP})?|${S_OP}|\x60[^\x60\n]+\x60)`;

const rules: DetectionRule[] = [
  // ---------- Scala（大括號，或 Scala 3 的縮排寫法） ----------
  {
    id: 'scala-type',
    label: 'class／object／trait／enum Xxx',
    languages: ['scala'],
    pattern: String.raw`^[ \t]*${S_ANN}${S_MOD}(?:class|object|trait|enum)[ \t]+(?<name>[A-Za-z_]\w*)`,
    kind: 'class',
    body: 'braceOrIndent',
  },
  {
    id: 'scala-method',
    label: '型別內的 def xxx',
    languages: ['scala'],
    pattern: S_DEF,
    kind: 'method',
    body: 'braceOrIndent',
    within: ['class'],
  },
  {
    id: 'scala-def',
    label: 'def xxx',
    languages: ['scala'],
    pattern: S_DEF,
    kind: 'function',
    body: 'braceOrIndent',
  },
];

export const scala: LanguageDef = {
  syntax: { scala: 'scala' },
  extensions: { '.scala': 'scala', '.sc': 'scala' },
  projectExtensions: ['scala', 'sc'],
  rules,
};
