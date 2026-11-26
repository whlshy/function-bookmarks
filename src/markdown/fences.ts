/**
 * 若 Markdown 文字結尾有尚未閉合的程式碼圍欄（``` 或 ~~~），補上對應的結尾圍欄，
 * 避免後續附加的連結（例如「在預覽中開啟」）被包進程式碼區塊而失效。
 *
 * 依 CommonMark 規則：
 * - 開頭圍欄前最多 3 個空白（縮排 4 格或 Tab 為縮排程式碼區塊，不開啟圍欄）；
 *   反引號圍欄的資訊字串不可包含反引號。
 * - 結尾圍欄前最多 3 個空白（縮排 4 格不會關閉圍欄），須使用相同字元、長度不少於開頭，
 *   且後方只能有空白字元。
 */
export function closeUnclosedFences(md: string): string {
  let open: { char: '`' | '~'; len: number } | undefined;
  for (const rawLine of md.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === open.char && close[1].length >= open.len) {
        open = undefined;
      }
      continue;
    }
    const bt = /^ {0,3}(`{3,})[^`]*$/.exec(line);
    if (bt) {
      open = { char: '`', len: bt[1].length };
      continue;
    }
    const tilde = /^ {0,3}(~{3,}).*$/.exec(line);
    if (tilde) {
      open = { char: '~', len: tilde[1].length };
    }
  }
  if (!open) {
    return md;
  }
  const sep = md.endsWith('\n') ? '' : '\n';
  return `${md}${sep}${open.char.repeat(open.len)}`;
}
