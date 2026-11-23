import { DetectionRule, Syntax } from '../types';

/**
 * 一種語言（或同一家族的幾種語言）的設定：加一個語言只要新增一個檔案，再到 index.ts 登記。
 */
export interface LanguageDef {
  /** VS Code 的語言 ID → 遮罩方式（註解、字串的寫法）。 */
  syntax: Record<string, Syntax>;
  /** 副檔名（小寫、含點）→ 語言 ID：不開檔讀取時（函式書籤、整個專案）用來判斷語言。 */
  extensions: Record<string, string>;
  /** 「整個專案」預設列出的副檔名（不含點）。 */
  projectExtensions: string[];
  /** 內建規則。順序有意義：同一個名稱被多條規則抓到時，排在前面的優先。 */
  rules: DetectionRule[];
}
