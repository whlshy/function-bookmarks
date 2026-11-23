import { DetectionRule } from '../types';
import { LanguageDef } from './define';
import { ANNOTATIONS, HAS_BODY, JVM_TYPE, J_KW } from './fragments';

const JAVA_MOD = String.raw`(?:(?:public|protected|private|static|abstract|final|sealed|non-sealed|strictfp|synchronized|native|default|transient)[ \t]+)*`;

const rules: DetectionRule[] = [
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
];

export const java: LanguageDef = {
  syntax: { java: 'java' },
  extensions: { '.java': 'java' },
  projectExtensions: ['java'],
  rules,
};
