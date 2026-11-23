/** 遮罩共用的小工具。 */

/**
 * 字串裡往前走一步：反斜線跳脫時連同下一個字元一起跳過。反斜線接 CRLF（Windows 換行的行尾接續）要跳過三個字元，
 * 否則 \r 被當成跳脫的字元，接著的 \n 就被當成字串結束，後面的引號全部配錯。
 */
export function escapeStep(text: string, j: number): number {
  if (text[j] !== '\\') {
    return 1;
  }
  return text[j + 1] === '\r' && text[j + 2] === '\n' ? 3 : 2;
}

export function blank(out: string[], text: string, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const ch = text[i];
    out[i] = ch === '\n' || ch === '\r' ? ch : ' ';
  }
}
