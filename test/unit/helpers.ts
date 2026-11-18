import { BUILTIN_RULES } from '../../src/detection/builtinRules';
import { detectSymbols, mergeRules } from '../../src/detection/engine';
import { DetectedSymbol, DetectionRule } from '../../src/detection/types';

export interface Outline {
  [label: string]: Outline;
}

/** 把偵測結果轉成 `{ 'class UserService@0-9': { 'method login@2-4': {} } }` 方便比對。 */
export function outline(symbols: DetectedSymbol[], withLines = true): Outline {
  const o: Outline = {};
  for (const s of symbols) {
    const key = withLines ? `${s.kind} ${s.name}@${s.startLine}-${s.endLine}` : `${s.kind} ${s.name}`;
    o[key] = outline(s.children, withLines);
  }
  return o;
}

/** 與套件預設設定相同：`detection.disabledRules` 預設停用 html-id。 */
export const DEFAULT_RULES = mergeRules(BUILTIN_RULES, [], ['html-id']);

export function detect(text: string, languageId: string, rules: DetectionRule[] = DEFAULT_RULES) {
  return detectSymbols(text, languageId, rules);
}

/** 以陣列寫多行文字，可讀性比樣板字串好，也不必擔心縮排。 */
export function lines(...ls: string[]): string {
  return ls.join('\n');
}
