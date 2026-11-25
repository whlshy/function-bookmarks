import * as assert from 'assert';
import * as cp from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { addBookmark, emptyStore, serializeStore } from '../../../src/storage/marks';
import { makeAnchor, newBookmarkId } from '../../../src/bookmarks/model';
import type { StoreImportResult } from '../../../src/share/importer';
import { buildSearchMarkItems, filterSearchMarkItems } from '../../../src/views/search';
import type { BmGroupNode } from '../../../src/views/tree';
import { waitFor } from '../suite/helpers';

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
    // 側邊欄兩個資料夾的檔案都在，且多資料夾工作區會加上資料夾名稱以利區分（B3）
    await api.favorites.refresh();
    const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
    assert.deepStrictEqual(groups.map((g) => g.rel).sort(), ['app/views.py', 'lib/util.py']);
    const viewsGroup = groups.find((g) => g.rel === 'app/views.py')!;
    const utilGroup = groups.find((g) => g.rel === 'lib/util.py')!;
    assert.strictEqual(api.provider.getTreeItem(viewsGroup).description, `${f1().name} · app`);
    assert.strictEqual(api.provider.getTreeItem(utilGroup).description, `${f2().name} · lib`);
    assert.strictEqual(api.provider.getTreeItem(viewsGroup).tooltip, `${f1().name} · app/views.py`);
    assert.strictEqual(api.provider.getTreeItem(utilGroup).tooltip, `${f2().name} · lib/util.py`);
  });

  it('多資料夾工作區：不同資料夾有相同相對路徑的檔案時，依檔案分組能以資料夾名稱清楚區分（B3）', async () => {
    const f1Same = vscode.Uri.joinPath(f1().uri, 'shared', 'index.py');
    const f2Same = vscode.Uri.joinPath(f2().uri, 'shared', 'index.py');
    try {
      await fsp.mkdir(path.dirname(f1Same.fsPath), { recursive: true });
      await fsp.mkdir(path.dirname(f2Same.fsPath), { recursive: true });
      await fsp.writeFile(f1Same.fsPath, 'def from_one():\n    return 1\n', 'utf8');
      await fsp.writeFile(f2Same.fsPath, 'def from_two():\n    return 2\n', 'utf8');

      await at(f1Same, 1);
      await api.bookmarks.addLabeled('來自資料夾一');
      await at(f2Same, 1);
      await api.bookmarks.addLabeled('來自資料夾二');

      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      assert.strictEqual(groups.length, 2);
      const descs = groups.map((g) => String(api.provider.getTreeItem(g).description)).sort();
      assert.deepStrictEqual(descs, [`${f1().name} · shared`, `${f2().name} · shared`].sort());
      const tips = groups.map((g) => String(api.provider.getTreeItem(g).tooltip)).sort();
      assert.deepStrictEqual(tips, [`${f1().name} · shared/index.py`, `${f2().name} · shared/index.py`].sort());
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fsp.rm(path.dirname(f1Same.fsPath), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await fsp.rm(path.dirname(f2Same.fsPath), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
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

  async function fileExists(folder: vscode.WorkspaceFolder): Promise<boolean> {
    return vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, '.vscode', 'function-bookmarks.json')).then(
      () => true,
      () => false,
    );
  }

  async function clearDiskFiles(): Promise<void> {
    for (const f of folders()) {
      await api.store.update(f, () => emptyStore());
      await api.store.flush();
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(f.uri, '.vscode'), { recursive: true }).then(undefined, () => undefined);
    }
  }

  it('設定標籤顏色只寫進有書籤資料的資料夾，沒有資料的資料夾不會出現書籤檔；清除顏色時有該標籤顏色的資料夾都清掉', async () => {
    await clearDiskFiles();
    try {
      assert.strictEqual(await fileExists(f1()), false);
      assert.strictEqual(await fileExists(f2()), false);

      // 只有第二個資料夾有書籤：設定標籤顏色只寫進第二個，第一個不建立書籤檔
      await at(util(), 4);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await vscode.commands.executeCommand('functionBookmarks.setTagColor', 'todo', 'green');
      await api.store.flush();
      assert.strictEqual(await fileExists(f1()), false, '沒有書籤資料的資料夾不應建立 .vscode/function-bookmarks.json');
      assert.deepStrictEqual((await readJson(f2()))?.tagColors, { todo: 'green' });
      assert.strictEqual(api.store.tagColors().get('todo'), 'green');

      // 第一個資料夾也有書籤後再設定顏色：兩邊都寫入；清除顏色時兩邊都清乾淨
      await at(views(), 5);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await vscode.commands.executeCommand('functionBookmarks.setTagColor', 'todo', 'blue');
      await api.store.flush();
      assert.deepStrictEqual((await readJson(f1()))?.tagColors, { todo: 'blue' });
      assert.deepStrictEqual((await readJson(f2()))?.tagColors, { todo: 'blue' });

      await vscode.commands.executeCommand('functionBookmarks.setTagColor', 'todo', null);
      await api.store.flush();
      assert.strictEqual((await readJson(f1()))?.tagColors, undefined);
      assert.strictEqual((await readJson(f2()))?.tagColors, undefined);
      assert.strictEqual(api.store.tagColors().get('todo'), undefined);

      // 都沒有書籤資料時：清除不存在的標籤什麼都不寫；設定顏色只寫第一個資料夾
      await clearDiskFiles();
      await vscode.commands.executeCommand('functionBookmarks.setTagColor', 'absent', null);
      await api.store.flush();
      assert.strictEqual(await fileExists(f1()), false);
      assert.strictEqual(await fileExists(f2()), false);

      await vscode.commands.executeCommand('functionBookmarks.setTagColor', 'solo', 'purple');
      await api.store.flush();
      assert.deepStrictEqual((await readJson(f1()))?.tagColors, { solo: 'purple' });
      assert.strictEqual(await fileExists(f2()), false, '都沒有資料時只寫第一個資料夾');
      assert.strictEqual(api.store.tagColors().get('solo'), 'purple');

      await vscode.commands.executeCommand('functionBookmarks.setTagColor', 'solo', null);
      await api.store.flush();
      assert.strictEqual((await readJson(f1()))?.tagColors, undefined);
      assert.strictEqual(await fileExists(f2()), false);
    } finally {
      await clearDiskFiles();
    }
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

  it('快速搜尋書籤：多資料夾工作區顯示資料夾名稱，並可用資料夾名稱搜尋', async () => {
    await at(views(), 5);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    await at(util(), 4);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    const items = buildSearchMarkItems(api.store, api.favorites, { hideNotOnBranch: false });
    assert.strictEqual(items.length, 2);
    const inF1 = items.find((i) => i.detail?.includes('app/views.py'));
    const inF2 = items.find((i) => i.detail?.includes('lib/util.py'));
    assert.ok(inF1?.detail?.includes(f1().name), `應顯示資料夾名稱 ${f1().name}，實際：${inF1?.detail}`);
    assert.ok(inF2?.detail?.includes(f2().name), `應顯示資料夾名稱 ${f2().name}，實際：${inF2?.detail}`);
    // 可直接以資料夾名稱篩選
    const onlyF2 = filterSearchMarkItems(items, f2().name);
    assert.strictEqual(onlyF2.length, 1);
    assert.ok(onlyF2[0].detail?.includes('lib/util.py'));
  });

  it('依編號導覽會跨資料夾依 1→9 循環跳轉', async () => {
    await at(views(), 5);
    await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 1 });
    await at(util(), 4);
    await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 2 });
    await at(views(), 0);
    const s1 = await vscode.commands.executeCommand<{ number: number; uri: vscode.Uri }>('functionBookmarks.tourNext');
    assert.strictEqual(s1?.number, 1);
    assert.strictEqual(s1?.uri.toString(), views().toString());
    const s2 = await vscode.commands.executeCommand<{ number: number; uri: vscode.Uri }>('functionBookmarks.tourNext');
    assert.strictEqual(s2?.number, 2);
    assert.strictEqual(s2?.uri.toString(), util().toString());
    const s3 = await vscode.commands.executeCommand<{ number: number; uri: vscode.Uri }>('functionBookmarks.tourNext');
    assert.strictEqual(s3?.number, 1);
    assert.strictEqual(s3?.uri.toString(), views().toString());
  });

  it('個別檔案排序在多資料夾工作區各自獨立，且不寫進任何資料夾的書籤檔', async () => {
    const labelOf = (item: vscode.TreeItem) => (typeof item.label === 'string' ? item.label : (item.label?.label ?? ''));
    const childrenOf = async (uri: vscode.Uri) => {
      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const g = groups.find((x) => x.uri?.toString() === uri.toString())!;
      assert.ok(g);
      return { g, labels: (await api.provider.getChildren(g)).map((n) => labelOf(api.provider.getTreeItem(n))) };
    };
    try {
      await at(views(), 1);
      await api.bookmarks.addLabeled('zeta_v');
      await at(views(), 5);
      await api.bookmarks.addLabeled('alpha_v');
      await at(util(), 1);
      await api.bookmarks.addLabeled('zeta_u');
      await at(util(), 4);
      await api.bookmarks.addLabeled('alpha_u');

      const vBefore = await childrenOf(views());
      const uBefore = await childrenOf(util());
      assert.deepStrictEqual(vBefore.labels, ['zeta_v', 'alpha_v']);
      assert.deepStrictEqual(uBefore.labels, ['zeta_u', 'alpha_u']);

      // 只切換第一個資料夾的檔案為依標題排序；第二個資料夾不受影響
      await vscode.commands.executeCommand('functionBookmarks.sortFileBookmarksByTitle', vBefore.g);
      assert.deepStrictEqual((await childrenOf(views())).labels, ['alpha_v', 'zeta_v']);
      assert.deepStrictEqual((await childrenOf(util())).labels, ['zeta_u', 'alpha_u']);

      // 重建 provider 後兩邊各自保留
      const reopened = api.recreateProvider();
      try {
        assert.strictEqual(reopened.fileSortOf(views()), 'title');
        assert.strictEqual(reopened.fileSortOf(util()), 'line');
      } finally {
        reopened.dispose();
      }

      // 不寫進任何資料夾的書籤檔
      await api.store.flush();
      assert.ok(!JSON.stringify(await readJson(f1())).includes('bookmarkFileSort'));
      assert.ok(!JSON.stringify(await readJson(f2())).includes('bookmarkFileSort'));
    } finally {
      await api.provider.setFileSort(views(), 'line');
      await api.provider.setFileSort(util(), 'line');
    }
  });

  async function cleanAllStorages(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('functionBookmarks');
    api.store.suppressStoragePrompt = true;
    await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
    for (const f of folders()) {
      await api.store.update(f, () => emptyStore());
    }
    await api.store.clearHandledOpposite('workspaceState');
    await api.store.clearHandledOpposite('file');
    await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'file');
    for (const f of folders()) {
      await api.store.update(f, () => emptyStore());
      await api.store.flush();
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(f.uri, '.vscode', 'function-bookmarks.json')).then(undefined, () => undefined);
    }
    await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'setting');
    await cfg.update('storage', undefined, vscode.ConfigurationTarget.Workspace);
    api.store.lastStorageSwitch = undefined;
    api.store.lastOppositeCheck = undefined;
    api.store.suppressStoragePrompt = false;
  }

  it('多資料夾工作區：個別存放位置切換各自搬移不互蓋，改設定不影響，切回跟隨設定恢復', async () => {
    const cfg = vscode.workspace.getConfiguration('functionBookmarks');
    api.store.suppressStoragePrompt = true;
    try {
      await api.store.update(f1(), (d) => addBookmark(d, { id: 'm-f1', file: 'app/views.py', line: 1, label: '資料夾一' }));
      await api.store.update(f2(), (d) => addBookmark(d, { id: 'm-f2', file: 'lib/util.py', line: 2, label: '資料夾二' }));
      await api.store.flush();

      await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
      assert.strictEqual(api.store.effectiveStorageMode(), 'workspaceState');
      assert.ok(api.store.lastStorageSwitch);
      await api.store.migrateStorageData(api.store.lastStorageSwitch.prevData, 'copy');
      assert.deepStrictEqual(api.store.bookmarksFor(views()).map((b) => b.id), ['m-f1']);
      assert.deepStrictEqual(api.store.bookmarksFor(util()).map((b) => b.id), ['m-f2']);

      // 改設定不影響已個別選擇的工作區
      api.store.lastStorageSwitch = undefined;
      await cfg.update('storage', 'file', vscode.ConfigurationTarget.Workspace);
      await waitFor(() => vscode.workspace.getConfiguration('functionBookmarks').get('storage'), (v) => v === 'file', '設定寫入 file');
      assert.strictEqual(api.store.effectiveStorageMode(), 'workspaceState');
      assert.strictEqual(api.store.lastStorageSwitch, undefined);

      // 選跟隨設定後回到 file
      await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'setting');
      assert.strictEqual(api.store.effectiveStorageMode(), 'file');
      assert.deepStrictEqual(api.store.bookmarksFor(views()).map((b) => b.id), ['m-f1']);
      assert.deepStrictEqual(api.store.bookmarksFor(util()).map((b) => b.id), ['m-f2']);
    } finally {
      await cleanAllStorages();
    }
  });

  it('多資料夾工作區：錯過搬移提示只偵測目前空白的資料夾，不覆蓋已有資料的另一個資料夾，保持空白各自獨立', async () => {
    api.store.suppressStoragePrompt = true;
    try {
      // 兩個資料夾在 file 模式都有書籤
      await api.store.update(f1(), (d) => addBookmark(d, { id: 'f1-file', file: 'app/views.py', line: 1, label: 'F1舊' }));
      await api.store.update(f2(), (d) => addBookmark(d, { id: 'f2-file', file: 'lib/util.py', line: 1, label: 'F2舊' }));
      await api.store.flush();

      // 切到 workspaceState，只在 f2 建新書籤（f1 維持空白）
      await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
      await api.store.update(f2(), (d) => addBookmark(d, { id: 'f2-ws', file: 'lib/util.py', line: 4, label: 'F2新' }));

      // 模擬重開：只偵測到空白的 f1，不包含已有資料的 f2
      const reopened = api.recreateStore();
      reopened.suppressStoragePrompt = true;
      try {
        await reopened.init();
        const found = await reopened.checkOppositeStorage();
        assert.ok(found);
        assert.strictEqual(found.data.size, 1, '只應偵測目前空白的資料夾 f1');
        assert.deepStrictEqual([...found.data.values()][0].bookmarks.map((b) => b.id), ['f1-file']);

        // 複製過來：f1 收到 f1-file，f2 維持 f2-ws 不受影響
        await reopened.applyOppositeStorageChoice(found, 'copy');
        assert.deepStrictEqual(reopened.bookmarksFor(views()).map((b) => b.id), ['f1-file']);
        assert.deepStrictEqual(reopened.bookmarksFor(util()).map((b) => b.id), ['f2-ws']);

        // 複製後刻意清空 f1：file 端內容沒變，不應再提示把刪掉的書籤復活
        await reopened.update(f1(), () => emptyStore());
        assert.strictEqual(await reopened.checkOppositeStorage(), undefined, '複製後清空不應重複提示同一份來源');

        // 另一邊（f1 的書籤檔）內容之後又變了 → 再次偵測並可選「保持空白」略過
        const changedF1 = addBookmark(emptyStore(), { id: 'f1-file-v2', file: 'app/views.py', line: 3, label: 'F1更新' });
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(f1().uri, '.vscode', 'function-bookmarks.json'),
          new TextEncoder().encode(serializeStore(changedF1)),
        );
        const foundAgain = await reopened.checkOppositeStorage();
        assert.ok(foundAgain, '另一邊內容變動後應再次偵測');
        await reopened.applyOppositeStorageChoice(foundAgain, 'keep');
      } finally {
        reopened.dispose();
      }

      const reopened2 = api.recreateStore();
      reopened2.suppressStoragePrompt = true;
      try {
        await reopened2.init();
        assert.strictEqual(await reopened2.checkOppositeStorage(), undefined, '選保持空白後重開不再提示');
      } finally {
        reopened2.dispose();
      }
    } finally {
      await cleanAllStorages();
    }
  });

  it('多資料夾工作區：匯入書籤檔在 file 模式辨識正在使用的檔案，在 workspaceState 模式只匯入對應資料夾', async () => {
    api.store.suppressStoragePrompt = true;
    try {
      await api.store.update(f1(), (d) => addBookmark(d, { id: 'imp-f1', file: 'app/views.py', line: 1, label: 'F1書籤' }));
      await api.store.update(f2(), (d) => addBookmark(d, { id: 'imp-f2', file: 'lib/util.py', line: 2, label: 'F2書籤' }));
      await api.store.flush();

      // file 模式下選資料夾 1 正在使用的書籤檔
      const f1File = vscode.Uri.joinPath(f1().uri, '.vscode', 'function-bookmarks.json');
      const activeRes = await vscode.commands.executeCommand<StoreImportResult>('functionBookmarks.importBookmarks', {
        uri: f1File,
        confirmed: true,
      });
      assert.strictEqual(activeRes?.alreadyActive, true);

      // 切到 workspaceState（兩邊皆空），只匯入資料夾 1 的書籤檔
      await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
      const res = await vscode.commands.executeCommand<StoreImportResult>('functionBookmarks.importBookmarks', {
        uri: f1File,
        confirmed: true,
      });
      assert.strictEqual(res?.format, 'store');
      assert.strictEqual(res?.imported, 1);
      assert.deepStrictEqual(api.store.bookmarksFor(views()).map((b) => b.id), ['imp-f1']);
      assert.deepStrictEqual(api.store.bookmarksFor(util()).map((b) => b.id), [], '資料夾 2 不受影響');
    } finally {
      await cleanAllStorages();
    }
  });

  it('多資料夾工作區：importStoreData 避開其他資料夾已佔用的 1～9 號（CR-11）', async () => {
    // 資料夾 1 先佔用 1 號
    await at(views(), 5);
    await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 1 });
    assert.strictEqual(api.store.bookmarksFor(views())[0].number, 1);

    const incoming = serializeStore({
      version: 1,
      symbols: [],
      bookmarks: [
        { id: 'f2-conflict', file: 'lib/util.py', line: 1, label: '衝突1號', number: 1 },
        { id: 'f2-free', file: 'lib/util.py', line: 4, label: '可用2號', number: 2 },
      ],
    });
    // replace 模式匯入到資料夾 2
    const rReplace = await vscode.commands.executeCommand<StoreImportResult>('functionBookmarks.importBookmarks', {
      text: incoming,
      folder: f2(),
      mode: 'replace',
      confirmed: true,
    });
    assert.strictEqual(rReplace?.format, 'store');
    assert.strictEqual(api.store.bookmarksFor(views())[0].number, 1, '資料夾 1 的 1 號保持不變');
    assert.strictEqual(api.store.bookmarksFor(util()).find((b) => b.id === 'f2-conflict')?.number, undefined, 'replace 應清掉與資料夾 1 衝突的 1 號');
    assert.strictEqual(api.store.bookmarksFor(util()).find((b) => b.id === 'f2-free')?.number, 2, '不衝突的 2 號應保留');

    // merge 模式匯入到資料夾 2：同樣避開資料夾 1 的 1 號與資料夾 2 自己的 2 號
    const incomingMerge = serializeStore({
      version: 1,
      symbols: [],
      bookmarks: [
        { id: 'f2-m1', file: 'lib/util.py', line: 6, label: '合併衝突1號', number: 1 },
        { id: 'f2-m3', file: 'lib/util.py', line: 8, label: '合併可用3號', number: 3 },
      ],
    });
    const rMerge = await vscode.commands.executeCommand<StoreImportResult>('functionBookmarks.importBookmarks', {
      text: incomingMerge,
      folder: f2(),
      mode: 'merge',
      confirmed: true,
    });
    assert.strictEqual(rMerge?.format, 'store');
    assert.strictEqual(api.store.bookmarksFor(util()).find((b) => b.id === 'f2-m1')?.number, undefined, 'merge 應清掉與資料夾 1 衝突的 1 號');
    assert.strictEqual(api.store.bookmarksFor(util()).find((b) => b.id === 'f2-m3')?.number, 3, '不衝突的 3 號應保留');
  });

  it('多資料夾工作區：cleanBranchRecords 依資料夾判斷與清理，不誤刪另一資料夾仍在用的分支快照（CR-06）', async function () {
    this.timeout(60000);
    const git = (cwd: string, ...args: string[]) =>
      cp.execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], {
        cwd,
        stdio: 'pipe',
      });
    const f1Dir = f1().uri.fsPath;
    const f2Dir = f2().uri.fsPath;
    const f1Tmp = vscode.Uri.joinPath(f1().uri, 'app', 'tmp_cr06_a.py');
    const f2Tmp = vscode.Uri.joinPath(f2().uri, 'lib', 'tmp_cr06_b.py');
    const linesA1 = ['a1 = 1', 'a2 = 2', 'a3 = 3'];
    const linesA2 = ['# extra', 'a1 = 1', 'a2 = 2', 'a3 = 3'];
    const linesB1 = ['b1 = 1', 'b2 = 2', 'b3 = 3'];
    const linesB2 = ['# extra', 'b1 = 1', 'b2 = 2', 'b3 = 3'];

    try {
      await fsp.rm(path.join(f1Dir, '.git'), { recursive: true, force: true });
      await fsp.rm(path.join(f2Dir, '.git'), { recursive: true, force: true });

      // 資料夾 1：建立 main 與 shared-feat（稍後刪除 shared-feat）
      git(f1Dir, 'init');
      git(f1Dir, 'checkout', '-b', 'main');
      await fsp.writeFile(f1Tmp.fsPath, linesA1.join('\n') + '\n', 'utf8');
      git(f1Dir, 'add', 'app/tmp_cr06_a.py');
      git(f1Dir, 'commit', '-m', 'f1 main');
      git(f1Dir, 'checkout', '-b', 'shared-feat');
      await fsp.writeFile(f1Tmp.fsPath, linesA2.join('\n') + '\n', 'utf8');
      git(f1Dir, 'commit', '-am', 'f1 shared-feat');

      // 資料夾 2：建立 main、only-f2 與 shared-feat（兩者皆保留不刪！）
      git(f2Dir, 'init');
      git(f2Dir, 'checkout', '-b', 'main');
      await fsp.writeFile(f2Tmp.fsPath, linesB1.join('\n') + '\n', 'utf8');
      git(f2Dir, 'add', 'lib/tmp_cr06_b.py');
      git(f2Dir, 'commit', '-m', 'f2 main');
      git(f2Dir, 'checkout', '-b', 'only-f2');
      await fsp.writeFile(f2Tmp.fsPath, linesB2.join('\n') + '\n', 'utf8');
      git(f2Dir, 'commit', '-am', 'f2 only-f2');
      git(f2Dir, 'checkout', '-b', 'shared-feat');
      await fsp.writeFile(f2Tmp.fsPath, ['# extra 2', ...linesB2].join('\n') + '\n', 'utf8');
      git(f2Dir, 'commit', '-am', 'f2 shared-feat');

      await api.branches.rescan();

      // 在兩個資料夾各加書籤並切分支累積快照
      await api.store.update(f1(), (d) =>
        addBookmark(d, {
          id: newBookmarkId(),
          file: 'app/tmp_cr06_a.py',
          line: 2,
          anchor: makeAnchor(linesA2, 2),
          scope: 'branch',
          homeBranch: 'shared-feat',
          positions: { 'shared-feat': { line: 2 } },
        }),
      );
      await api.store.update(f2(), (d) =>
        addBookmark(d, {
          id: newBookmarkId(),
          file: 'lib/tmp_cr06_b.py',
          line: 2,
          anchor: makeAnchor(['# extra 2', ...linesB2], 2),
          positions: { 'shared-feat': { line: 2 }, 'only-f2': { line: 1 } },
        }),
      );
      await api.external.idle();

      // 資料夾 1 切回 main 並刪除 shared-feat（此時資料夾 1 有 shared-feat 的過期快照與紀錄）
      git(f1Dir, 'checkout', 'main');
      git(f1Dir, 'branch', '-D', 'shared-feat');
      // 資料夾 2 切到 only-f2 再切回 main（累積 shared-feat 與 only-f2 快照，且兩個分支在資料夾 2 皆仍存在）
      git(f2Dir, 'checkout', 'only-f2');
      await api.branches.refresh();
      await api.external.idle();
      git(f2Dir, 'checkout', 'main');
      await api.branches.refresh();
      await api.external.idle();

      assert.ok(api.external.snapshotBranches(f1Tmp).includes('shared-feat'), '資料夾 1 應有 shared-feat 快照');
      assert.ok(api.external.snapshotBranches(f2Tmp).includes('shared-feat'), '資料夾 2 應有 shared-feat 快照');
      assert.ok(api.external.snapshotBranches(f2Tmp).includes('only-f2'), '資料夾 2 應有 only-f2 快照');

      // 執行清理：嘗試清理 shared-feat 與 only-f2
      const cleaned = await vscode.commands.executeCommand<string[]>('functionBookmarks.cleanBranchRecords', ['shared-feat', 'only-f2']);
      assert.deepStrictEqual(cleaned, ['shared-feat'], 'only-f2 在資料夾 2 仍存在，不應被判定成已刪除分支');

      // 資料夾 1 的 shared-feat 快照與 homeBranch 已被清掉
      assert.ok(!api.external.snapshotBranches(f1Tmp).includes('shared-feat'), '資料夾 1 的 shared-feat 快照應被清除');
      const f1Bm = api.store.bookmarksFor(f1Tmp, { includeHidden: true })[0];
      assert.strictEqual(f1Bm.homeBranch, undefined, '資料夾 1 的過期 homeBranch 應解除');
      assert.strictEqual(f1Bm.positions?.['shared-feat'], undefined, '資料夾 1 的過期 positions 應清除');

      // 資料夾 2 的 shared-feat 與 only-f2 快照與 positions 必須完全保留！
      assert.ok(api.external.snapshotBranches(f2Tmp).includes('shared-feat'), '資料夾 2 仍在用的 shared-feat 快照不可被誤刪');
      assert.ok(api.external.snapshotBranches(f2Tmp).includes('only-f2'), '資料夾 2 仍在用的 only-f2 快照不可被誤刪');
      const f2Bm = api.store.bookmarksFor(f2Tmp, { includeHidden: true })[0];
      assert.ok(f2Bm.positions?.['shared-feat'], '資料夾 2 的 shared-feat position 不可被誤刪');
      assert.ok(f2Bm.positions?.['only-f2'], '資料夾 2 的 only-f2 position 不可被誤刪');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fsp.rm(path.join(f1Dir, '.git'), { recursive: true, force: true });
      await fsp.rm(path.join(f2Dir, '.git'), { recursive: true, force: true });
      await fsp.rm(f1Tmp.fsPath, { force: true });
      await fsp.rm(f2Tmp.fsPath, { force: true });
      await api.branches.rescan();
    }
  });
});
