import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { activateExtension, resetWorkspace, waitFor, workspaceFile } from './helpers';

const LINES = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).join('\n');

function activeTabIsDiff(): boolean {
  return vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff;
}

function tabsFor(group: vscode.TabGroup, uri: vscode.Uri): vscode.Tab[] {
  return group.tabs.filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
}

describe('跳到書籤時沿用已顯示該檔的編輯器（差異比較、分割畫面）', () => {
  let api: ExtensionApi;
  const a = workspaceFile('jumpA.ts');
  const b = workspaceFile('jumpB.ts');
  const c = workspaceFile('jumpC.ts');

  before(async () => {
    api = await activateExtension();
    await vscode.workspace.fs.writeFile(a, Buffer.from(LINES));
    await vscode.workspace.fs.writeFile(b, Buffer.from(LINES.replace('line3 = 3', 'line3 = 33')));
    await vscode.workspace.fs.writeFile(c, Buffer.from(LINES));
  });

  beforeEach(async () => {
    await resetWorkspace(api, { closeEditors: true });
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(a).then(undefined, () => undefined);
    await vscode.workspace.fs.delete(b).then(undefined, () => undefined);
    await vscode.workspace.fs.delete(c).then(undefined, () => undefined);
  });

  it('差異比較畫面：跳到另一側檔案的書籤時不離開差異比較', async () => {
    await vscode.commands.executeCommand('vscode.diff', a, b, 'A ↔ B');
    await waitFor(() => activeTabIsDiff() && vscode.window.activeTextEditor?.document.uri.toString() === b.toString(), (v) => v, '差異比較畫面開啟且焦點在右側');

    await vscode.commands.executeCommand('functionBookmarks.revealLine', a, 20);

    assert.ok(activeTabIsDiff(), '跳轉後應該仍在差異比較畫面');
    const left = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === a.toString());
    assert.ok(left, '左側（jumpA）應該仍然可見');
    assert.strictEqual(left.selection.active.line, 20);
    assert.strictEqual(tabsFor(vscode.window.tabGroups.activeTabGroup, a).length, 0, '不應另外開一般分頁');
  });

  it('差異比較畫面：跳到目前這一側的書籤時留在原處', async () => {
    await vscode.commands.executeCommand('vscode.diff', a, b, 'A ↔ B');
    await waitFor(() => activeTabIsDiff(), (v) => v, '差異比較畫面開啟');

    await vscode.commands.executeCommand('functionBookmarks.revealSymbol', b, 30, 6, 12);

    assert.ok(activeTabIsDiff(), '跳轉後應該仍在差異比較畫面');
    const editor = vscode.window.activeTextEditor;
    assert.strictEqual(editor?.document.uri.toString(), b.toString());
    assert.strictEqual(editor?.selection.active.line, 30);
  });

  it('分割畫面：檔案已顯示在另一邊時跳到那一邊，不在目前這邊再開一次', async () => {
    // 左邊最後換成第三個檔案：目前分頁真的換掉，視窗不在前景時 activeTextEditor 也會更新，跳轉不會走「就是目前檔案」的捷徑
    await vscode.window.showTextDocument(a, { viewColumn: vscode.ViewColumn.One });
    await vscode.window.showTextDocument(b, { viewColumn: vscode.ViewColumn.Two });
    await vscode.window.showTextDocument(c, { viewColumn: vscode.ViewColumn.One });
    await waitFor(
      () => vscode.window.tabGroups.activeTabGroup.viewColumn,
      (v) => v === vscode.ViewColumn.One,
      '使用中的群組回到左邊',
    );
    const first = vscode.window.tabGroups.activeTabGroup;

    const editor = await vscode.commands.executeCommand<vscode.TextEditor>('functionBookmarks.revealLine', b, 15);

    assert.strictEqual(editor.document.uri.toString(), b.toString());
    assert.strictEqual(editor.viewColumn, vscode.ViewColumn.Two, '應該跳到右邊已開著的 jumpB');
    assert.strictEqual(editor.selection.active.line, 15);
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.Two, '使用中的群組換到右邊');
    assert.strictEqual(tabsFor(first, b).length, 0, '左邊不應再開一個 jumpB');
    assert.strictEqual(vscode.window.tabGroups.all.length, 2, '不應多開群組');
  });

  it('檔案沒有顯示在任何地方時，照常在目前的群組開啟', async () => {
    await vscode.window.showTextDocument(a, { viewColumn: vscode.ViewColumn.One });

    await vscode.commands.executeCommand('functionBookmarks.revealLine', b, 8);

    const editor = vscode.window.activeTextEditor;
    assert.strictEqual(editor?.document.uri.toString(), b.toString());
    assert.strictEqual(editor?.viewColumn, vscode.ViewColumn.One);
    assert.strictEqual(editor?.selection.active.line, 8);
  });
});
