import { DetectionRule } from '../types';
import { LanguageDef } from './define';

const rules: DetectionRule[] = [
  // ---------- Go ----------
  {
    id: 'go-method',
    label: 'func (s *Server) Xxx() {}',
    languages: ['go'],
    pattern: String.raw`^func[ \t]*\([ \t]*(?:[A-Za-z_]\w*[ \t]+)?\*?[ \t]*(?<recv>[A-Za-z_]\w*)(?:\[[^\]\n]*\])?[ \t]*\)[ \t]*(?<name>[A-Za-z_]\w*)`,
    nameTemplate: '${recv}.${name}',
    kind: 'method',
    body: 'brace',
  },
  {
    id: 'go-func',
    label: 'func Xxx() {}',
    languages: ['go'],
    pattern: String.raw`^func[ \t]+(?<name>[A-Za-z_]\w*)`,
    kind: 'function',
    body: 'brace',
  },
  {
    id: 'go-type',
    label: 'type Xxx struct／interface {}',
    languages: ['go'],
    pattern: String.raw`^[ \t]*(?:type[ \t]+)?(?<name>[A-Za-z_]\w*)(?:\[[^\]\n]*\])?[ \t]+(?:struct|interface)(?=[ \t]*\{)`,
    kind: 'class',
    body: 'brace',
  },
];

export const go: LanguageDef = {
  syntax: { go: 'go' },
  extensions: { '.go': 'go' },
  projectExtensions: ['go'],
  rules,
};
