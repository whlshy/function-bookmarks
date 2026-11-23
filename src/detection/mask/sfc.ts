import { blank } from './common';

/** <script>、<style> 的開頭，以及 HTML 註解的開頭。 */
const OPEN_RE = /<(script|style)\b[^>]*>|<!--/gi;

/**
 * Vue、Svelte 單檔元件的外層：只遮 template 裡的 HTML 註解（被註解掉的舊 <script> 不要被列出來）。
 * <script>、<style> 的內容原樣保留：裡面的 `<!--`（例如字串）不是 HTML 註解，內容交給 script 自己的語言處理。
 */
export function maskSfc(text: string): string {
  const out = text.split('');
  OPEN_RE.lastIndex = 0;
  for (let m = OPEN_RE.exec(text); m; m = OPEN_RE.exec(text)) {
    if (m[0] === '<!--') {
      const end = text.indexOf('-->', m.index + 4);
      const stop = end < 0 ? text.length : end + 3;
      blank(out, text, m.index, stop);
      OPEN_RE.lastIndex = stop;
    } else {
      // 跳過 script／style 的內容，從結束標籤之後繼續找
      const close = new RegExp(`</${m[1]}[ \\t]*>`, 'ig');
      close.lastIndex = OPEN_RE.lastIndex;
      const c = close.exec(text);
      OPEN_RE.lastIndex = c ? c.index + c[0].length : text.length;
    }
  }
  return out.join('');
}
