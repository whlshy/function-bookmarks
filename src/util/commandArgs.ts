/**
 * 指令參數的防呆。
 *
 * VS Code／Cursor 從選單執行指令時常會附帶額外參數：
 * - 側邊欄標題列（…）會傳入目前選取的樹節點與選取清單（$focusedTreeItem／$selectedTreeItems）
 * - 行號區右鍵（editor/lineNumber/context）第二參數會傳入 `{ preserveFocus: false }`
 * - 側邊欄項目右鍵（view/item/context）第二參數會傳入選取的節點陣列
 * 這些不是指令選項或測試輸入值，未經驗證直接沿用會寫壞設定或使選單失效。
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

/** 參數是字串才回傳，否則 undefined。 */
export function stringArg(arg: unknown): string | undefined {
  return typeof arg === 'string' ? arg : undefined;
}

/** 參數是字串或 null 才回傳，否則 undefined（用於顏色等可傳 null 清除的指令）。 */
export function nullableStringArg(arg: unknown): string | null | undefined {
  return typeof arg === 'string' || arg === null ? arg : undefined;
}

/** 參數是布林值才回傳，否則 undefined。 */
export function booleanArg(arg: unknown): boolean | undefined {
  return typeof arg === 'boolean' ? arg : undefined;
}

/** 書籤號碼指令的值：只接受 1～9 的整數、'next' 或 null，其餘回傳 undefined（改跳出選單）。 */
export function bookmarkNumberArg(arg: unknown): number | 'next' | null | undefined {
  if (arg === null || arg === 'next') {
    return arg;
  }
  return typeof arg === 'number' && Number.isInteger(arg) && arg >= 1 && arg <= 9 ? arg : undefined;
}

/** 參數是全為字串的陣列才回傳，否則 undefined。 */
export function stringArrayArg(arg: unknown): string[] | undefined {
  return Array.isArray(arg) && arg.every((x): x is string => typeof x === 'string') ? arg : undefined;
}
