import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { addBookmark, emptyStore, serializeStore, setFavorite } from '../../../src/storage/marks';
import {
  activateExtension,
  cleanBothStorages,
  cleanupWorkspaceStore,
  findNode,
  folder,
  open,
  readStoreFile,
  resetWorkspace,
  runAndCancelQuickOpen,
  waitFor,
  workspaceFile,
} from './helpers';

describe('存放位置、寫入佇列、壞檔保護與啟動效能', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await activateExtension();
  });

  beforeEach(async () => {
    await resetWorkspace(api);
  });

  after(async () => {
    await cleanupWorkspaceStore(api);
  });

  describe('寫入佇列、手動還原與壞檔保護（CR-05）', () => {
    it('書籤檔格式壞掉時不覆寫，刪除壞檔後自動恢復正常', async () => {
      const file = workspaceFile('.vscode', 'function-bookmarks.json');
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode('{ broken'));
      await waitFor(() => api.store.isBroken(folder()), (v) => v, '偵測到書籤檔 JSON 損壞');
      await open(workspaceFile('app', 'views.py'), api);
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', findNode(api.provider.currentSymbolNodes, 'index'));
      assert.strictEqual(await readStoreFile(), '{ broken');
      await vscode.workspace.fs.delete(file);
      await waitFor(() => api.store.isBroken(folder()), (v) => !v, '刪除壞檔後解除損壞狀態');
    });

    it('連續快速並發更新後，磁碟內容必定等於最後一次更新', async () => {
      const count = 15;
      const tasks: Promise<boolean>[] = [];
      for (let i = 1; i <= count; i++) {
        tasks.push(
          api.store.update(folder(), () =>
            addBookmark(emptyStore(), { id: `seq-${i}`, file: 'app/views.py', line: i, label: `版本-${i}` }),
          ),
        );
      }
      await Promise.all(tasks);
      await api.store.flush();

      const diskText = await fsp.readFile(workspaceFile('.vscode', 'function-bookmarks.json').fsPath, 'utf8');
      const parsed = JSON.parse(diskText) as { bookmarks: { id: string }[] };
      assert.deepStrictEqual(parsed.bookmarks.map((b) => b.id), [`seq-${count}`]);
    });

    it('手動把書籤檔還原成前幾版內容時會重新載入，不被 recentWrites 忽略；延後存檔 flush 不遺漏', async () => {
      const storeFile = workspaceFile('.vscode', 'function-bookmarks.json').fsPath;
      await api.store.update(folder(), () => addBookmark(emptyStore(), { id: 'ver-1', file: 'app/views.py', line: 1, label: '第一版' }));
      await api.store.flush();
      const v1Text = await fsp.readFile(storeFile, 'utf8');

      await api.store.update(folder(), () => addBookmark(emptyStore(), { id: 'ver-2', file: 'app/views.py', line: 2, label: '第二版' }));
      await api.store.update(folder(), () => addBookmark(emptyStore(), { id: 'ver-3', file: 'app/views.py', line: 3, label: '第三版' }));
      await api.store.flush();
      assert.strictEqual(api.store.bookmarksFor(workspaceFile('app', 'views.py'))[0].id, 'ver-3');

      await fsp.writeFile(storeFile, v1Text, 'utf8');
      const reloaded = await waitFor(
        () => api.store.bookmarksFor(workspaceFile('app', 'views.py'))[0]?.id,
        (id) => id === 'ver-1',
        { timeoutMs: 6000, label: '外部還原舊版書籤檔後重新載入' },
      );
      assert.strictEqual(reloaded, 'ver-1');

      // 延後存檔呼叫 flush 與 flushPersist 正常落盤
      await api.store.update(
        folder(),
        () => addBookmark(emptyStore(), { id: 'defer-1', file: 'app/views.py', line: 2, label: '延後存檔' }),
        { deferSave: true },
      );
      await api.store.flush();
      assert.ok((await fsp.readFile(storeFile, 'utf8')).includes('defer-1'));
      await api.external.flushPersist();
    });
  });

  describe('存放模式切換、個別工作區選擇與錯過搬移提示', () => {
    it('切換 functionBookmarks.storage 設定：偵測來源資料、不悄悄覆蓋目標，支援複製與合併', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      api.store.suppressStoragePrompt = true;
      api.store.lastStorageSwitch = undefined;
      try {
        await api.store.update(folder(), (d) => addBookmark(d, { id: 'from-file', file: 'app/views.py', line: 1, label: '來自檔案' }));
        await cfg.update('storage', 'workspaceState', vscode.ConfigurationTarget.Workspace);
        const sw1 = await waitFor(() => api.store.lastStorageSwitch, (v) => v?.to === 'workspaceState', '偵測設定切換到 workspaceState');
        assert.strictEqual(sw1?.from, 'file');
        assert.strictEqual(sw1?.targetHadData, false);
        assert.strictEqual(api.store.allBookmarks().length, 0, '尚未確認複製前不主動覆蓋');

        await api.store.migrateStorageData(sw1!.prevData, 'copy');
        assert.deepStrictEqual(api.store.allBookmarks().map((e) => e.bookmark.id), ['from-file']);
        await api.store.update(folder(), (d) => addBookmark(d, { id: 'from-ws', file: 'app/views.py', line: 3, label: '來自工作區狀態' }));

        api.store.lastStorageSwitch = undefined;
        await cfg.update('storage', 'file', vscode.ConfigurationTarget.Workspace);
        const sw2 = await waitFor(() => api.store.lastStorageSwitch, (v) => v?.to === 'file', '偵測設定切回 file');
        assert.strictEqual(sw2?.targetHadData, true);
        assert.deepStrictEqual(api.store.allBookmarks().map((e) => e.bookmark.id), ['from-file']);

        await api.store.migrateStorageData(sw2!.prevData, 'merge');
        assert.deepStrictEqual(api.store.allBookmarks().map((e) => e.bookmark.id).sort(), ['from-file', 'from-ws']);
      } finally {
        await cleanBothStorages(api);
      }
    });

    it('個別專案選擇優先於設定、不改設定；改設定不影響已個別選擇的專案；按 Esc 取消不變更；選跟隨設定後恢復（含 CR-19）', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      const lastSwitch = () => api.store.lastStorageSwitch;
      api.store.suppressStoragePrompt = true;
      api.store.lastStorageSwitch = undefined;
      try {
        // 開 QuickPick 按 Esc 取消不改變存放模式
        const canceled = await runAndCancelQuickOpen(
          () => vscode.commands.executeCommand<string>('functionBookmarks.chooseStorage'),
          'chooseStorage 取消',
        );
        assert.strictEqual(canceled, undefined);
        assert.strictEqual(api.store.workspaceStorageOverride(), undefined);
        assert.strictEqual(api.store.effectiveStorageMode(), 'file');
        assert.strictEqual(lastSwitch(), undefined);

        await api.store.update(folder(), (d) => addBookmark(d, { id: 'per-ws-file', file: 'app/views.py', line: 1, label: '檔案端書籤' }));
        await api.store.flush();

        // 取消後再做一次切換：正常切換到 workspaceState
        const mode1 = await vscode.commands.executeCommand<string>('functionBookmarks.chooseStorage', 'workspaceState');
        assert.strictEqual(mode1, 'workspaceState');
        assert.strictEqual(api.store.workspaceStorageOverride(), 'workspaceState');
        assert.strictEqual(api.store.effectiveStorageMode(), 'workspaceState');
        assert.strictEqual(vscode.workspace.getConfiguration('functionBookmarks').get('storage'), 'file');

        const sw1 = lastSwitch();
        assert.strictEqual(sw1?.from, 'file');
        assert.strictEqual(sw1?.to, 'workspaceState');
        assert.strictEqual(sw1?.targetHadData, false);
        await api.store.migrateStorageData(sw1!.prevData, 'copy');
        await api.store.update(folder(), (d) => addBookmark(d, { id: 'per-ws-only', file: 'app/views.py', line: 3, label: '工作區端書籤' }));

        // 改設定不應影響已個別選擇的工作區
        api.store.lastStorageSwitch = undefined;
        await cfg.update('storage', 'workspaceState', vscode.ConfigurationTarget.Workspace);
        await cfg.update('storage', 'file', vscode.ConfigurationTarget.Workspace);
        await waitFor(() => vscode.workspace.getConfiguration('functionBookmarks').get('storage'), (v) => v === 'file', '設定寫回 file');
        assert.strictEqual(api.store.effectiveStorageMode(), 'workspaceState');
        assert.strictEqual(lastSwitch(), undefined);
        assert.strictEqual(api.store.allBookmarks().length, 2);

        // 切回跟隨設定並合併
        const mode2 = await vscode.commands.executeCommand<string>('functionBookmarks.chooseStorage', 'setting');
        assert.strictEqual(mode2, 'file');
        assert.strictEqual(api.store.workspaceStorageOverride(), undefined);
        const sw2 = lastSwitch();
        assert.strictEqual(sw2?.targetHadData, true);
        await api.store.migrateStorageData(sw2!.prevData, 'merge');
        assert.deepStrictEqual(api.store.allBookmarks().map((e) => e.bookmark.id).sort(), ['per-ws-file', 'per-ws-only']);
      } finally {
        await cleanBothStorages(api);
      }
    });

    it('錯過搬移提示重開再提示；選保持空白後不再提示；再次切換重置紀錄並可複製', async () => {
      api.store.suppressStoragePrompt = true;
      try {
        await api.store.update(folder(), (d) => addBookmark(d, { id: 'missed-bm', file: 'app/views.py', line: 2, label: '別弄丟我' }));
        await api.store.flush();
        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
        assert.strictEqual(api.store.allBookmarks().length, 0);

        const reopened1 = api.recreateStore();
        reopened1.suppressStoragePrompt = true;
        try {
          await reopened1.init();
          const found1 = await reopened1.checkOppositeStorage();
          assert.ok(found1 && found1.from === 'file' && found1.to === 'workspaceState' && found1.data.size === 1);
          await reopened1.applyOppositeStorageChoice(found1, 'keep');
        } finally {
          reopened1.dispose();
        }

        const reopened2 = api.recreateStore();
        reopened2.suppressStoragePrompt = true;
        try {
          await reopened2.init();
          assert.strictEqual(await reopened2.checkOppositeStorage(), undefined, '選保持空白後重開不應再提示');
        } finally {
          reopened2.dispose();
        }

        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'file');
        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
        const reopened3 = api.recreateStore();
        reopened3.suppressStoragePrompt = true;
        try {
          await reopened3.init();
          const found3 = await reopened3.checkOppositeStorage();
          assert.ok(found3, '重新切換後應重置保持空白紀錄');
          await reopened3.applyOppositeStorageChoice(found3, 'copy');
          assert.deepStrictEqual(reopened3.allBookmarks().map((e) => e.bookmark.id), ['missed-bm']);
        } finally {
          reopened3.dispose();
        }
      } finally {
        await cleanBothStorages(api);
      }
    });

    it('複製／合併後清光書籤重開不再復活；另一邊內容變動後會再提示（雙向皆適用）', async () => {
      api.store.suppressStoragePrompt = true;
      try {
        await api.store.update(folder(), (d) => addBookmark(d, { id: 'f-v1', file: 'app/views.py', line: 1, label: '檔案端 v1' }));
        await api.store.flush();
        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
        await api.store.migrateStorageData(api.store.lastStorageSwitch!.prevData, 'copy');
        await api.store.update(folder(), () => emptyStore());

        const reopened1 = api.recreateStore();
        reopened1.suppressStoragePrompt = true;
        try {
          await reopened1.init();
          assert.strictEqual(await reopened1.checkOppositeStorage(), undefined);
        } finally {
          reopened1.dispose();
        }

        const updatedFileData = addBookmark(
          addBookmark(emptyStore(), { id: 'f-v1', file: 'app/views.py', line: 1, label: '檔案端 v1' }),
          { id: 'f-v2', file: 'app/views.py', line: 4, label: '檔案端 v2' },
        );
        await vscode.workspace.fs.writeFile(
          workspaceFile('.vscode', 'function-bookmarks.json'),
          new TextEncoder().encode(serializeStore(updatedFileData)),
        );
        const reopened2 = api.recreateStore();
        reopened2.suppressStoragePrompt = true;
        try {
          await reopened2.init();
          const foundChanged = await reopened2.checkOppositeStorage();
          assert.ok(foundChanged);
          assert.deepStrictEqual([...foundChanged.data.values()][0].bookmarks.map((b) => b.id).sort(), ['f-v1', 'f-v2']);
          await reopened2.applyOppositeStorageChoice(foundChanged, 'keep');
          assert.strictEqual(await reopened2.checkOppositeStorage(), undefined);
        } finally {
          reopened2.dispose();
        }

        // 反方向 workspaceState -> file
        await api.store.update(folder(), (d) => addBookmark(d, { id: 'ws-v1', file: 'app/views.py', line: 2, label: '工作區端 v1' }));
        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'file');
        await api.store.migrateStorageData(api.store.lastStorageSwitch!.prevData, 'merge');
        await api.store.update(folder(), () => emptyStore());
        await api.store.flush();
        const reopened3 = api.recreateStore();
        reopened3.suppressStoragePrompt = true;
        try {
          await reopened3.init();
          assert.strictEqual(reopened3.effectiveStorageMode(), 'file');
          assert.strictEqual(await reopened3.checkOppositeStorage(), undefined);
        } finally {
          reopened3.dispose();
        }
      } finally {
        await cleanBothStorages(api);
      }
    });

    it('選擇存放位置 QuickPick：同時標示目前選項與實際生效的存放端', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      const cur = vscode.l10n.t('current');
      const active = vscode.l10n.t('active');
      api.store.suppressStoragePrompt = true;
      try {
        const descByValue = () => new Map(api.store.storagePickItems().map((i) => [i.value, i.description]));

        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'setting');
        await cfg.update('storage', 'file', vscode.ConfigurationTarget.Workspace);
        await waitFor(() => api.store.effectiveStorageMode(), (v) => v === 'file', '切換成 file');
        assert.deepStrictEqual([descByValue().get('file'), descByValue().get('workspaceState'), descByValue().get('setting')], [active, undefined, cur]);

        await cfg.update('storage', 'workspaceState', vscode.ConfigurationTarget.Workspace);
        await waitFor(() => api.store.effectiveStorageMode(), (v) => v === 'workspaceState', '切換成 workspaceState');
        assert.deepStrictEqual([descByValue().get('file'), descByValue().get('workspaceState'), descByValue().get('setting')], [undefined, active, cur]);

        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'file');
        assert.deepStrictEqual(
          [descByValue().get('file'), descByValue().get('workspaceState'), descByValue().get('setting')],
          [`${cur} · ${active}`, undefined, undefined],
        );

        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
        assert.deepStrictEqual(
          [descByValue().get('file'), descByValue().get('workspaceState'), descByValue().get('setting')],
          [undefined, `${cur} · ${active}`, undefined],
        );
      } finally {
        await cleanBothStorages(api);
      }
    });
  });

  describe('啟動效能與計時紀錄', () => {
    it('啟動記錄各階段耗時、背景檢查另一端存放不阻擋 activate.total，且函式書籤寫入後立即可見', async () => {
      const phases = api.startupTimings.map((t) => t.phase);
      assert.ok(phases.includes('store.init'));
      assert.ok(phases.includes('branches.refresh'));
      const total = api.startupTimings.find((t) => t.phase === 'activate.total');
      const opposite = api.startupTimings.find((t) => t.phase === 'storage.checkOpposite');
      assert.ok(total && opposite);
      assert.ok(opposite.atMs >= total.atMs, 'storage.checkOpposite 應在 activate.total 之後於背景執行');

      await api.store.update(folder(), (d) => setFavorite(d, { file: 'app/views.py', path: 'index', kind: 'function' }, true, 1));
      assert.strictEqual(api.favorites.all.length, 1, '寫入 store 後立即可見函式書籤');
      await api.favorites.whenReady();
      assert.strictEqual(api.favorites.all[0].status, 'ok');
    });
  });
});
