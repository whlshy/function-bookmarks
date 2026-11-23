import { DetectionRule } from '../types';
import { LanguageDef } from './define';
import { HAS_BODY, JVM_TYPE, J_KW } from './fragments';

/** C# 的 [Attribute]（同一行）。 */
const CS_ATTRS = String.raw`(?:\[[^\]\n]*\][ \t]*)*`;
const CS_MOD = String.raw`(?:(?:public|protected|private|internal|static|abstract|sealed|virtual|override|async|extern|unsafe|new|partial|readonly|ref|file|required|const|volatile)[ \t]+)*`;

const rules: DetectionRule[] = [
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
];

export const csharp: LanguageDef = {
  syntax: { csharp: 'csharp' },
  extensions: { '.cs': 'csharp' },
  projectExtensions: ['cs'],
  rules,
};
