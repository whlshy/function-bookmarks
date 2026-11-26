import { DetectionRule } from '../types';
import { LanguageDef } from './define';

const rules: DetectionRule[] = [
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
];

export const python: LanguageDef = {
  syntax: { python: 'python' },
  extensions: { '.py': 'python', '.pyi': 'python' },
  projectExtensions: ['py', 'pyi'],
  rules,
};
