/**
 * 去掉開頭的 BOM（U+FEFF）。記事本、PowerShell 的 Set-Content 等工具存檔時可能加上 BOM，
 * Node 以 utf8 讀檔不會去掉它，`JSON.parse` 遇到就失敗。
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
