import { DetectionRule } from '../types';
import { LanguageDef } from './define';

/** Rust 的可見性：pub、pub(crate)… */
const RS_VIS = String.raw`(?:pub(?:\([^)\n]*\))?[ \t]+)?`;
const RUST_FN = String.raw`^[ \t]*${RS_VIS}(?:(?:default|const|async|unsafe|extern(?:[ \t]+"[^"\n]*")?)[ \t]+)*fn[ \t]+(?<name>[A-Za-z_]\w*)(?=[^;{}]*\{)`;

const rules: DetectionRule[] = [
  // ---------- Rust ----------
  {
    id: 'rust-impl-trait',
    label: 'impl Trait for Type {}',
    languages: ['rust'],
    pattern: String.raw`^[ \t]*(?:unsafe[ \t]+)?impl(?:[ \t]*<[^{\n]*?>)?[ \t]+!?(?<trait>[A-Za-z_][\w:]*(?:<[^{\n]*?>)?)[ \t]+for[ \t]+(?<name>[A-Za-z_][\w:]*)`,
    nameTemplate: '${trait} for ${name}',
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'rust-impl',
    label: 'impl Type {}',
    languages: ['rust'],
    pattern: String.raw`^[ \t]*(?:unsafe[ \t]+)?impl(?:[ \t]*<[^{\n]*?>)?[ \t]+(?<name>[A-Za-z_][\w:]*)(?:<[^{\n]*?>)?(?=[ \t]*(?:\{|where\b|\r?\n))`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'rust-type',
    label: 'struct／enum／trait／union xxx',
    languages: ['rust'],
    pattern: String.raw`^[ \t]*${RS_VIS}(?:unsafe[ \t]+)?(?:struct|enum|trait|union)[ \t]+(?<name>[A-Za-z_]\w*)`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'rust-mod',
    label: 'mod xxx {}',
    languages: ['rust'],
    pattern: String.raw`^[ \t]*${RS_VIS}mod[ \t]+(?<name>[A-Za-z_]\w*)(?=[ \t]*\{)`,
    kind: 'block',
    body: 'brace',
  },
  {
    id: 'rust-method',
    label: 'impl／trait 內的 fn xxx() {}',
    languages: ['rust'],
    pattern: RUST_FN,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
  {
    id: 'rust-fn',
    label: 'fn xxx() {}',
    languages: ['rust'],
    pattern: RUST_FN,
    kind: 'function',
    body: 'brace',
  },
  {
    id: 'rust-macro',
    label: 'macro_rules! xxx {}',
    languages: ['rust'],
    pattern: String.raw`^[ \t]*macro_rules![ \t]*(?<name>[A-Za-z_]\w*)`,
    kind: 'macro',
    body: 'brace',
  },
];

export const rust: LanguageDef = {
  syntax: { rust: 'rust' },
  extensions: { '.rs': 'rust' },
  projectExtensions: ['rs'],
  rules,
};
