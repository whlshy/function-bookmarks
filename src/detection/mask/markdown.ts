import { blank } from './common';

/** Markdown：遮蔽程式碼區塊（``` 與 ~~~）、HTML 註解、檔案開頭的 YAML front matter。 */
export function maskMarkdown(text: string): string {
  const out = text.split('');
  const fm = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/.exec(text);
  if (fm) {
    blank(out, text, 0, fm[0].length);
  }
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) {
    blank(out, text, m.index!, m.index! + m[0].length);
  }
  const fence = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open: { index: number; marker: string } | undefined;
  for (const m of text.matchAll(fence)) {
    const marker = m[1];
    if (!open) {
      if (marker[0] === '`' && m[0].slice(m[0].indexOf(marker) + marker.length).includes('`')) {
        continue; // ```js` 這種行內寫法不是區塊
      }
      open = { index: m.index!, marker };
      continue;
    }
    if (marker[0] === open.marker[0] && marker.length >= open.marker.length && m[0].trim() === marker) {
      blank(out, text, open.index, m.index! + m[0].length);
      open = undefined;
    }
  }
  if (open) {
    blank(out, text, open.index, text.length);
  }
  return out.join('');
}
