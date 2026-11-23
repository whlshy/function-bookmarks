import { DetectionRule } from '../types';
import { LanguageDef } from './define';

/** sh、bash、zsh 在 VS Code 都是 shellscript。 */
const SHELL_LANGS = ['shellscript'];
/** 本體是 {}（可在下一行）；( … ) 子 shell 本體不列。 */
const BRACE_BODY = String.raw`(?=\s*\{)`;

const rules: DetectionRule[] = [
  // ---------- Shell ----------
  {
    id: 'sh-function',
    label: 'function xxx {}',
    languages: SHELL_LANGS,
    pattern: String.raw`^[ \t]*function[ \t]+(?<name>[^\s(){}<>|&;$'"\x60=#]+)[ \t]*(?:\([ \t]*\))?${BRACE_BODY}`,
    kind: 'function',
    body: 'brace',
  },
  {
    id: 'sh-fn',
    label: 'xxx() {}',
    languages: SHELL_LANGS,
    pattern: String.raw`^[ \t]*(?!function\b)(?<name>[A-Za-z_][\w.:-]*)[ \t]*\([ \t]*\)${BRACE_BODY}`,
    kind: 'function',
    body: 'brace',
  },
];

export const shell: LanguageDef = {
  syntax: { shellscript: 'shell' },
  extensions: { '.sh': 'shellscript', '.bash': 'shellscript', '.zsh': 'shellscript' },
  projectExtensions: ['sh', 'bash', 'zsh'],
  rules,
};
