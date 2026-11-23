import { DetectionRule } from '../types';
import { LanguageDef } from './define';
import { HAS_BODY } from './fragments';

const rules: DetectionRule[] = [
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
];

export const php: LanguageDef = {
  syntax: { php: 'php' },
  extensions: { '.php': 'php' },
  projectExtensions: ['php'],
  rules,
};
