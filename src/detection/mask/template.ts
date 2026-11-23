import { blank } from './common';

/** Django／Jinja 樣板：{# #}、{% comment %}、HTML 註解。 */
const TEMPLATE_COMMENT_RE = /\{#[\s\S]*?#\}|\{%-?\s*comment\b[\s\S]*?\{%-?\s*endcomment\s*-?%\}|<!--[\s\S]*?-->/g;

export function maskTemplate(text: string): string {
  const out = text.split('');
  for (const m of text.matchAll(TEMPLATE_COMMENT_RE)) {
    blank(out, text, m.index!, m.index! + m[0].length);
  }
  return out.join('');
}
