export type SymbolKindName =
  | 'function'
  | 'method'
  | 'class'
  | 'block'
  | 'partial'
  | 'macro'
  | 'event'
  | 'request'
  | 'heading'
  | 'reference';

export type BodyKind = 'brace' | 'indent' | 'pair' | 'line' | 'call' | 'heading' | 'embedded';

/**
 * 一條函式偵測規則。
 *
 * - `pattern` 以整份檔案（已遮蔽註解與字串）為對象比對，旗標固定加上 `g`、`m`、`d`。
 * - 必須有 `(?<name>...)` 群組；`reference` 類型可另外用 `(?<target>...)` 取出參照目標。
 * - 內容範圍從「比對結束處」開始找，所以尾端的括號、大括號請寫成 lookahead。
 */
export interface DetectionRule {
  id: string;
  label?: string;
  languages: string[];
  pattern: string;
  flags?: string;
  kind: SymbolKindName;
  body: BodyKind;
  /** `pair` 的結束標籤，或 `embedded` 區域的結束位置。 */
  end?: string;
  /** `embedded` 區域內要套用哪個語言的規則。 */
  embeddedLanguage?: string;
  /** 只有被這些 kind 包住時才算數，例如類別方法只出現在 class 內。 */
  within?: SymbolKindName[];
  /**
   * 用多個群組組成名稱，例如 `${type:upper|AJAX} ${url}`。
   * `:upper` 轉大寫，`|預設值` 在群組沒有比對到時使用。設定後可不需要 `name` 群組。
   */
  nameTemplate?: string;
  /**
   * 以原始文字比對（字串內容不遮蔽），讓 `'click'`、`'/api'` 這類字串能被取出；
   * 但比對起點落在註解或字串裡的結果仍會略過。
   */
  matchRaw?: boolean;
  /**
   * 不顯示這些規則抓到的子節點（它們底下的子節點會往上接），
   * 例如 ajax 的 success、error 回呼。
   */
  hideChildren?: string[];
  /** 只套用到符合這些 glob 的檔案（由呼叫端判斷）。 */
  include?: string[];
  enabled?: boolean;
}

export interface DetectedSymbol {
  name: string;
  kind: SymbolKindName;
  ruleId: string;
  /** 以 0 起算、含頭尾的行號。 */
  startLine: number;
  endLine: number;
  /** 名稱所在位置，用於跳轉與選取。 */
  nameLine: number;
  nameStartCol: number;
  nameEndCol: number;
  startOffset: number;
  endOffset: number;
  /** 例如 `{% include "x.html" %}` 的 `x.html`。 */
  target?: string;
  /** 由上層名稱串成的路徑，例如 `UserService.login`、`content.sidebar`。 */
  path: string;
  children: DetectedSymbol[];
}

export interface RuleError {
  ruleId: string;
  message: string;
}

export interface DetectionResult {
  symbols: DetectedSymbol[];
  errors: RuleError[];
}

export type Syntax = 'c' | 'python' | 'template' | 'markdown' | 'none';
