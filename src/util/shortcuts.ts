/**
 * 依作業系統產生快捷鍵顯示文字，避免在 macOS 上出現硬編碼的 Ctrl／Alt 提示。
 * 所有書籤快捷鍵統一採用 Alt+Shift+B（macOS 為 Ctrl+Shift+B）兩段式前綴，
 * 避開 Windows AltGr（＝Ctrl+Alt）與 VS Code／Cursor 內建快捷鍵衝突。
 */
export function bookmarkChordPrefix(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'Ctrl+Shift+B' : 'Alt+Shift+B';
}

export function toggleBookmarkKey(platform: NodeJS.Platform = process.platform): string {
  return `${bookmarkChordPrefix(platform)} B`;
}

export function addLabeledBookmarkKey(platform: NodeJS.Platform = process.platform): string {
  return `${bookmarkChordPrefix(platform)} Shift+B`;
}

export function renameBookmarkKey(platform: NodeJS.Platform = process.platform): string {
  return `${bookmarkChordPrefix(platform)} R`;
}

export function goToNumberKeys(platform: NodeJS.Platform = process.platform): string {
  return `${bookmarkChordPrefix(platform)} 1–9`;
}

export function setNumberKeys(platform: NodeJS.Platform = process.platform): string {
  return `${bookmarkChordPrefix(platform)} Shift+1–9`;
}

export function setNumberKey(n: number, platform: NodeJS.Platform = process.platform): string {
  return `${bookmarkChordPrefix(platform)} Shift+${n}`;
}
