/**
 * 指令參數的防呆。
 *
 * VS Code／Cursor 從側邊欄標題列（…）執行指令時，會把目前選取的樹節點當成第一個參數、
 * 選取清單當成第二個參數傳進來（$focusedTreeItem／$selectedTreeItems）。
 * 這些節點不是指令的選項，直接當成選項用會讀錯檔案、存錯設定。
 */

/**
 * 只接受「只含指定欄位的一般物件」（測試與程式內呼叫傳的選項），其餘（樹節點、Uri、陣列、
 * 類別實例、含其他欄位的物件）一律回傳 undefined。
 */
export function plainOptions<T extends object>(arg: unknown, keys: readonly (keyof T & string)[]): T | undefined {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    return undefined;
  }
  const proto = Object.getPrototypeOf(arg) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    return undefined;
  }
  return Object.keys(arg).every((k) => (keys as readonly string[]).includes(k)) ? (arg as T) : undefined;
}

/** 參數是允許的字串之一才回傳，否則 undefined。 */
export function oneOf<T extends string>(arg: unknown, allowed: readonly T[]): T | undefined {
  return typeof arg === 'string' && (allowed as readonly string[]).includes(arg) ? (arg as T) : undefined;
}
