/**
 * 書籤建立時間的本地格式化（純函式，不依賴 vscode 或系統語系，方便單元測試）。
 */

/**
 * 將 ISO 時間字串格式化為本地時間 `YYYY-MM-DD HH:mm`；
 * 沒有值或無法解析成有效時間時回傳 undefined。
 */
export function formatLocalDateTime(iso: string | undefined): string | undefined {
  if (!iso) {
    return undefined;
  }
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) {
    return undefined;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
