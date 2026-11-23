import { blank } from './common';
import { C_FAMILY, maskCFamilyInto } from './cFamily';

/**
 * PHP：只有 <?php … ?>（或 <?= … ?>）裡面是程式碼，用 C 家族的方式遮；
 * 外面的 HTML 全部遮掉（英文的 don't 之類不會被當成字串開頭，也不會抓到 HTML 裡的文字）。
 * 字串、註解裡的 ?> 不算結束（// 註解裡的 ?> 在 PHP 其實會結束，這裡不處理）。
 */
export function maskPhp(text: string): string {
  const out = text.split('');
  const open = /<\?(?:php\b|=)?/g;
  let pos = 0;
  while (pos < text.length) {
    open.lastIndex = pos;
    const m = open.exec(text);
    if (!m) {
      blank(out, text, pos, text.length);
      break;
    }
    blank(out, text, pos, m.index);
    const close = maskCFamilyInto(text, out, m.index + m[0].length, C_FAMILY.php!, true);
    pos = close + 2;
  }
  return out.join('');
}
