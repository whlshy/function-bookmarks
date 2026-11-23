import { DetectionRule } from '../types';
import { LanguageDef } from './define';

const RUBY_DEF = String.raw`^[ \t]*(?:(?:private|protected|public|module_function)[ \t]+)?def[ \t]+(?<name>(?:self\.)?[A-Za-z_]\w*[?!=]?)`;

const rules: DetectionRule[] = [
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
];

export const ruby: LanguageDef = {
  syntax: { ruby: 'ruby' },
  extensions: { '.rb': 'ruby', '.rake': 'ruby' },
  projectExtensions: ['rb', 'rake'],
  rules,
};
