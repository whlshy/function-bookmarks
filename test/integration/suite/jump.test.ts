import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { makeAnchor, newBookmarkId } from '../../../src/bookmarks/model';
import { addBookmark, setFavorite, setTags } from '../../../src/storage/marks';
import { activateExtension, folder, openAt, resetWorkspace, waitFor, workspaceFile } from './helpers';

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

describe('側邊欄搜尋時「上一個／下一個書籤」只在符合的書籤間跳', () => {
  let api: ExtensionApi;
  const relA = 'jumpSearchA.ts';
  const relB = 'jumpSearchB.ts';
  const relC = 'jumpSearchC.ts';
  const fileA = workspaceFile(relA);
  const fileB = workspaceFile(relB);
  const fileC = workspaceFile(relC);
  const linesA = [
    'export function authLogin() {',
    "  const token = 'a';",
    '  return token;',
    '}',
    '',
    'export function renderHome() {',
    "  const page = 'home';",
    '  return page;',
    '}',
  ];
  const linesB = [
    'export function authLogout() {',
    '  const ok = true;',
    '  return ok;',
    '}',
    '',
    'export function loadProfile() {',
    "  const name = 'u';",
    '  return name;',
    '}',
  ];
  const linesC = ['export function emptyFile() {', '  return 0;', '}'];

  const pos = () => {
    const e = vscode.window.activeTextEditor!;
    return `${path.basename(e.document.uri.fsPath)}:${e.selection.active.line}`;
  };

  async function setupBookmarks(): Promise<void> {
    await api.store.update(folder(), (d) => {
      let next = setFavorite(d, { file: relA, path: 'authLogin', kind: 'function' }, true, 0);
      next = setTags(next, { file: relA, path: 'authLogin', kind: 'function' }, ['auth']);
      next = addBookmark(next, {
        id: newBookmarkId(),
        file: relA,
        line: 1,
        label: '驗證 token',
        tags: ['auth'],
        number: 1,
        anchor: makeAnchor(linesA, 1, 'authLogin', 0),
      });
      next = addBookmark(next, {
        id: newBookmarkId(),
        file: relA,
        line: 6,
        label: '首頁渲染',
        tags: ['ui'],
        number: 2,
        anchor: makeAnchor(linesA, 6, 'renderHome', 5),
      });
      next = addBookmark(next, {
        id: newBookmarkId(),
        file: relB,
        line: 1,
        label: '登出清理',
        tags: ['auth'],
        number: 3,
        anchor: makeAnchor(linesB, 1, 'authLogout', 0),
      });
      return addBookmark(next, {
        id: newBookmarkId(),
        file: relB,
        line: 6,
        label: '載入個人頁',
        tags: ['ui'],
        anchor: makeAnchor(linesB, 6, 'loadProfile', 5),
      });
    });
    await api.favorites.refresh();
    await api.external.idle();
  }

  before(async () => {
    api = await activateExtension();
    await vscode.workspace.fs.writeFile(fileA, Buffer.from(linesA.join('\n')));
    await vscode.workspace.fs.writeFile(fileB, Buffer.from(linesB.join('\n')));
    await vscode.workspace.fs.writeFile(fileC, Buffer.from(linesC.join('\n')));
  });

  beforeEach(async () => {
    await resetWorkspace(api, { closeEditors: true });
  });

  afterEach(async () => {
    api.searchBox.setQuery('');
    api.provider.setQuery('');
    const cfg = vscode.workspace.getConfiguration('functionBookmarks');
    await cfg.update('bookmarks.navigationScope', undefined, vscode.ConfigurationTarget.Workspace);
    await cfg.update('bookmarks.navigationWrap', undefined, vscode.ConfigurationTarget.Workspace);
  });

  after(async () => {
    api.searchBox.setQuery('');
    api.provider.setQuery('');
    await resetWorkspace(api, { closeEditors: true });
    await vscode.workspace.fs.delete(fileA).then(undefined, () => undefined);
    await vscode.workspace.fs.delete(fileB).then(undefined, () => undefined);
    await vscode.workspace.fs.delete(fileC).then(undefined, () => undefined);
  });

  it('搜尋有文字時只在符合的書籤間跳轉與循環，並顯示狀態列提示；清空搜尋後恢復全部', async () => {
    await setupBookmarks();
    api.searchBox.setQuery('#auth');

    await openAt(fileA, 0, api);
    await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
    assert.strictEqual(pos(), `${relA}:1`);
    assert.strictEqual(api.bookmarks.lastGoStatus, 'Jumping within search results (3)');

    await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
    assert.strictEqual(pos(), `${relB}:1`, '應跳過不符合的 ui 書籤（A:6）');
    assert.strictEqual(api.bookmarks.lastGoStatus, 'Jumping within search results (3)');

    await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
    assert.strictEqual(pos(), `${relA}:0`, '尾端應繞回第一個符合的函式書籤，跳過 B:6');
    assert.strictEqual(api.bookmarks.lastGoStatus, 'Jumping within search results (3)');

    await vscode.commands.executeCommand('functionBookmarks.previousBookmark');
    assert.strictEqual(pos(), `${relB}:1`, '上一個應反向繞回最後一個符合的書籤');
    assert.strictEqual(api.bookmarks.lastGoStatus, 'Jumping within search results (3)');

    await vscode.commands.executeCommand('functionBookmarks.previousBookmark');
    assert.strictEqual(pos(), `${relA}:1`);

    // 清空搜尋後恢復原本全部書籤的順序，不顯示搜尋提示
    await vscode.commands.executeCommand('functionBookmarks.clearSearch');
    await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
    assert.strictEqual(pos(), `${relA}:6`, '清空搜尋後應跳回原本被篩掉的書籤');
    assert.strictEqual(api.bookmarks.lastGoStatus, undefined);
  });

  it('沒有符合搜尋的書籤時游標不動並提示；空白或單獨 #／@ 不算搜尋中', async () => {
    await setupBookmarks();
    await openAt(fileA, 6, api);

    api.searchBox.setQuery('zzz_no_match');
    assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.nextBookmark'), undefined);
    assert.strictEqual(pos(), `${relA}:6`, '無符合時游標不動');
    assert.strictEqual(api.bookmarks.lastGoStatus, 'No bookmarks match the search.');

    assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.previousBookmark'), undefined);
    assert.strictEqual(pos(), `${relA}:6`);
    assert.strictEqual(api.bookmarks.lastGoStatus, 'No bookmarks match the search.');

    // 只有空白與單獨的 #／@ 不算搜尋，照常跳全部書籤
    api.searchBox.setQuery('   # @  ');
    await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
    assert.strictEqual(pos(), `${relB}:1`);
    assert.strictEqual(api.bookmarks.lastGoStatus, undefined);
  });

  it('與 navigationScope = currentFile、navigationWrap = false 同時生效', async () => {
    await setupBookmarks();
    const cfg = vscode.workspace.getConfiguration('functionBookmarks');
    await cfg.update('bookmarks.navigationScope', 'currentFile', vscode.ConfigurationTarget.Workspace);
    api.searchBox.setQuery('#auth');

    // A 有 2 個符合 #auth（行 0 與行 1），只在 A 內循環不跳到 B:1
    await openAt(fileA, 0, api);
    await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
    assert.strictEqual(pos(), `${relA}:1`);
    assert.strictEqual(api.bookmarks.lastGoStatus, 'Jumping within search results (2)');

    await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
    assert.strictEqual(pos(), `${relA}:0`, 'currentFile 模式只在本檔符合項目間循環');
    assert.strictEqual(api.bookmarks.lastGoStatus, 'Jumping within search results (2)');

    // 搭配 navigationWrap = false：到本檔符合項目的頭尾停住
    await cfg.update('bookmarks.navigationWrap', false, vscode.ConfigurationTarget.Workspace);
    assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.previousBookmark'), undefined);
    assert.strictEqual(pos(), `${relA}:0`);
    assert.strictEqual(api.bookmarks.lastGoStatus, 'Already at the first bookmark.');
    await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
    assert.strictEqual(pos(), `${relA}:1`);
    assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.nextBookmark'), undefined);
    assert.strictEqual(pos(), `${relA}:1`);
    assert.strictEqual(api.bookmarks.lastGoStatus, 'Already at the last bookmark.');

    // currentFile 模式下：目前檔案有書籤但不符合搜尋 -> 提示無符合搜尋
    api.searchBox.setQuery('驗證');
    await openAt(fileB, 6, api);
    assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.nextBookmark'), undefined);
    assert.strictEqual(pos(), `${relB}:6`);
    assert.strictEqual(api.bookmarks.lastGoStatus, 'No bookmarks match the search.');

    // currentFile 模式下：目前檔案沒有任何書籤（其他檔案有符合搜尋）-> 提示目前檔案沒有書籤
    api.searchBox.setQuery('#auth');
    await openAt(fileC, 0, api);
    assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.nextBookmark'), undefined);
    assert.strictEqual(pos(), `${relC}:0`);
    assert.strictEqual(api.bookmarks.lastGoStatus, 'No bookmarks in this file.');
  });

  it('跳到「需確認」書籤時以需確認提示為優先；數字書籤與依編號導覽不受側邊欄搜尋影響', async () => {
    await setupBookmarks();
    await api.store.update(folder(), (d) =>
      addBookmark(d, {
        id: newBookmarkId(),
        file: relA,
        line: 2,
        label: '失聯 auth 項目',
        tags: ['auth'],
        status: 'lost',
        anchor: makeAnchor(['old1', 'old2', 'old3'], 1),
      }),
    );

    api.searchBox.setQuery('失聯');
    await openAt(fileB, 0, api);
    const landed = await vscode.commands.executeCommand<{ uri: vscode.Uri; line: number }>('functionBookmarks.nextBookmark');
    assert.strictEqual(landed?.line, 2);
    assert.strictEqual(pos(), `${relA}:2`);
    assert.strictEqual(api.bookmarks.lastGoStatus, undefined, '需確認書籤應由 jumpToBookmark 顯示需確認提示，不被搜尋提示蓋掉');

    // 側邊欄搜尋中，跳到 1～9 號與依編號導覽仍照常涵蓋所有編號書籤
    const jumped = await vscode.commands.executeCommand<{ uri: vscode.Uri; line: number }>('functionBookmarks.goToNumberedBookmark', { number: 2 });
    assert.strictEqual(jumped?.line, 6);
    assert.strictEqual(pos(), `${relA}:6`);

    const tour = await vscode.commands.executeCommand<{ number: number; line: number }>('functionBookmarks.tourNext');
    assert.strictEqual(tour?.number, 3);
    assert.strictEqual(pos(), `${relB}:1`);
  });
});
