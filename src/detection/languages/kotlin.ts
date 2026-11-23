import { DetectionRule } from '../types';
import { LanguageDef } from './define';
import { ANNOTATIONS } from './fragments';

const KOTLIN_FUN = String.raw`^[ \t]*${ANNOTATIONS}(?:(?:public|private|protected|internal|override|open|abstract|final|suspend|inline|operator|infix|tailrec|external|actual|expect)[ \t]+)*fun[ \t]+(?:<[^>\n]*>[ \t]*)?(?:[A-Za-z_][\w.]*(?:<[^>\n]*>)?\??\.)?(?<name>[A-Za-z_]\w*)`;

const rules: DetectionRule[] = [
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
];

export const kotlin: LanguageDef = {
  syntax: { kotlin: 'kotlin' },
  extensions: { '.kt': 'kotlin', '.kts': 'kotlin' },
  projectExtensions: ['kt', 'kts'],
  rules,
};
