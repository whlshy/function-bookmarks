import { DetectionRule } from '../types';
import { LanguageDef } from './define';
import { PARAMS } from './fragments';

const PS_KW = 'if|elseif|else|while|for|foreach|switch|until|do|try|catch|finally|trap|return|throw|param|begin|process|end|dynamicparam|function|filter|workflow|class|enum|data';
/** [string]、[int[]]、[System.Collections.Generic.List[string]] */
const PS_TYPE = String.raw`\[(?:[^\[\]\n]|\[[^\[\]\n]*\])+\]`;

const rules: DetectionRule[] = [
  // ---------- PowerShell（關鍵字不分大小寫） ----------
  {
    id: 'ps-function',
    label: 'function／filter Verb-Noun {}',
    languages: ['powershell'],
    pattern: String.raw`^[ \t]*(?:function|filter|workflow)[ \t]+(?:(?:global|script|local|private):)?(?<name>[A-Za-z_][\w.-]*)(?=[ \t]*(?:${PARAMS})?\s*\{)`,
    flags: 'i',
    kind: 'function',
    body: 'brace',
  },
  {
    id: 'ps-class',
    label: 'class／enum Xxx {}',
    languages: ['powershell'],
    pattern: String.raw`^[ \t]*(?:class|enum)[ \t]+(?<name>[A-Za-z_]\w*)(?=[^{\n]*\s*\{)`,
    flags: 'i',
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'ps-method',
    label: 'class 內的 [Type] Xxx() {}',
    languages: ['powershell'],
    pattern: String.raw`^[ \t]*(?:(?:static|hidden)[ \t]+)*(?:${PS_TYPE}[ \t]*)?(?!(?:${PS_KW})\b)(?<name>[A-Za-z_]\w*)[ \t]*${PARAMS}(?=\s*(?::[^{\n]*)?\{)`,
    flags: 'i',
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
];

export const powershell: LanguageDef = {
  syntax: { powershell: 'powershell' },
  extensions: { '.ps1': 'powershell', '.psm1': 'powershell' },
  projectExtensions: ['ps1', 'psm1'],
  rules,
};
