import { DetectionRule } from '../types';
import { LanguageDef } from './define';

const rules: DetectionRule[] = [
  // ---------- Markdown：標題當成目錄 ----------
  {
    id: 'md-heading',
    label: '# 標題',
    languages: ['markdown'],
    pattern: String.raw`^[ \t]{0,3}(?<level>#{1,6})[ \t]+(?<name>[^\r\n]*?[^\s#][^\r\n]*?)(?:[ \t]+#+)?[ \t]*$`,
    kind: 'heading',
    body: 'heading',
  },
  {
    id: 'md-setext',
    label: '標題\n=====',
    languages: ['markdown'],
    pattern: String.raw`^(?![ \t]*(?:[-*+>#|]|\d+[.)])[ \t])[ \t]{0,3}(?<name>[^\s][^\r\n]*?)[ \t]*\r?\n[ \t]{0,3}(?<under>=+|-+)[ \t]*$`,
    kind: 'heading',
    body: 'heading',
  },
];

export const markdown: LanguageDef = {
  syntax: { markdown: 'markdown' },
  extensions: { '.md': 'markdown', '.markdown': 'markdown' },
  projectExtensions: ['md', 'markdown'],
  rules,
};
