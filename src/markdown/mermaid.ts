/**
 * 讓 VS Code／Cursor 內建的 Markdown 預覽能畫 Mermaid：
 * markdown-it 外掛把 ```mermaid 區塊轉成 `<pre class="fb-mermaid">`，
 * 預覽裡的 media/mermaid-preview.js 再用 Mermaid 把它畫成圖。
 *
 * 保留 `code-line` 與 `data-line`，內建預覽才能跟編輯器同步捲動。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type MarkdownIt = any;

export const MERMAID_CLASS = 'fb-mermaid';

export function isMermaidInfo(info: string): boolean {
  return info.trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid';
}

export function mermaidPlugin(md: MarkdownIt): MarkdownIt {
  const original = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens: any[], idx: number, options: any, env: any, self: any) => {
    const token = tokens[idx];
    if (!isMermaidInfo(token.info ?? '')) {
      return original ? original(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    }
    const line = Array.isArray(token.map) ? ` data-line="${token.map[0]}"` : '';
    return `<pre class="code-line ${MERMAID_CLASS}"${line}>${md.utils.escapeHtml(token.content)}</pre>\n`;
  };
  return md;
}
