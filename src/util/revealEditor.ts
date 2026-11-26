import * as vscode from 'vscode';
import { chooseJumpTarget, GroupState } from './jumpTarget';
import { uriKey } from './uris';

function groupState(g: vscode.TabGroup): GroupState {
  const input = g.activeTab?.input;
  if (input instanceof vscode.TabInputText) {
    return { viewColumn: g.viewColumn, text: uriKey(input.uri) };
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return { viewColumn: g.viewColumn, diff: { original: uriKey(input.original), modified: uriKey(input.modified) } };
  }
  return { viewColumn: g.viewColumn };
}

/**
 * 群組裡顯示這個檔案的編輯器。差異比較兩側的編輯器 viewColumn 可能是 undefined，
 * 所以 inDiff 時也接受沒有 viewColumn 的（仍以 viewColumn 相同的優先）。
 */
function visibleEditor(key: string, viewColumn: number, inDiff = false): vscode.TextEditor | undefined {
  const list = vscode.window.visibleTextEditors.filter((e) => uriKey(e.document.uri) === key);
  return list.find((e) => e.viewColumn === viewColumn) ?? (inDiff ? list.find((e) => e.viewColumn === undefined) : undefined);
}

/**
 * 跳到書籤前取得要用的編輯器，並把焦點放到該編輯器：優先沿用已經顯示這個檔案的編輯器，都沒有才在使用中的群組開啟。
 *
 * - 使用中群組的分頁就是這個檔案：留在原分頁（差異比較也不離開）。
 * - 使用中群組是差異比較、檔案在另一側：切到另一側。
 * - 其他分割畫面的一般分頁已顯示這個檔案：切到那一邊，不在目前這邊再開一次。
 *
 * 判斷依據見 chooseJumpTarget()。使用中的群組以 tabGroups 為準：視窗不在前景時 activeTextEditor 可能沒更新。
 */
export async function editorForJump(uri: vscode.Uri): Promise<vscode.TextEditor> {
  const key = uriKey(uri);
  const groups = vscode.window.tabGroups;
  const active = vscode.window.activeTextEditor;
  const choice = chooseJumpTarget({
    target: key,
    activeGroup: groupState(groups.activeTabGroup),
    otherGroups: groups.all.filter((g) => g !== groups.activeTabGroup).map(groupState),
    activeEditor: active && { key: uriKey(active.document.uri), viewColumn: active.viewColumn },
    sideBySide: vscode.workspace.getConfiguration('diffEditor').get<boolean>('renderSideBySide', true),
  });
  switch (choice.kind) {
    case 'activeText':
    case 'otherGroup': {
      const doc = visibleEditor(key, choice.viewColumn)?.document ?? (await vscode.workspace.openTextDocument(uri));
      // 一般分頁：顯示同一個分頁並把焦點移過去（從側邊欄點書籤時，焦點回到程式碼）
      return vscode.window.showTextDocument(doc, { viewColumn: choice.viewColumn, preserveFocus: false });
    }
    case 'activeDiff':
    case 'diffOtherSide': {
      // 差異比較：不能對單側呼叫 showTextDocument（會離開差異比較另開一般分頁），改用指令移動焦點
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup').then(undefined, () => undefined);
      if (choice.kind === 'diffOtherSide') {
        await vscode.commands.executeCommand('workbench.action.compareEditor.focusOtherSide').then(undefined, () => undefined);
      }
      const editor = visibleEditor(key, choice.viewColumn, true);
      if (editor) {
        return editor;
      }
      break;
    }
  }
  return vscode.window.showTextDocument(uri, { preserveFocus: false });
}
