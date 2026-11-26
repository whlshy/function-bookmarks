/**
 * 跳到書籤時要用哪個編輯器的判斷（純函式，不依賴 vscode，方便單元測試）。
 * 檔案一律以 `uriKey()` 比對；群組以 viewColumn（1 起算）表示。
 */

/** 一個編輯器群組目前的分頁。 */
export interface GroupState {
  viewColumn: number;
  /** 目前分頁是一般文字分頁時，該檔案。 */
  text?: string;
  /** 目前分頁是差異比較時，左右兩側的檔案。 */
  diff?: { original: string; modified: string };
}

export interface JumpState {
  target: string;
  /** 使用中的群組（以 tabGroups 為準；視窗不在前景時 activeTextEditor 可能沒更新）。 */
  activeGroup?: GroupState;
  /** 其他群組。 */
  otherGroups: GroupState[];
  /** activeTextEditor；只有在它確實屬於使用中的群組時才可信。 */
  activeEditor?: { key: string; viewColumn?: number };
  /** 差異比較是否左右並排（行內模式時看不到左側，不能切過去）。 */
  sideBySide: boolean;
}

export type JumpChoice =
  /** 使用中群組的一般分頁就是目標檔案。 */
  | { kind: 'activeText'; viewColumn: number }
  /** 使用中群組是差異比較，且焦點已在目標那一側（或無法判斷在哪一側）。 */
  | { kind: 'activeDiff'; viewColumn: number }
  /** 使用中群組是差異比較，目標在另一側：切到另一側。 */
  | { kind: 'diffOtherSide'; viewColumn: number }
  /** 其他群組的一般分頁已顯示目標檔案：切到那個群組。 */
  | { kind: 'otherGroup'; viewColumn: number }
  /** 都沒有：在使用中的群組開啟。 */
  | { kind: 'open' };

export function chooseJumpTarget(s: JumpState): JumpChoice {
  const group = s.activeGroup;
  if (group) {
    if (group.text === s.target) {
      return { kind: 'activeText', viewColumn: group.viewColumn };
    }
    const diff = group.diff;
    if (diff && (diff.original === s.target || diff.modified === s.target)) {
      // activeTextEditor 可信的條件：屬於這個群組；差異比較兩側的編輯器 viewColumn 可能是 undefined，
      // 這時只要它是這個差異比較其中一側的檔案就算（焦點在輸出面板等處的編輯器檔案不會是這兩個）
      const a = s.activeEditor;
      const inThisDiff = !!a && (a.key === diff.original || a.key === diff.modified);
      const editor =
        a && ((a.viewColumn !== undefined && a.viewColumn === group.viewColumn) || (a.viewColumn === undefined && inThisDiff))
          ? a
          : undefined;
      // 焦點已在目標那一側，或不知道焦點在哪一側：留在差異比較，只把焦點放回這個群組
      if (!editor || editor.key === s.target || diff.original === diff.modified) {
        return { kind: 'activeDiff', viewColumn: group.viewColumn };
      }
      // 目標在另一側；行內模式看不到左側，只有右側（modified）切得過去
      if (s.sideBySide || diff.modified === s.target) {
        return { kind: 'diffOtherSide', viewColumn: group.viewColumn };
      }
    }
  }
  // 其他群組：只沿用一般分頁（差異比較在別的群組時不去動它），viewColumn 小的優先，結果固定
  const other = s.otherGroups
    .filter((g) => g.text === s.target)
    .sort((a, b) => a.viewColumn - b.viewColumn)[0];
  if (other) {
    return { kind: 'otherGroup', viewColumn: other.viewColumn };
  }
  return { kind: 'open' };
}
