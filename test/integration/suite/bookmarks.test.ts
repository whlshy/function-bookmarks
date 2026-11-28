import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { tagsPrompt } from '../../../src/bookmarks/commands';
import { makeAnchor, newBookmarkId } from '../../../src/bookmarks/model';
import { formatLocalDateTime } from '../../../src/util/time';
import { addBookmark, setFavorite, setNote, setTags } from '../../../src/storage/marks';
import type { BmGroupNode, BookmarkNode, FavoriteNode, FileNode, SymbolNode, TreeNode } from '../../../src/views/tree';
import {
  activateExtension,
  cleanupWorkspaceStore,
  findNode,
  folder,
  labelOf,
  open,
  openAt,
  readStoreFile,
  resetWorkspace,
  runAndCancelQuickOpen,
  waitFor,
  workspaceFile,
} from './helpers';

describe('書籤操作、函式書籤、數字導覽、顏色與快捷鍵', () => {
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

  describe('函式書籤（收藏）與自訂名稱', () => {
    it('加入函式書籤：寫入書籤檔，關閉所有檔案後書籤區仍看得到且不開啟分頁', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      const get = findNode(api.provider.currentSymbolNodes, 'ArticleView.get')!;
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', get);
      const text = await readStoreFile();
      assert.ok(text?.includes('"path": "ArticleView.get"'), text);
      const savedAddedAt = api.store.get(workspaceFile('app', 'views.py'), get.symbol)?.addedAt;
      assert.ok(savedAddedAt && Number.isFinite(Date.parse(savedAddedAt)), `函式書籤存檔後應有 addedAt：${savedAddedAt}`);
      assert.ok(text?.includes(`"addedAt": "${savedAddedAt}"`), text);
      assert.ok(api.provider.getTreeItem(get).description?.toString().startsWith('★'));

      // 取消再重新加入函式書籤：建立時間應更新
      await new Promise((r) => setTimeout(r, 20));
      await vscode.commands.executeCommand('functionBookmarks.removeFavorite', get);
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', get);
      const reAddedAt = api.store.get(workspaceFile('app', 'views.py'), get.symbol)?.addedAt;
      assert.ok(reAddedAt && Date.parse(reAddedAt) > Date.parse(savedAddedAt), `重加應有較新的建立時間：${savedAddedAt} -> ${reAddedAt}`);

      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.refreshNow();
      await api.favorites.refresh();
      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      assert.deepStrictEqual(groups.map((g) => g.rel), ['app/views.py']);
      const favs = (await api.provider.getChildren(groups[0])) as FavoriteNode[];
      assert.strictEqual(favs[0].fav.status, 'ok');
      assert.strictEqual(favs[0].fav.symbol?.nameLine, 11);
      assert.strictEqual(vscode.window.visibleTextEditors.length, 0, '背景讀取不應開啟分頁');
    });

    it('點擊函式書籤：開啟檔案並跳到函式', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', findNode(api.provider.currentSymbolNodes, 'index'));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.favorites.refresh();
      const fav = api.favorites.all[0];
      const item = api.provider.getTreeItem({ type: 'favorite', fav, parent: api.provider.sections.bookmarks });
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      const editor = vscode.window.activeTextEditor!;
      assert.ok(editor.document.uri.path.endsWith('app/views.py'));
      assert.strictEqual(editor.document.getText(editor.selection), 'index');
    });

    it('從游標位置切換函式書籤，行號旁圖示同步出現與移除', async () => {
      const editor = await open(workspaceFile('app', 'views.py'), api);
      const line = editor.document.getText().split('\n').findIndex((l) => l.includes('return "post"'));
      editor.selection = new vscode.Selection(line, 0, line, 0);
      await vscode.commands.executeCommand('functionBookmarks.toggleFavorite');
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all.map((f) => f.mark.path), ['ArticleView.post']);

      const post = findNode(api.provider.currentSymbolNodes, 'ArticleView.post')!;
      const lines = await waitFor(
        async () => {
          await api.gutter.update();
          return api.gutter.linesFor(editor.document.uri);
        },
        (v) => v.length === 1,
        '函式書籤行號圖示出現',
      );
      assert.deepStrictEqual(lines, [post.symbol.nameLine]);

      await vscode.commands.executeCommand('functionBookmarks.toggleFavorite');
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all, []);
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(editor.document.uri), []);
    });

    it('自訂顯示名稱：樹狀檢視顯示新名稱，提示保留原名與路徑；清空即恢復', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      const get = findNode(api.provider.currentSymbolNodes, 'ArticleView.get')!;
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', get);
      await api.commands.rename(get, '文章頁 GET');
      const item = api.provider.getTreeItem(get);
      assert.strictEqual(item.label, '文章頁 GET');
      assert.ok(item.description?.toString().startsWith('★✎'));
      const tip = (item.tooltip as vscode.MarkdownString).value;
      assert.ok(tip.includes('`get`') && tip.includes('`ArticleView.get`'), tip);
      assert.ok(item.contextValue?.includes(':alias'));
      await api.commands.rename(get, '');
      assert.strictEqual(api.provider.getTreeItem(get).label, 'get');
    });

    it('函式被刪除（例如 git pull）：反灰顯示「找不到函式」；恢復後自動找回並更新行號', async () => {
      const uri = workspaceFile('app', 'tmp_deleted.py');
      const full = 'def keep():\n    pass\n\n\ndef target():\n    pass\n';
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(full));
      try {
        await open(uri, api);
        await vscode.commands.executeCommand('functionBookmarks.addFavorite', findNode(api.provider.currentSymbolNodes, 'target'));
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('def keep():\n    pass\n'));
        const missing = await waitFor(
          async () => {
            await api.favorites.refresh();
            return api.favorites.all[0]?.status;
          },
          (s) => s === 'missing',
          '函式刪除後標成 missing',
        );
        assert.strictEqual(missing, 'missing');
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`\n\n${full}`));
        const back = await waitFor(
          async () => {
            await api.favorites.refresh();
            return api.favorites.all[0];
          },
          (f) => f?.status === 'ok',
          '函式恢復後找回',
        );
        assert.strictEqual(back.status, 'ok');
        assert.strictEqual(back.symbol?.nameLine, 6, '行號跟著更新');
      } finally {
        await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
      }
    });

    it('檔案改名：函式書籤跟著更新路徑', async () => {
      const from = workspaceFile('app', 'tmp_rename_a.py');
      const to = workspaceFile('app', 'tmp_rename_b.py');
      await vscode.workspace.fs.writeFile(from, new TextEncoder().encode('def moved():\n    pass\n'));
      try {
        await open(from, api);
        await vscode.commands.executeCommand('functionBookmarks.addFavorite', findNode(api.provider.currentSymbolNodes, 'moved'));
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(from, to);
        assert.ok(await vscode.workspace.applyEdit(edit));
        const files = await waitFor(
          () => api.store.allFavorites().map((f) => f.mark.file),
          (v) => v[0] === 'app/tmp_rename_b.py',
          '檔案改名後書籤路徑更新',
        );
        assert.deepStrictEqual(files, ['app/tmp_rename_b.py']);
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        for (const u of [from, to]) {
          await vscode.workspace.fs.delete(u).then(undefined, () => undefined);
        }
      }
    });
  });

  describe('行號書籤與函式書籤整合、滑鼠提示與改名追蹤', () => {
    const fileA = () => workspaceFile('app', 'tmp_bm_a.py');
    const fileB = () => workspaceFile('app', 'tmp_bm_b.py');
    const fileC = () => workspaceFile('app', 'tmp_mix.py');
    const body = Array.from({ length: 20 }, (_, i) => `line_${i} = ${i}`).join('\n') + '\n';
    const mixSrc = ['def alpha():', '    x = 1', '    return x', '', '', 'def beta():', '    y = 2', '    return y', ''].join('\n');
    const linesOf = (uri: vscode.Uri) => api.store.bookmarksFor(uri).map((b) => b.line);

    before(async () => {
      await vscode.workspace.fs.writeFile(fileA(), new TextEncoder().encode(`def helper():\n    pass\n\n${body}`));
      await vscode.workspace.fs.writeFile(fileB(), new TextEncoder().encode(body));
      await vscode.workspace.fs.writeFile(fileC(), new TextEncoder().encode(mixSrc));
    });

    after(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      for (const u of [fileA(), fileB(), fileC()]) {
        await vscode.workspace.fs.delete(u).then(undefined, () => undefined);
      }
    });

    async function setupMix(): Promise<{ beta: FavoriteNode; line: BookmarkNode }> {
      await openAt(fileC(), 5, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await openAt(fileC(), 6, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.favorites.refresh();
      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const group = groups.find((g) => g.rel === 'app/tmp_mix.py')!;
      const children = await api.provider.getChildren(group);
      return {
        beta: children.find((c) => c.type === 'favorite') as FavoriteNode,
        line: children.find((c) => c.type === 'bookmark') as BookmarkNode,
      };
    }

    it('切換書籤、多游標與行號右鍵選單：加入、記錄 anchor 與所在函式、再按一次移除', async () => {
      await openAt(fileA(), 1, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      const [bm] = api.store.bookmarksFor(fileA());
      assert.strictEqual(bm.line, 1);
      assert.strictEqual(bm.anchor?.text, 'pass');
      assert.strictEqual(bm.anchor?.symbolPath, 'helper');
      assert.ok((await readStoreFile())?.includes('"bookmarks"'));

      const groups = await api.provider.getChildren(api.provider.sections.bookmarks);
      assert.strictEqual(groups.length, 1);
      const nodes = await api.provider.getChildren(groups[0]);
      const item = api.provider.getTreeItem(nodes[0]);
      assert.strictEqual(item.label, 'pass', '沒有名稱時顯示該行內容');
      assert.strictEqual(item.description, '2');

      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      assert.deepStrictEqual(linesOf(fileA()), []);

      // 多游標每一行各自切換
      const editorB = await openAt(fileB(), 0, api);
      editorB.selections = [3, 5, 5, 7].map((l) => new vscode.Selection(l, 0, l, 0));
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      assert.deepStrictEqual(linesOf(fileB()), [3, 5, 7]);
      await api.bookmarks.clearFile(fileB(), true);
      assert.deepStrictEqual(linesOf(fileB()), []);

      // 行號右鍵選單：對指定的行（非游標行）切換書籤
      await openAt(fileC(), 0, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark', { lineNumber: 3, uri: fileC() });
      assert.ok(api.store.bookmarksFor(fileC()).some((b) => b.line === 2));
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark', { lineNumber: 3, uri: fileC() });
      assert.ok(!api.store.bookmarksFor(fileC()).some((b) => b.line === 2));
    });

    it('toggleBookmark：函式名稱行建函式書籤、其他行建行號書籤；書籤區依行號混排', async () => {
      await openAt(fileC(), 0, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await openAt(fileC(), 6, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await openAt(fileC(), 5, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all.map((f) => f.mark.path).sort(), ['alpha', 'beta']);
      assert.deepStrictEqual(api.store.bookmarksFor(fileC()).map((b) => b.line), [6]);

      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const group = groups.find((g) => g.rel === 'app/tmp_mix.py')!;
      const children = await api.provider.getChildren(group);
      assert.deepStrictEqual(
        children.map((c) => `${c.type}:${labelOf(api.provider.getTreeItem(c))}`),
        ['favorite:alpha', 'favorite:beta', 'bookmark:y = 2'],
        '同一檔案內依行號混排',
      );
      assert.ok(String(api.provider.getTreeItem(api.provider.sections.bookmarks).description).startsWith('3'));

      await openAt(fileC(), 0, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all.map((f) => f.mark.path), ['beta'], '再按一次取消函式書籤');
    });

    it('名稱、標籤、依標籤分組（函式書籤與行號書籤共同列出）與備註提示', async () => {
      await openAt(fileA(), 5, api);
      await api.bookmarks.addLabeled('登入入口');
      const [bm] = api.store.bookmarksFor(fileA());
      assert.strictEqual(bm.label, '登入入口');
      const node = { type: 'bookmark' as const, entry: api.store.allBookmarks()[0], parent: api.provider.sections.bookmarks };
      await api.bookmarks.editTags(node, '#auth, 待修');
      await api.bookmarks.editNote(node, '第一行\n\n```mermaid\nflowchart TD\n  A --> B\n```');
      const fresh = { ...node, entry: api.store.allBookmarks()[0] };
      assert.deepStrictEqual(fresh.entry.bookmark.tags, ['auth', '待修']);
      const item = api.provider.getTreeItem(fresh);
      assert.strictEqual(item.label, '登入入口');
      assert.ok(String(item.description).includes('#auth #待修'));
      const tip = (item.tooltip as vscode.MarkdownString).value;
      assert.ok(tip.includes('flowchart TD'), '提示直接顯示 Mermaid 原始碼');
      assert.ok(tip.includes('command:functionBookmarks.previewNote?'));

      const { beta, line } = await setupMix();
      await api.commands.editTags(beta, '#auth');
      await api.bookmarks.editTags(line, '#auth #db');
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all.find((f) => f.mark.path === 'beta')?.mark.tags, ['auth']);
      assert.strictEqual(api.provider.getTreeItem(beta).contextValue?.startsWith('fbBookmark:fn'), true);

      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByTag');
      try {
        const tags = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
        assert.deepStrictEqual(tags.map((t) => labelOf(api.provider.getTreeItem(t))).sort(), ['#auth', '#db', '#待修']);
        const authGroup = tags.find((t) => t.key === 'auth')!;
        assert.ok(authGroup.items.some((i) => i.kind === 'symbol') && authGroup.items.some((i) => i.kind === 'line'));
      } finally {
        await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
      }
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileA(), 'bookmark'), [5]);
      await api.bookmarks.clearAll(true);
      assert.strictEqual(api.store.allBookmarks().length, 0);
    });

    it('下一個／上一個書籤：跨檔案頭尾相接，涵蓋函式書籤與行號書籤；清除同時清除兩種', async () => {
      await openAt(fileA(), 4, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await openAt(fileB(), 2, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await openAt(fileA(), 0, api);
      const pos = () => {
        const e = vscode.window.activeTextEditor!;
        return `${path.basename(e.document.uri.fsPath)}:${e.selection.active.line}`;
      };
      await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
      assert.strictEqual(pos(), 'tmp_bm_a.py:4');
      await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
      assert.strictEqual(pos(), 'tmp_bm_b.py:2');
      await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
      assert.strictEqual(pos(), 'tmp_bm_a.py:4');
      await vscode.commands.executeCommand('functionBookmarks.previousBookmark');
      assert.strictEqual(pos(), 'tmp_bm_b.py:2');
      await api.bookmarks.clearAll(true);

      await setupMix();
      await openAt(fileC(), 0, api);
      await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
      assert.strictEqual(pos(), 'tmp_mix.py:5', '先到函式書籤 beta');
      await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
      assert.strictEqual(pos(), 'tmp_mix.py:6', '再到行號書籤');
      await api.bookmarks.clearFile(fileC(), true);
      await api.favorites.refresh();
      assert.strictEqual(api.store.bookmarksFor(fileC()).length, 0);
      assert.ok(!api.favorites.all.some((f) => f.mark.file === 'app/tmp_mix.py'));
    });

    it('下一個／上一個書籤：中間的檔案在磁碟上被刪掉時跳過它，不會卡在同一個', async () => {
      const gone = workspaceFile('app', 'tmp_bm_aa.py');
      await fsp.writeFile(gone.fsPath, body);
      try {
        await openAt(fileA(), 4, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
        await openAt(gone, 3, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
        await openAt(fileB(), 2, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
        await api.store.flush();
        // 先關掉分頁再刪檔：分頁開著時 VS Code 仍保有內容，開得起來
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await fsp.rm(gone.fsPath, { force: true });
        await openAt(fileA(), 0, api);
        const pos = () => {
          const e = vscode.window.activeTextEditor!;
          return `${path.basename(e.document.uri.fsPath)}:${e.selection.active.line}`;
        };
        await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
        assert.strictEqual(pos(), 'tmp_bm_a.py:4');
        await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
        assert.strictEqual(pos(), 'tmp_bm_b.py:2', '跳過已刪除的 tmp_bm_aa.py');
        await vscode.commands.executeCommand('functionBookmarks.previousBookmark');
        assert.strictEqual(pos(), 'tmp_bm_a.py:4', '往回也跳過');
      } finally {
        await api.bookmarks.clearAll(true);
        await fsp.rm(gone.fsPath, { force: true });
      }
    });

    it('下一個／上一個書籤：navigationScope（currentFile）與 navigationWrap（false／預設 true）設定', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      const gone = workspaceFile('app', 'tmp_bm_zz.py');
      const pos = () => {
        const e = vscode.window.activeTextEditor!;
        return `${path.basename(e.document.uri.fsPath)}:${e.selection.active.line}`;
      };
      try {
        // fileA：函式書籤（行 0 helper）＋行號書籤（行 4）；fileB：行號書籤（行 2）
        await openAt(fileA(), 0, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
        await openAt(fileA(), 4, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
        await openAt(fileB(), 2, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
        await api.favorites.refresh();

        // 1. 預設值（all + wrap: true）跨檔案循環
        await openAt(fileB(), 2, api);
        await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
        assert.strictEqual(pos(), 'tmp_bm_a.py:0', '預設應從最後一個繞回第一個');

        // 2. navigationScope = currentFile：只在目前檔案裡跳（含函式書籤與行號書籤）
        await cfg.update('bookmarks.navigationScope', 'currentFile', vscode.ConfigurationTarget.Workspace);
        await openAt(fileA(), 0, api);
        await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
        assert.strictEqual(pos(), 'tmp_bm_a.py:4');
        await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
        assert.strictEqual(pos(), 'tmp_bm_a.py:0', 'currentFile 且預設循環時只在本檔內繞回，不跳到 fileB');
        await vscode.commands.executeCommand('functionBookmarks.previousBookmark');
        assert.strictEqual(pos(), 'tmp_bm_a.py:4', '往回也只在本檔內繞回');

        // 目前檔案沒有書籤：不動，回傳 undefined
        await openAt(fileC(), 1, api);
        const noneInFile = await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
        assert.strictEqual(noneInFile, undefined);
        assert.strictEqual(pos(), 'tmp_mix.py:1');

        // 沒有作用中的編輯器時，currentFile 當成 all
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
        assert.strictEqual(pos(), 'tmp_bm_a.py:0', '無作用中編輯器時 fallback 到 all');

        // 3. navigationScope = currentFile 且 navigationWrap = false：到本檔頭尾停住
        await cfg.update('bookmarks.navigationWrap', false, vscode.ConfigurationTarget.Workspace);
        await openAt(fileA(), 0, api);
        assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.previousBookmark'), undefined);
        assert.strictEqual(pos(), 'tmp_bm_a.py:0', '本檔第一個再按上一個應停住');
        await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
        assert.strictEqual(pos(), 'tmp_bm_a.py:4');
        assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.nextBookmark'), undefined);
        assert.strictEqual(pos(), 'tmp_bm_a.py:4', '本檔最後一個再按下一個應停住');

        // 4. navigationScope = all 且 navigationWrap = false：跨檔案到頭尾停住
        await cfg.update('bookmarks.navigationScope', 'all', vscode.ConfigurationTarget.Workspace);
        await openAt(fileA(), 4, api);
        await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
        assert.strictEqual(pos(), 'tmp_bm_b.py:2');
        assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.nextBookmark'), undefined);
        assert.strictEqual(pos(), 'tmp_bm_b.py:2', '最後一個再按下一個應停住不繞回');
        await vscode.commands.executeCommand('functionBookmarks.previousBookmark');
        assert.strictEqual(pos(), 'tmp_bm_a.py:4');
        await vscode.commands.executeCommand('functionBookmarks.previousBookmark');
        assert.strictEqual(pos(), 'tmp_bm_a.py:0');
        assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.previousBookmark'), undefined);
        assert.strictEqual(pos(), 'tmp_bm_a.py:0', '第一個再按上一個應停住不繞回');

        // 5. navigationWrap = false 時，最後一個檔案已從磁碟刪除：跳過後沒有剩餘目標，視為已到最後一個而不丟錯
        await fsp.writeFile(gone.fsPath, body);
        await openAt(gone, 3, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
        await api.store.flush();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await fsp.rm(gone.fsPath, { force: true });
        await openAt(fileB(), 2, api);
        assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.nextBookmark'), undefined);
        assert.strictEqual(pos(), 'tmp_bm_b.py:2', '跳過已刪除的最後一個檔案後應停在原位');

        // 6. 恢復預設（navigationWrap = undefined → true）後立即重新循環
        await cfg.update('bookmarks.navigationWrap', undefined, vscode.ConfigurationTarget.Workspace);
        await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
        assert.strictEqual(pos(), 'tmp_bm_a.py:0', '恢復預設後應立即恢復循環');
      } finally {
        await cfg.update('bookmarks.navigationScope', undefined, vscode.ConfigurationTarget.Workspace);
        await cfg.update('bookmarks.navigationWrap', undefined, vscode.ConfigurationTarget.Workspace);
        await api.bookmarks.clearAll(true);
        await fsp.rm(gone.fsPath, { force: true });
      }
    });

    it('滑鼠移到函式名稱上：可加入／移除書籤並併入備註；未加書籤不能改名／寫備註；設定可關閉', async () => {
      await openAt(fileC(), 0, api);
      const ours = async (line: number, ch: number) =>
        ((await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', fileC(), new vscode.Position(line, ch))) ?? [])
          .flatMap((h) => h.contents)
          .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
          .filter((v) => v.includes('command:functionBookmarks.hoverAction'));

      // 未加入書籤：不能改名或寫備註，滑鼠提示只顯示加入書籤
      const alphaNode = findNode(api.provider.currentSymbolNodes, 'alpha')!;
      await api.commands.rename(alphaNode, '不該成功');
      await api.commands.editNote(alphaNode, '不該成功');
      assert.strictEqual(api.store.get(fileC(), alphaNode.symbol), undefined);
      assert.ok(/^fbSymbol:nofav/.test(api.provider.getTreeItem(alphaNode).contextValue ?? ''));

      const hover = await waitFor(() => ours(0, 5), (h) => h.length === 1, '函式名稱懸停提示出現');
      assert.ok(hover[0].includes('star-empty'), '尚未加入時顯示 ☆');
      assert.ok(hover[0].includes('%22toggle%22'));
      assert.ok(!hover[0].includes('%22rename%22') && !hover[0].includes('%22note%22'));
      assert.deepStrictEqual(await ours(1, 5), [], '不在函式名稱上不顯示');

      const arg = (action: string) => ({ action, uri: fileC().toString(), path: 'alpha', kind: 'function', line: 0 });
      await vscode.commands.executeCommand('functionBookmarks.hoverAction', arg('toggle'));
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all.map((f) => f.mark.path), ['alpha']);
      const on = await ours(0, 5);
      assert.ok(on[0].includes('star-full'), '已加入時顯示 ★ 移除書籤');
      const fnAddedAt = api.store.get(fileC(), alphaNode.symbol)?.addedAt;
      assert.ok(fnAddedAt, 'hover 加入函式書籤應有建立時間');
      assert.ok(on[0].includes(`Created ${formatLocalDateTime(fnAddedAt)}`), `函式 hover 提示應顯示建立時間：${on[0]}`);

      await api.commands.rename(alphaNode, '第一個');
      assert.strictEqual(api.store.get(fileC(), alphaNode.symbol)?.alias, '第一個');
      await api.commands.editNote(alphaNode, '筆記內容');
      const withNote = await ours(0, 5);
      assert.strictEqual(withNote.length, 1, '備註併入同一個提示，不會跳出兩個');
      assert.ok(withNote[0].includes('筆記內容'));
      assert.ok(
        withNote[0].indexOf('筆記內容') < withNote[0].indexOf(`Created ${formatLocalDateTime(fnAddedAt)}`),
        `建立時間不應放在備註前面：${withNote[0]}`,
      );

      // 行號書籤 gutter 提示顯示建立時間且不放在備註前面；沒有建立時間時不顯示
      await openAt(fileC(), 1, api);
      await api.bookmarks.addLabeled('帶備註行');
      const lineBm = api.store.bookmarksFor(fileC()).find((b) => b.line === 1)!;
      assert.ok(lineBm.createdAt);
      await api.bookmarks.editNote({ type: 'bookmark', entry: { folder: folder(), uri: fileC(), bookmark: lineBm } }, '行書籤備註');
      await api.gutter.update();
      const lineHover = api.gutter.hoverAt(fileC(), 1)!;
      const lineCreatedText = `Created ${formatLocalDateTime(lineBm.createdAt)}`;
      assert.ok(lineHover.includes(lineCreatedText), `行書籤 gutter 提示應顯示建立時間：${lineHover}`);
      assert.ok(lineHover.indexOf('行書籤備註') < lineHover.indexOf(lineCreatedText), `建立時間不應放在備註前面：${lineHover}`);
      await api.bookmarks.remove({ type: 'bookmark', entry: { folder: folder(), uri: fileC(), bookmark: lineBm } });

      await vscode.commands.executeCommand('functionBookmarks.hoverAction', arg('toggle'));
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all, []);

      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      await cfg.update('hover.enabled', false, vscode.ConfigurationTarget.Workspace);
      try {
        await waitFor(() => ours(0, 5), (h) => h.length === 0, 'hover.enabled 關閉後不顯示提示');
      } finally {
        await cfg.update('hover.enabled', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });

    it('程式碼中或外部改了函式名稱：書籤、自訂名稱、備註、標籤自動轉到新名稱', async () => {
      // 1. 編輯器內改名
      const editor = await openAt(fileC(), 5, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      const beta = findNode(api.provider.currentSymbolNodes, 'beta')!;
      await api.commands.rename(beta, '第二個');
      await api.commands.editNote(beta, '說明');
      await api.commands.editTags(beta, '#api');
      await editor.edit((b) => b.replace(new vscode.Range(5, 4, 5, 8), 'beta_v2'));
      const moved = await waitFor(
        () => api.store.allFavorites().find((f) => f.mark.file === 'app/tmp_mix.py'),
        (f) => f?.mark.path === 'beta_v2',
        '編輯器改函式名後書籤轉移到 beta_v2',
      );
      assert.deepStrictEqual(
        { path: moved?.mark.path, alias: moved?.mark.alias, note: moved?.mark.note, tags: moved?.mark.tags },
        { path: 'beta_v2', alias: '第二個', note: '說明', tags: ['api'] },
      );
      await api.favorites.refresh();
      assert.strictEqual(api.favorites.all.find((f) => f.mark.path === 'beta_v2')?.status, 'ok');
      await vscode.commands.executeCommand('workbench.action.files.revert');

      // 2. 檔案沒開著時外部改名（例如 git pull）
      await resetWorkspace(api);
      await openAt(fileC(), 0, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.workspace.fs.writeFile(fileC(), new TextEncoder().encode(mixSrc.replace('def alpha(', 'def alpha_renamed(')));
      try {
        const f = await waitFor(
          async () => {
            await api.favorites.refresh();
            return api.favorites.all.find((x) => x.mark.file === 'app/tmp_mix.py');
          },
          (x) => x?.mark.path === 'alpha_renamed',
          '外部改函式名後背景轉移到 alpha_renamed',
        );
        assert.strictEqual(f?.status, 'ok');
      } finally {
        await vscode.workspace.fs.writeFile(fileC(), new TextEncoder().encode(mixSrc));
      }
    });
  });

  describe('游標指令、標籤提示、側邊欄 F2 與取消路徑', () => {
    it('renameBookmark：行號書籤優先於外層函式書籤；無書籤與按 Esc 取消不更動資料', async () => {
      const views = workspaceFile('app', 'views.py');
      await openAt(views, 4, api);
      assert.strictEqual(await api.updateCursorBookmarkContext(), false, '尚未加書籤時 cursorHasBookmark 應為 false');

      await vscode.commands.executeCommand('functionBookmarks.renameBookmark', undefined, '不應寫入');
      assert.strictEqual(api.store.allFavorites().length, 0);
      assert.strictEqual(api.store.bookmarksFor(views).length, 0);

      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.favorites.refresh();
      assert.strictEqual(await api.updateCursorBookmarkContext(), true);

      await openAt(views, 5, api);
      assert.strictEqual(await api.updateCursorBookmarkContext(), true);
      await vscode.commands.executeCommand('functionBookmarks.renameBookmark', undefined, '首頁入口');
      assert.strictEqual(api.store.get(views, { path: 'index', kind: 'function' })?.alias, '首頁入口');

      // 編輯器右鍵（傳入檔案 Uri）也能改名
      await vscode.commands.executeCommand('functionBookmarks.renameBookmark', views, '首頁處理函式');
      assert.strictEqual(api.store.get(views, { path: 'index', kind: 'function' })?.alias, '首頁處理函式');

      await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.renameBookmark'), '函式書籤改名取消');
      assert.strictEqual(api.store.get(views, { path: 'index', kind: 'function' })?.alias, '首頁處理函式');

      // 同行有行號書籤時優先改行號書籤，不動外層函式名稱
      await api.bookmarks.addLabeled('原本行號名');
      await vscode.commands.executeCommand('functionBookmarks.renameBookmark', undefined, '新行號名');
      assert.strictEqual(api.store.bookmarksFor(views).find((b) => b.line === 5)?.label, '新行號名');
      assert.strictEqual(api.store.get(views, { path: 'index', kind: 'function' })?.alias, '首頁處理函式');

      await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.renameBookmark'), '行號書籤改名取消');
      assert.strictEqual(api.store.bookmarksFor(views).find((b) => b.line === 5)?.label, '新行號名');
    });

    it('editBookmarkTags 與 removeBookmark：游標行號書籤優先、其次函式書籤；無書籤與取消不更動', async () => {
      const views = workspaceFile('app', 'views.py');
      await openAt(views, 1, api);
      await vscode.commands.executeCommand('functionBookmarks.editBookmarkTags', undefined, '#ghost');
      await vscode.commands.executeCommand('functionBookmarks.removeBookmark');
      assert.strictEqual(api.store.bookmarksFor(views).length, 0);
      assert.strictEqual(api.store.allFavorites().length, 0);

      await openAt(views, 4, api);
      await vscode.commands.executeCommand('functionBookmarks.editBookmarkTags', undefined, '#nope');
      assert.strictEqual(api.store.allFavorites().length, 0);

      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.favorites.refresh();
      await openAt(views, 5, api);
      await vscode.commands.executeCommand('functionBookmarks.editBookmarkTags', undefined, '#web #entry');
      assert.deepStrictEqual(api.store.get(views, { path: 'index', kind: 'function' })?.tags, ['web', 'entry']);

      await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.editBookmarkTags'), '編輯標籤取消');
      assert.deepStrictEqual(api.store.get(views, { path: 'index', kind: 'function' })?.tags, ['web', 'entry']);

      await api.bookmarks.addLabeled('行號書籤');
      await vscode.commands.executeCommand('functionBookmarks.editBookmarkTags', undefined, '#line-tag');
      assert.deepStrictEqual(api.store.bookmarksFor(views).find((b) => b.line === 5)?.tags, ['line-tag']);
      assert.deepStrictEqual(api.store.get(views, { path: 'index', kind: 'function' })?.tags, ['web', 'entry']);

      await vscode.commands.executeCommand('functionBookmarks.removeBookmark');
      assert.strictEqual(api.store.bookmarksFor(views).length, 0);
      assert.strictEqual(api.store.get(views, { path: 'index', kind: 'function' })?.favorite, true);

      await vscode.commands.executeCommand('functionBookmarks.removeBookmark');
      assert.strictEqual(api.store.get(views, { path: 'index', kind: 'function' })?.favorite, undefined);
      assert.strictEqual(await api.updateCursorBookmarkContext(), false);
    });

    it('renameDisplayName（側邊欄 F2）：非書籤節點或未加書籤的函式節點不退回改編輯器游標處函式（CR-10）', async () => {
      const views = workspaceFile('app', 'views.py');
      await openAt(views, 4, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.favorites.refresh();

      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const fileNode: FileNode = {
        type: 'file',
        folder: folder(),
        uri: views,
        rel: 'app/views.py',
        parent: api.provider.sections.project,
      };
      await vscode.commands.executeCommand('functionBookmarks.renameDisplayName', api.provider.sections.bookmarks, '誤改1');
      await vscode.commands.executeCommand('functionBookmarks.renameDisplayName', groups[0], '誤改2');
      await vscode.commands.executeCommand('functionBookmarks.renameDisplayName', fileNode, '誤改3');
      assert.strictEqual(api.store.get(views, { path: 'index', kind: 'function' })?.alias, undefined);

      const unbookmarkedSym = api.provider.currentSymbolNodes.find((n) => n.symbol.name !== 'index');
      assert.ok(unbookmarkedSym);
      await vscode.commands.executeCommand('functionBookmarks.renameDisplayName', unbookmarkedSym, '誤改4');
      assert.strictEqual(api.store.get(views, unbookmarkedSym.symbol)?.alias, undefined);

      const bookmarkedSym = api.provider.currentSymbolNodes.find((n) => n.symbol.name === 'index') as SymbolNode;
      assert.ok(bookmarkedSym);
      await vscode.commands.executeCommand('functionBookmarks.renameDisplayName', bookmarkedSym, '正常改名');
      assert.strictEqual(api.store.get(views, { path: 'index', kind: 'function' })?.alias, '正常改名');
    });

    it('moveBookmarkToCursor 收到非行號書籤節點（FavoriteNode）時安全略過（CR-04）', async () => {
      const views = workspaceFile('app', 'views.py');
      await openAt(views, 1, api);
      await api.bookmarks.addLabeled('固定行號書籤');
      await openAt(views, 4, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.favorites.refresh();
      const fav = api.favorites.all[0];
      assert.ok(fav);
      const fakeFavNode: FavoriteNode = { type: 'favorite', fav, parent: api.provider.sections.bookmarks };

      await openAt(views, 5, api);
      await vscode.commands.executeCommand('functionBookmarks.moveBookmarkToCursor', fakeFavNode);
      assert.strictEqual(api.store.bookmarksFor(views)[0].line, 1, '原本的行號書籤不應被移動');
    });

    it('addLabeledBookmark 按 Esc 取消不建書籤、不佔自動編號；再做一次正常建立（CR-19）', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      const views = workspaceFile('app', 'views.py');
      try {
        await cfg.update('bookmarks.autoNumber', true, vscode.ConfigurationTarget.Workspace);
        await openAt(views, 1, api);
        await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.addLabeledBookmark'), '一般行 addLabeledBookmark 取消');
        assert.strictEqual(api.store.bookmarksFor(views).length, 0, '取消不應建立行號書籤');
        assert.strictEqual(api.store.numbered().size, 0, '取消不應消耗自動編號');

        await openAt(views, 4, api);
        await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.addLabeledBookmark'), '函式行 addLabeledBookmark 取消');
        assert.strictEqual(api.store.allFavorites().length, 0, '函式名稱行取消不應建立函式書籤');

        // 取消後再做一次正常建立
        await openAt(views, 1, api);
        await api.bookmarks.addLabeled('再次建立成功');
        const bms = api.store.bookmarksFor(views);
        assert.strictEqual(bms.length, 1);
        assert.strictEqual(bms[0].label, '再次建立成功');
        assert.strictEqual(bms[0].number, 1);
      } finally {
        await cfg.update('bookmarks.autoNumber', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });

    it('標籤提示共用所有書籤標籤；函式加標籤時順便新增書籤套用 autoNumber', async () => {
      const views = workspaceFile('app', 'views.py');
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, { id: newBookmarkId(), file: 'app/views.py', line: 0, tags: ['lineTag', 'shared'] });
        next = setFavorite(next, { file: 'app/views.py', path: 'index', kind: 'function' }, true, 0);
        return setTags(next, { file: 'app/views.py', path: 'index', kind: 'function' }, ['fnTag', 'shared']);
      });
      assert.deepStrictEqual(api.store.allTags(), ['fnTag', 'lineTag', 'shared']);
      const prompt = tagsPrompt(api.store);
      assert.ok(prompt.includes('#fnTag') && prompt.includes('#lineTag') && prompt.includes('#shared'), prompt);

      await resetWorkspace(api);
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      await cfg.update('bookmarks.autoNumber', true, vscode.ConfigurationTarget.Workspace);
      try {
        await open(views, api);
        const indexNode = findNode(api.provider.currentSymbolNodes, 'index')!;
        await api.commands.editTags(indexNode, '#core');
        const mark = api.store.get(views, indexNode.symbol);
        assert.strictEqual(mark?.favorite, true);
        assert.deepStrictEqual(mark?.tags, ['core']);
        assert.strictEqual(mark?.number, 1, '應套用 autoNumber 自動配 1 號');

        await api.commands.editTags(indexNode, '#core #auth');
        assert.strictEqual(api.store.get(views, indexNode.symbol)?.number, 1, '已為書籤改標籤不重新配號');
      } finally {
        await cfg.update('bookmarks.autoNumber', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });
  });

  describe('數字快速書籤、依編號導覽、顏色、行尾名稱、隱藏圖示與狀態列', () => {
    const fileN = () => workspaceFile('app', 'tmp_m7.py');
    const relN = 'app/tmp_m7.py';
    const LINES = ['import os', 'x = 1', '', 'def helper(a):', '    return a + 1', '', 'y = 2', 'z = 3'];

    before(async () => {
      await fsp.writeFile(fileN().fsPath, LINES.join('\n') + '\n');
    });

    after(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.autoNumber', undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.showLabelAtLineEnd', undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('functionBookmarks.showBookmarkIcons');
      await fsp.rm(fileN().fsPath, { force: true });
    });

    const lineBm = (line: number) => api.store.bookmarksFor(fileN()).find((b) => b.line === line);
    const helperMark = () => api.store.get(fileN(), { path: 'helper', kind: 'function' });
    async function children(): Promise<TreeNode[]> {
      await api.favorites.refresh();
      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const group = groups.find((g) => g.rel === relN);
      return group ? api.provider.getChildren(group) : [];
    }
    const iconColor = (n: TreeNode) =>
      ((api.provider.getTreeItem(n).iconPath as vscode.ThemeIcon).color as unknown as { id: string } | undefined)?.id;

    it('數字書籤設定、取消移除號碼，與自動編號 autoNumber', async () => {
      await openAt(fileN(), 1, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 3 });
      assert.strictEqual(lineBm(1)?.number, 3);
      const kids = await children();
      assert.ok(kids.some((k) => k.type === 'bookmark' && labelOf(api.provider.getTreeItem(k)) === '③ x = 1'));
      await api.gutter.update();
      assert.strictEqual(api.gutter.iconAt(fileN(), 1), 'bookmark|teal|3');

      // 再按一次同一個號碼：拿掉號碼，書籤保留
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 3 });
      assert.ok(lineBm(1));
      assert.strictEqual(lineBm(1)?.number, undefined);

      // autoNumber 開啟時新增自動配號，指定號碼時照指定號碼
      await resetWorkspace(api);
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      await cfg.update('bookmarks.autoNumber', true, vscode.ConfigurationTarget.Workspace);
      try {
        await openAt(fileN(), 1, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
        await openAt(fileN(), 3, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
        assert.strictEqual(lineBm(1)?.number, 1);
        assert.strictEqual(helperMark()?.number, 2);
        await openAt(fileN(), 7, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 3 });
        assert.strictEqual(lineBm(7)?.number, 3);
      } finally {
        await cfg.update('bookmarks.autoNumber', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });

    it('無書籤行取消「設定號碼／顏色」（含 autoNumber）不留孤兒書籤；號碼已佔用時取消與確認皆正確（CR-02）', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      try {
        await cfg.update('bookmarks.autoNumber', true, vscode.ConfigurationTarget.Workspace);
        await openAt(fileN(), 1, api);

        await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.setBookmarkNumber'), 'setBookmarkNumber 取消');
        await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.setBookmarkColor'), 'setBookmarkColor 取消');
        assert.strictEqual(api.store.bookmarksFor(fileN()).length, 0, '取消設定號碼／顏色不應留下多餘書籤');
        assert.strictEqual(api.store.numbered().size, 0, '取消時不應消耗自動編號');

        await openAt(fileN(), 3, api); // def helper
        await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.setBookmarkNumber'), '函式行 setBookmarkNumber 取消');
        await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.setBookmarkColor'), '函式行 setBookmarkColor 取消');
        assert.strictEqual(api.store.allFavorites().length, 0, '函式名稱行取消不應留下函式書籤');

        // 行號區右鍵（editor/lineNumber/context）第二參數會附帶 { preserveFocus: false }：應照常開選單、不寫入損壞物件或建孤兒書籤（BUG-01）
        const lineCtx = { lineNumber: 2, uri: fileN() };
        const extra = { preserveFocus: false };
        await runAndCancelQuickOpen(
          () => vscode.commands.executeCommand('functionBookmarks.setBookmarkNumber', lineCtx, extra),
          '行號右鍵 setBookmarkNumber 帶 preserveFocus 應開啟選單',
        );
        await runAndCancelQuickOpen(
          () => vscode.commands.executeCommand('functionBookmarks.setBookmarkColor', lineCtx, extra),
          '行號右鍵 setBookmarkColor 帶 preserveFocus 應開啟選單',
        );
        assert.strictEqual(api.store.bookmarksFor(fileN()).length, 0, '行號右鍵取消不應建立損壞書籤');
        assert.strictEqual(api.store.numbered().size, 0);

        // 取消後再做一次並確認：正常建立並拿到 1 號
        await openAt(fileN(), 1, api);
        await vscode.commands.executeCommand('functionBookmarks.setBookmarkColor', undefined, 'red');
        assert.strictEqual(lineBm(1)?.color, 'red');
        assert.strictEqual(lineBm(1)?.number, 1, '先前取消未佔用 1 號');
      } finally {
        await cfg.update('bookmarks.autoNumber', undefined, vscode.ConfigurationTarget.Workspace);
      }

      // 號碼已被佔用時：在一般行與函式行取消都不建孤兒書籤，確認後轉移號碼
      await openAt(fileN(), 6, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 1 }, false);
      assert.strictEqual(lineBm(6), undefined, 'toggleNumber 取消不建孤兒書籤');
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkNumber', undefined, 1, false);
      assert.strictEqual(lineBm(6), undefined, 'setBookmarkNumber 取消不建孤兒書籤');
      assert.strictEqual(lineBm(1)?.number, 1);

      await openAt(fileN(), 3, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 1 }, false);
      assert.strictEqual(helperMark(), undefined, '函式行取消不建孤兒函式書籤');
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 1 }, true);
      assert.strictEqual(helperMark()?.favorite, true);
      assert.strictEqual(helperMark()?.number, 1);
      assert.strictEqual(lineBm(1)?.number, undefined, '同一個號碼只留一個');
      const kids = await children();
      assert.ok(kids.some((k) => k.type === 'favorite' && labelOf(api.provider.getTreeItem(k)) === '① helper'));
      await api.gutter.update();
      assert.strictEqual(api.gutter.iconAt(fileN(), 3), 'favorite|teal|1');
    });

    it('跳到數字書籤（行號／函式／無號碼／QuickPick 取消）與 setBookmarkNumber', async () => {
      await openAt(fileN(), 6, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 5 });
      await openAt(fileN(), 3, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 1 });
      await openAt(fileN(), 0, api);

      // 無參數開啟 QuickPick 並按 Esc 取消：游標停在原位
      await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.goToNumberedBookmark'), 'goToNumberedBookmark 取消');
      assert.strictEqual(vscode.window.activeTextEditor!.selection.active.line, 0, '取消 QuickPick 不應跳轉');

      const r = await vscode.commands.executeCommand<{ line: number }>('functionBookmarks.goToNumberedBookmark', { number: 5 });
      assert.strictEqual(r?.line, 6);
      assert.strictEqual(vscode.window.activeTextEditor!.selection.active.line, 6);
      await vscode.commands.executeCommand('functionBookmarks.goToNumberedBookmark', { number: 1 });
      assert.strictEqual(vscode.window.activeTextEditor!.selection.active.line, 3, '函式書籤跳到函式名稱');
      assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.goToNumberedBookmark', { number: 9 }), undefined);

      const node = (await children()).find((k) => k.type === 'bookmark') as BookmarkNode;
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkNumber', node, null);
      assert.strictEqual(lineBm(6)?.number, undefined);
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkNumber', node, 'next');
      assert.strictEqual(lineBm(6)?.number, 2, '下一個空號（1 已被使用）');

      await openAt(fileN(), 3, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      assert.strictEqual(helperMark()?.number, undefined);
      assert.ok(!api.store.numbered().has(1));
    });

    it('tourNext／tourPrevious 依 1→9 循環跨檔案跳轉並更新狀態列', async () => {
      assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.tourNext'), undefined);

      await api.store.update(folder(), (d) => {
        let next = setFavorite(d, { file: 'app/views.py', path: 'index', kind: 'function' }, true, 0);
        next = setNote(next, { file: 'app/views.py', path: 'index', kind: 'function' }, '導覽備註內容', 0);
        next = { ...next, symbols: next.symbols.map((m) => ({ ...m, number: 2 })) };
        return addBookmark(next, { id: newBookmarkId(), file: 'docs/guide.md', line: 2, label: '第二站', number: 5 });
      });
      await api.favorites.refresh();

      const step1 = await vscode.commands.executeCommand<{ number: number; index: number; total: number; hasNote: boolean; uri: vscode.Uri }>(
        'functionBookmarks.tourNext',
      );
      assert.deepStrictEqual([step1?.number, step1?.index, step1?.total, step1?.hasNote], [2, 1, 2, true]);
      assert.ok(api.extras.lastTourStatus?.includes('1/2'));

      const step2 = await vscode.commands.executeCommand<{ number: number; index: number; total: number; hasNote: boolean; uri: vscode.Uri }>(
        'functionBookmarks.tourNext',
      );
      assert.deepStrictEqual([step2?.number, step2?.index, step2?.total, step2?.hasNote], [5, 2, 2, false]);
      assert.ok(step2?.uri.path.endsWith('docs/guide.md'));
      assert.ok(api.extras.lastTourStatus?.includes('2/2'));

      const wrap = await vscode.commands.executeCommand<{ number: number; index: number }>('functionBookmarks.tourNext');
      assert.deepStrictEqual([wrap?.number, wrap?.index], [2, 1]);

      const prev = await vscode.commands.executeCommand<{ number: number; index: number }>('functionBookmarks.tourPrevious');
      assert.deepStrictEqual([prev?.number, prev?.index], [5, 2]);
    });

    it('檔案在磁碟被刪除時：goToNumber、導覽、側邊欄點擊與函式書籤不開分頁；跳到需確認書籤正常定位', async () => {
      const goneLine = workspaceFile('app', 'tmp_m7_gone_line.py');
      const goneFn = workspaceFile('app', 'tmp_m7_gone_fn.py');
      const keep = workspaceFile('app', 'tmp_m7_keep.py');
      await fsp.writeFile(goneLine.fsPath, 'a = 1\nb = 2\nc = 3\n');
      await fsp.writeFile(goneFn.fsPath, 'def vanished():\n    return 1\n');
      await fsp.writeFile(keep.fsPath, 'def stay():\n    return 2\nk = 3\n');

      const hasTabFor = (uri: vscode.Uri) =>
        vscode.window.tabGroups.all.some((g) =>
          g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString()),
        );

      try {
        // #1: fileN (存在) 行 1、#2: goneLine (將被刪除) 行 1、#3: goneFn (函式書籤，將被刪除)、#4: keep (存在) 行 2
        await openAt(fileN(), 1, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 1 });
        await openAt(goneLine, 1, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 2 });
        await openAt(goneFn, 0, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 3 });
        await openAt(keep, 2, api);
        await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 4 });
        await api.favorites.refresh();
        await api.store.flush();
        await api.external.idle();

        // 先記下側邊欄行號書籤與函式書籤的點擊指令（刪除前即產生，模擬畫面還沒重繪時點擊）
        const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
        const goneLineGroup = groups.find((g) => g.rel === 'app/tmp_m7_gone_line.py')!;
        const goneLineNode = (await api.provider.getChildren(goneLineGroup)).find((n) => n.type === 'bookmark') as BookmarkNode;
        const goneLineItem = api.provider.getTreeItem(goneLineNode);
        assert.strictEqual(goneLineItem.command?.command, 'functionBookmarks.openBookmark');

        const goneFnGroup = groups.find((g) => g.rel === 'app/tmp_m7_gone_fn.py')!;
        const goneFnNode = (await api.provider.getChildren(goneFnGroup)).find((n) => n.type === 'favorite') as FavoriteNode;

        // 關閉所有分頁後從磁碟刪掉兩個檔案（此時 VS Code 仍可能快取剛關掉的文件）
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await fsp.rm(goneLine.fsPath, { force: true });
        await fsp.rm(goneFn.fsPath, { force: true });

        // 停在 fileN 第 6 行當基準
        await openAt(fileN(), 6, api);
        const stayUri = fileN().toString();

        // 1. goToNumber 指向已刪除的行號書籤與函式書籤：都不開分頁、目前編輯器與游標不變
        assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.goToNumberedBookmark', { number: 2 }), undefined);
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), stayUri);
        assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 6);
        assert.strictEqual(hasTabFor(goneLine), false, 'goToNumber 不應為已刪行號書籤開分頁');

        assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.goToNumberedBookmark', { number: 3 }), undefined);
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), stayUri);
        assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 6);
        assert.strictEqual(hasTabFor(goneFn), false, 'goToNumber 不應為已刪函式書籤開分頁');

        // 2. 側邊欄點擊新指令（行號書籤）與 openFavorite（函式書籤）：對已刪除檔案都不開分頁
        const openLineOk = await vscode.commands.executeCommand<boolean>(goneLineItem.command!.command, ...goneLineItem.command!.arguments!);
        assert.strictEqual(openLineOk, false);
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), stayUri);
        assert.strictEqual(hasTabFor(goneLine), false, '側邊欄點擊已刪行號書籤不應開分頁');

        const openFnOk = await api.commands.openFavorite(goneFnNode.fav);
        assert.strictEqual(openFnOk, false);
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), stayUri);
        assert.strictEqual(hasTabFor(goneFn), false, 'openFavorite 對已刪檔案不應開分頁');

        // 3. 導覽：從 #1 往前跳會略過 #2（行號）與 #3（函式），直接到 #4（index 4/4）；往回也略過跳回 #1（index 1/4）
        await openAt(fileN(), 1, api);
        const nextStep = await vscode.commands.executeCommand<{ number: number; index: number; total: number; uri: vscode.Uri; line: number }>(
          'functionBookmarks.tourNext',
        );
        assert.deepStrictEqual([nextStep?.number, nextStep?.index, nextStep?.total, nextStep?.line], [4, 4, 4, 2]);
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), keep.toString());
        assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 2);
        assert.ok(api.extras.lastTourStatus?.includes('4/4'), api.extras.lastTourStatus);
        assert.strictEqual(hasTabFor(goneLine), false);
        assert.strictEqual(hasTabFor(goneFn), false);

        const prevStep = await vscode.commands.executeCommand<{ number: number; index: number; total: number; line: number }>(
          'functionBookmarks.tourPrevious',
        );
        assert.deepStrictEqual([prevStep?.number, prevStep?.index, prevStep?.total, prevStep?.line], [1, 1, 4, 1]);
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), fileN().toString());
        assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 1);
        assert.ok(api.extras.lastTourStatus?.includes('1/4'), api.extras.lastTourStatus);

        // 4. 跳到 lost（需確認）書籤時不會丟錯，且游標停在記得的那一行
        const stale = makeAnchor(['old_1 = 1', 'old_2 = 2', 'old_3 = 3'], 1);
        const lostId = newBookmarkId();
        await api.store.update(folder(), (d) =>
          addBookmark(d, {
            id: lostId,
            file: relN,
            line: 7,
            number: 8,
            label: '失聯書籤',
            status: 'lost',
            anchor: stale,
          }),
        );
        await openAt(keep, 0, api);
        const lostJump = await vscode.commands.executeCommand<{ uri: vscode.Uri; line: number }>('functionBookmarks.goToNumberedBookmark', {
          number: 8,
        });
        assert.strictEqual(lostJump?.line, 7);
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), fileN().toString());
        assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 7);

        // 透過側邊欄點擊新指令跳到 lost 書籤也同樣正常定位
        await openAt(keep, 0, api);
        const lostOpenOk = await vscode.commands.executeCommand<boolean>('functionBookmarks.openBookmark', {
          uri: fileN().toString(),
          bookmark: lostId,
        });
        assert.strictEqual(lostOpenOk, true);
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), fileN().toString());
        assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 7);

        // 5. 所有編號書籤的檔案都不存在時：導覽顯示一次提示就停止，回傳 undefined 且不開分頁
        await api.bookmarks.clearAll(true);
        await api.store.update(folder(), (d) =>
          addBookmark(d, { id: newBookmarkId(), file: 'app/tmp_m7_gone_line.py', line: 1, number: 1 }),
        );
        await openAt(keep, 0, api);
        assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.tourNext'), undefined);
        assert.strictEqual(api.extras.lastTourStatus, undefined);
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), keep.toString());
        assert.strictEqual(hasTabFor(goneLine), false);
      } finally {
        await api.bookmarks.clearAll(true);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        for (const u of [goneLine, goneFn, keep]) {
          await fsp.rm(u.fsPath, { force: true });
        }
      }
    });

    it('書籤顏色、標籤顏色（書籤優先於標籤）與 setTagColor 按 Esc 取消不變更', async () => {
      await openAt(fileN(), 1, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await openAt(fileN(), 6, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      let kids = await children();
      const first = kids.find((k) => k.type === 'bookmark' && (k as BookmarkNode).entry.bookmark.line === 1) as BookmarkNode;
      const second = kids.find((k) => k.type === 'bookmark' && (k as BookmarkNode).entry.bookmark.line === 6) as BookmarkNode;
      await api.bookmarks.editTags(first, '#todo');
      await api.bookmarks.editTags(second, '#todo');

      // setTagColor 開啟 QuickPick 按 Esc 取消（選標籤步驟與選顏色步驟）不改動顏色
      await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.setTagColor'), 'setTagColor 選標籤取消');
      await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.setTagColor', 'todo'), 'setTagColor 選顏色取消');
      assert.strictEqual(api.store.tagColors().get('todo'), undefined);

      await vscode.commands.executeCommand('functionBookmarks.setTagColor', 'todo', 'green');
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkColor', second, 'red');
      kids = await children();
      const byLine = (l: number) => kids.find((k) => k.type === 'bookmark' && (k as BookmarkNode).entry.bookmark.line === l)!;
      assert.strictEqual(iconColor(byLine(1)), 'charts.green', '用標籤的顏色');
      assert.strictEqual(iconColor(byLine(6)), 'charts.red', '書籤自己的顏色優先');
      await api.gutter.update();
      assert.strictEqual(api.gutter.iconAt(fileN(), 1), 'bookmark|green|');
      assert.strictEqual(api.gutter.iconAt(fileN(), 6), 'bookmark|red|');
      assert.ok((await readStoreFile())?.includes('"tagColors"'));

      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByTag');
      const tags = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const todo = tags.find((t) => t.key === 'todo')!;
      assert.strictEqual(api.provider.getTreeItem(todo).contextValue, 'fbBmTag');
      assert.strictEqual(iconColor(todo), 'charts.green');
      // 標題列（…）收到選取中的標籤列：不直接改顏色，先問標籤
      await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.setTagColor', todo, [todo]), '標題列設定標籤顏色取消');
      assert.strictEqual(api.store.tagColors().get('todo'), 'green');
      // 標籤列的行內按鈕與右鍵：直接設定該標籤
      await vscode.commands.executeCommand('functionBookmarks.setColorOfTag', todo, null);
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkColor', second, null);
      await api.gutter.update();
      assert.strictEqual(api.gutter.iconAt(fileN(), 1), 'bookmark|teal|', '清除後恢復預設');
      assert.strictEqual(api.gutter.iconAt(fileN(), 6), 'bookmark|teal|');
    });

    it('需確認的書籤在行號旁用灰色問號圖示並附說明，移到游標後恢復正常圖示', async () => {
      const stale = makeAnchor(['deleted_a = 1', 'deleted_b = 2', 'deleted_c = 3'], 1);
      await api.store.update(folder(), (d) => {
        const next = addBookmark(d, {
          id: newBookmarkId(),
          file: relN,
          line: 1,
          label: '待確認項目',
          color: 'red',
          tags: ['todo'],
          status: 'lost',
          anchor: stale,
        });
        return addBookmark(next, {
          id: newBookmarkId(),
          file: relN,
          line: 6,
          number: 2,
          status: 'lost',
          anchor: stale,
        });
      });
      await openAt(fileN(), 1, api);
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileN(), 'bookmark'), [1, 6]);
      assert.strictEqual(api.gutter.iconAt(fileN(), 1), 'lost|red|');
      assert.strictEqual(api.gutter.iconAt(fileN(), 6), 'lost|teal|2');
      assert.strictEqual(api.gutter.labelAt(fileN(), 6), '②');
      const hover1 = api.gutter.hoverAt(fileN(), 1);
      assert.ok(hover1?.startsWith('**待確認項目**') && hover1.includes('#todo') && hover1.includes('The bookmarked line could not be found'), hover1);
      assert.ok(api.gutter.hoverAt(fileN(), 6)?.includes('The bookmarked line could not be found'));

      const node = (await children()).find((k) => k.type === 'bookmark' && (k as BookmarkNode).entry.bookmark.line === 1) as BookmarkNode;
      await openAt(fileN(), 7, api);
      await vscode.commands.executeCommand('functionBookmarks.moveBookmarkToCursor', node);
      await api.gutter.update();
      assert.strictEqual(api.gutter.iconAt(fileN(), 7), 'bookmark|red|');
      assert.strictEqual(api.gutter.hoverAt(fileN(), 7), undefined);
    });

    it('行尾顯示名稱與號碼（可在設定關閉）；暫時隱藏全部圖示與狀態列狀態同步', async () => {
      await openAt(fileN(), 6, api);
      await api.bookmarks.addLabeled('第二個變數');
      await openAt(fileN(), 1, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 4 });
      await openAt(fileN(), 3, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.favorites.refresh();
      await api.gutter.update();
      api.statusBar.update();

      assert.strictEqual(api.gutter.labelAt(fileN(), 6), '第二個變數');
      assert.strictEqual(api.gutter.labelAt(fileN(), 1), '④');
      assert.strictEqual(api.statusBar.text, '$(bookmark) 3');

      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      await cfg.update('bookmarks.showLabelAtLineEnd', false, vscode.ConfigurationTarget.Workspace);
      await api.gutter.update();
      assert.strictEqual(api.gutter.labelAt(fileN(), 6), undefined);
      await cfg.update('bookmarks.showLabelAtLineEnd', undefined, vscode.ConfigurationTarget.Workspace);

      await vscode.commands.executeCommand('functionBookmarks.hideBookmarkIcons');
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileN(), 'bookmark'), []);
      assert.deepStrictEqual(api.gutter.linesFor(fileN(), 'favorite'), []);
      assert.ok(api.statusBar.text?.includes('$(eye-closed)'));
      assert.strictEqual(api.store.bookmarksFor(fileN()).length, 2, '隱藏圖示不影響書籤資料');

      await vscode.commands.executeCommand('functionBookmarks.showBookmarkIcons');
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileN(), 'bookmark'), [1, 6]);
      assert.deepStrictEqual(api.gutter.linesFor(fileN(), 'favorite'), [3]);

      await vscode.commands.executeCommand('functionBookmarks.filterBookmarkSources', ['someone']);
      api.statusBar.update();
      assert.ok(api.statusBar.text?.includes('$(filter)'));
      await vscode.commands.executeCommand('functionBookmarks.filterBookmarkSources', []);
      api.statusBar.update();
      assert.strictEqual(api.statusBar.text, '$(bookmark) 3');
    });
  });

  describe('編輯器預設快捷鍵衝突驗證', () => {
    it('VS Code／Cursor 內建預設快捷鍵不包含任何非本套件的 alt+shift+b 綁定', async () => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('vscode://defaultsettings/keybindings.json'));
      const text = doc.getText();
      assert.ok(text.length > 1000, '應成功讀取內建預設快捷鍵內容');
      const entryRe = /\{\s*"key"\s*:\s*"([^"]+)"\s*,\s*"command"\s*:\s*"([^"]+)"/g;
      const conflicts: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = entryRe.exec(text)) !== null) {
        const key = m[1].toLowerCase().trim();
        const cmd = m[2];
        if (cmd.startsWith('functionBookmarks.') || cmd.startsWith('-')) {
          continue;
        }
        const firstPart = key.split(/\s+/)[0];
        const mods = firstPart.split('+').sort().join('+');
        if (mods === 'alt+b+shift') {
          conflicts.push(`${key} -> ${cmd}`);
        }
      }
      assert.deepStrictEqual(conflicts, [], `發現與內建預設快捷鍵衝突：${conflicts.join(', ')}`);
    });
  });
});
