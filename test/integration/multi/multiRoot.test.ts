import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { emptyStore } from '../../../src/storage/marks';
import type { BmGroupNode } from '../../../src/views/tree';

/**
 * 多資料夾工作區（multi-root）：兩個資料夾各自存一份書籤、跳轉與號碼跨資料夾、標籤顏色兩邊一致。
 * 以 test/fixtures/multi.code-workspace 開啟（workspace + workspace2）。
 */
describe('多資料夾工作區（整合測試）', () => {
  let api: ExtensionApi;
  const folders = () => vscode.workspace.workspaceFolders ?? [];
  const f1 = () => folders()[0];
  const f2 = () => folders()[1];
  const views = () => vscode.Uri.joinPath(f1().uri, 'app', 'views.py');
  const util = () => vscode.Uri.joinPath(f2().uri, 'lib', 'util.py');

  async function at(uri: vscode.Uri, line: number): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(uri);
    editor.selection = new vscode.Selection(line, 0, line, 0);
    await api.refreshNow();
    return editor;
  }

  async function readJson(folder: vscode.WorkspaceFolder): Promise<{ symbols: { file: string; path: string }[]; bookmarks?: { file: string; line: number }[]; tagColors?: Record<string, string> } | undefined> {
    try {
      return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.vscode', 'function-bookmarks.json'))));
    } catch {
      return undefined;
    }
  }

  before(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'function-bookmarks') as vscode.Extension<ExtensionApi>;
    api = await ext.activate();
  });

  beforeEach(async () => {
    for (const f of folders()) {
      await api.store.update(f, () => emptyStore());
    }
    await api.favorites.refresh();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const f of folders()) {
      await api.store.update(f, () => emptyStore());
      await api.store.flush();
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(f.uri, '.vscode'), { recursive: true }).then(undefined, () => undefined);
    }
  });

  it('開了兩個資料夾；書籤各自存在自己資料夾的書籤檔，路徑相對於該資料夾', async () => {
    assert.strictEqual(folders().length, 2);
    await at(views(), 5);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    await at(util(), 4);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    await at(util(), 3);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    await api.store.flush();
    const a = await readJson(f1());
    const b = await readJson(f2());
    assert.deepStrictEqual(a?.bookmarks?.map((x) => `${x.file}:${x.line}`), ['app/views.py:5']);
    assert.deepStrictEqual(b?.bookmarks?.map((x) => `${x.file}:${x.line}`), ['lib/util.py:4']);
    assert.deepStrictEqual(b?.symbols.map((x) => `${x.file}:${x.path}`), ['lib/util.py:read_config']);
    // 側邊欄兩個資料夾的檔案都在
    await api.favorites.refresh();
    const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
    assert.deepStrictEqual(groups.map((g) => g.rel).sort(), ['app/views.py', 'lib/util.py']);
  });

  it('下一個書籤會跨資料夾', async () => {
    await at(views(), 5);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    await at(util(), 4);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    await at(views(), 6);
    const next = await vscode.commands.executeCommand<{ uri: vscode.Uri; line: number }>('functionBookmarks.nextBookmark');
    assert.strictEqual(next?.uri.toString(), util().toString());
    const back = await vscode.commands.executeCommand<{ uri: vscode.Uri; line: number }>('functionBookmarks.nextBookmark');
    assert.strictEqual(back?.uri.toString(), views().toString(), '頭尾相接回到第一個資料夾');
  });

  it('數字書籤在整個視窗內不重複，可跨資料夾跳轉', async () => {
    await at(views(), 5);
    await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 1 });
    await at(util(), 4);
    await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 1 }, true);
    assert.strictEqual(api.store.bookmarksFor(views())[0].number, undefined, '另一個資料夾的 1 號被移走');
    assert.strictEqual(api.store.bookmarksFor(util())[0].number, 1);
    await at(views(), 0);
    await vscode.commands.executeCommand('functionBookmarks.goToNumberedBookmark', { number: 1 });
    assert.strictEqual(vscode.window.activeTextEditor!.document.uri.toString(), util().toString());
    assert.strictEqual(vscode.window.activeTextEditor!.selection.active.line, 4);
  });

  it('標籤顏色兩個資料夾都會套用', async () => {
    await vscode.commands.executeCommand('functionBookmarks.setTagColor', 'todo', 'orange');
    await api.store.flush();
    assert.deepStrictEqual((await readJson(f1()))?.tagColors, { todo: 'orange' });
    assert.deepStrictEqual((await readJson(f2()))?.tagColors, { todo: 'orange' });
    assert.strictEqual(api.store.tagColors().get('todo'), 'orange');
  });

  it('狀態列只算目前檔案（所在資料夾）的書籤', async () => {
    await at(views(), 5);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    await at(util(), 4);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    await at(util(), 9);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    api.statusBar.update();
    assert.strictEqual(api.statusBar.text, '$(bookmark) 2');
    assert.ok(api.statusBar.tooltip?.includes('3'));
  });
});
