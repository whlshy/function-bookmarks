import { DetectionRule } from '../types';
import { LanguageDef } from './define';

/**
 * Vue、Svelte 單檔元件：只看 <script>（含 setup、context="module"），裡面套用 JS／TS 的規則；
 * template、style 不列，template 裡被 HTML 註解掉的 <script> 也不列。
 * 語言 ID 由 Vue（Volar）、Svelte 擴充提供，都沒裝時依副檔名判斷。
 * 標籤與 lang 不分大小寫（lang="TS" 也算）。
 */
const SFC_LANGS = ['vue', 'svelte'];
/** <script> 的 lang 屬性是不是某個值（ts、tsx、jsx）。 */
const langIs = (v: string) => String.raw`[^>]*\blang[ \t]*=[ \t]*["']${v}["']`;
/** 有 src 的 <script src="…"> 沒有內容。 */
const NO_SRC = String.raw`(?![^>]*\bsrc[ \t]*=)`;
const SCRIPT_END = '</script[ \\t]*>';

const embedded = (id: string, label: string, lang: string, embeddedLanguage: string): DetectionRule => ({
  id,
  label,
  languages: SFC_LANGS,
  pattern: String.raw`<script\b(?=${langIs(lang)})${NO_SRC}[^>]*>`,
  end: SCRIPT_END,
  flags: 'i',
  kind: 'block',
  body: 'embedded',
  embeddedLanguage,
});

const rules: DetectionRule[] = [
  // ---------- Vue／Svelte ----------
  embedded('sfc-script-ts', '<script lang="ts"> 內的 TypeScript', 'ts', 'typescript'),
  embedded('sfc-script-tsx', '<script lang="tsx"> 內的 TSX', 'tsx', 'typescriptreact'),
  {
    id: 'sfc-script',
    label: '<script> 內的 JavaScript',
    languages: SFC_LANGS,
    pattern: String.raw`<script\b(?!${langIs('(?:tsx?|jsx)')})${NO_SRC}[^>]*>`,
    end: SCRIPT_END,
    flags: 'i',
    kind: 'block',
    body: 'embedded',
    embeddedLanguage: 'javascript',
  },
  // 新規則放在最後：既有規則的順序不變
  embedded('sfc-script-jsx', '<script lang="jsx"> 內的 JSX', 'jsx', 'javascriptreact'),
];

export const vueSvelte: LanguageDef = {
  // 外層只遮 template 的 HTML 註解；script、style 的內容不動
  syntax: { vue: 'sfc', svelte: 'sfc' },
  extensions: { '.vue': 'vue', '.svelte': 'svelte' },
  projectExtensions: ['vue', 'svelte'],
  rules,
};
