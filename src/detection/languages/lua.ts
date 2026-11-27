import { DetectionRule } from '../types';
import { LanguageDef } from './define';

const N = String.raw`[A-Za-z_]\w*`;

const rules: DetectionRule[] = [
  // ---------- Lua（以縮排對齊的 end 結尾） ----------
  {
    id: 'lua-method',
    label: 'function M:xxx() … end',
    languages: ['lua'],
    pattern: String.raw`^[ \t]*function[ \t]+(?<name>${N}(?:\.${N})*:${N})[ \t]*\(`,
    kind: 'method',
    body: 'end',
  },
  {
    id: 'lua-function',
    label: 'function xxx() … end／local function xxx() … end',
    languages: ['lua'],
    pattern: String.raw`^[ \t]*(?:local[ \t]+)?function[ \t]+(?<name>${N}(?:\.${N})*)[ \t]*\(`,
    kind: 'function',
    body: 'end',
  },
  {
    id: 'lua-assign',
    label: 'xxx = function() … end',
    languages: ['lua'],
    pattern: String.raw`^[ \t]*(?:local[ \t]+)?(?<name>${N}(?:\.${N})*)[ \t]*=[ \t]*function[ \t]*\(`,
    kind: 'function',
    body: 'end',
  },
];

export const lua: LanguageDef = {
  syntax: { lua: 'lua' },
  extensions: { '.lua': 'lua' },
  projectExtensions: ['lua'],
  rules,
};
