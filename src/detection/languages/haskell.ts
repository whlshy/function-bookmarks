import { DetectionRule } from '../types';
import { LanguageDef } from './define';

const HS_KW = 'module|import|where|let|in|do|of|case|if|then|else|data|type|newtype|class|instance|deriving|infixl|infixr|infix|foreign|default|pattern';
const HS_VAR = String.raw`(?!(?:${HS_KW})\b)[a-z_][\w']*`;
/** 單獨的 =（不是 ==、/=、<=、>=、=>）。 */
const EQ = String.raw`(?:^|[^=!<>/:])=(?![=>])`;
/**
 * 型別簽名（name ::），或等式：同一行、或縮排的下一行（guard 寫法）有 = 或 |。
 * 這樣 Template Haskell 的 `makeLenses ''Foo` 這類頂層呼叫不會被當成函式。
 */
const HS_DECL = String.raw`(?=[ \t]*::|[^\n]*?(?:${EQ}|\|)|[^\n]*\n[ \t]+[^\n]*?(?:${EQ}|\|))`;

const rules: DetectionRule[] = [
  // ---------- Haskell（範圍是開頭那一行加上縮排較深的各行） ----------
  {
    id: 'hs-type',
    label: 'data／newtype／type／class Xxx',
    languages: ['haskell'],
    pattern: String.raw`^(?:data(?:[ \t]+family)?|newtype|type(?:[ \t]+family)?|class)[ \t]+(?:[^=\n]*?=>[ \t]*)?(?<name>[A-Z][\w']*)`,
    kind: 'class',
    body: 'indentBlock',
  },
  {
    id: 'hs-instance',
    label: 'instance Xxx Yyy where',
    languages: ['haskell'],
    pattern: String.raw`^instance[ \t]+(?:[^=\n]*?=>[ \t]*)?(?<name>[A-Z][\w'.]*(?:[ \t]+[^\n]*?)?)(?=[ \t]+where\b|[ \t]*\r?$)`,
    kind: 'class',
    body: 'indentBlock',
  },
  {
    id: 'hs-method',
    label: 'class／instance 內的 xxx :: …、xxx = …',
    languages: ['haskell'],
    pattern: String.raw`^[ \t]+(?<name>${HS_VAR})${HS_DECL}`,
    kind: 'method',
    body: 'indentBlock',
    within: ['class'],
    mergeClauses: true,
  },
  {
    id: 'hs-function',
    label: '頂層的 xxx :: …、xxx args = …（簽名與各段等式合併）',
    languages: ['haskell'],
    pattern: String.raw`^(?<name>${HS_VAR})${HS_DECL}`,
    kind: 'function',
    body: 'indentBlock',
    mergeClauses: true,
  },
];

export const haskell: LanguageDef = {
  syntax: { haskell: 'haskell' },
  extensions: { '.hs': 'haskell' },
  projectExtensions: ['hs'],
  rules,
};
