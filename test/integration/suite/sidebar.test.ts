import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { makeAnchor, newBookmarkId } from '../../../src/bookmarks/model';
import { addBookmark, setAlias, setFavorite, setNote, setTags } from '../../../src/storage/marks';
import { toggleBookmarkKey } from '../../../src/util/shortcuts';
import { formatLocalDateTime } from '../../../src/util/time';
import { buildSearchMarkItems, filterSearchMarkItems } from '../../../src/views/search';
import { BookmarkSearchBox } from '../../../src/views/searchBox';
import {
  AUTO_COLLAPSE_BOOKMARKS,
  AUTO_COLLAPSE_GROUPS,
  BmGroupNode,
  BookmarkNode,
  FavoriteNode,
  searchFields,
  TreeNode,
} from '../../../src/views/tree';
import {
  activateExtension,
  cleanupWorkspaceStore,
  findNode,
  folder,
  labelOf,
  names,
  open,
  openAt,
  readStoreFile,
  resetWorkspace,
  runAndCancelQuickOpen,
  waitFor,
  workspaceFile,
} from './helpers';

describe('側邊欄：檢視狀態、游標跟隨、搜尋列、快速搜尋與個別檔案排序', () => {
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

  describe('側邊欄標題、空狀態、篩選模式、收合記憶與游標跟隨', () => {
    it('空書籤區提示使用依平台的快捷鍵且簡短不截斷；單資料夾分組不顯示多餘資料夾名稱；標題與描述同步', async () => {
      const item = api.provider.getTreeItem(api.provider.sections.bookmarks);
      const desc = String(item.description);
      assert.ok(desc.includes(toggleBookmarkKey()), `應顯示 ${toggleBookmarkKey()}，實際：${desc}`);
      assert.ok(!desc.includes('Ctrl+Alt'));
      assert.ok(desc.length <= 24, `空狀態提示應精簡：${desc}`);
      assert.ok(String(item.tooltip).includes(toggleBookmarkKey()));

      const views = workspaceFile('app', 'views.py');
      await openAt(views, 1, api);
      await api.bookmarks.addLabeled('單資料夾測試');
      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const grpItem = api.provider.getTreeItem(groups[0]);
      assert.strictEqual(grpItem.description, 'app');
      assert.strictEqual(grpItem.tooltip, 'app/views.py');

      const initialTitle = api.treeView.title;
      try {
        api.store.setHiddenSources(['someone']);
        assert.ok(String(api.treeView.description).includes('filtered'));
        assert.strictEqual(api.treeView.title, api.treeView.description, '合併標題列應同步顯示篩選狀態');
      } finally {
        api.store.setHiddenSources([]);
      }
      assert.strictEqual(api.treeView.title, initialTitle);
    });

    it('只顯示書籤／顯示全部', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', findNode(api.provider.currentSymbolNodes, 'index'));
      await api.favorites.refresh();
      await vscode.commands.executeCommand('functionBookmarks.showBookmarksOnly');
      try {
        const roots = await api.provider.getChildren();
        assert.deepStrictEqual(roots.map((r) => (r.type === 'section' ? r.section : r.type)), ['search', 'bookmarks']);
      } finally {
        await vscode.commands.executeCommand('functionBookmarks.showAll');
      }
      const roots = await api.provider.getChildren();
      assert.deepStrictEqual(roots.map((r) => (r.type === 'section' ? r.section : r.type)), ['search', 'bookmarks', 'currentFile', 'project']);
    });

    it('切換檔案再回來維持函式收合狀態；焦點暫離編輯器不清空目前檔案；快速切換分頁以最後一次為準', async () => {
      const views = workspaceFile('app', 'views.py');
      const base = workspaceFile('templates', 'base.html');
      const editorA = await open(views, api);
      const cls = findNode(api.provider.currentSymbolNodes, 'ArticleView')!;
      assert.strictEqual(api.provider.getTreeItem(cls).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      api.provider.setExpanded(cls, false);
      const editorB = await open(base, api);
      await open(views, api);
      const again = findNode(api.provider.currentSymbolNodes, 'ArticleView')!;
      assert.notStrictEqual(again, cls);
      assert.strictEqual(api.provider.getTreeItem(again).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      api.provider.setExpanded(again, true);

      // 焦點暫離編輯器（refresh(undefined)）不清空目前檔案
      const before = api.provider.currentSymbolNodes;
      await api.provider.refresh(undefined);
      assert.strictEqual(api.provider.currentSymbolNodes, before);

      // 並發 refresh 兩個編輯器，最後顯示第二個
      await Promise.all([api.provider.refresh(editorA), api.provider.refresh(editorB)]);
      assert.strictEqual(api.provider.currentFile?.uri.toString(), editorB.document.uri.toString());
      await Promise.all([api.provider.refresh(editorB), api.provider.refresh(editorA)]);
      assert.strictEqual(api.provider.currentFile?.uri.toString(), editorA.document.uri.toString());
      assert.deepStrictEqual(names(api.provider.currentSymbolNodes), ['index', { ArticleView: ['get', 'post'] }]);
    });

    it('點函式書籤或行號書籤跳轉後選取留在書籤上；移到他處才跟隨；目前檔案收合時不展開', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.functionBookmarks');
      const views = workspaceFile('app', 'views.py');
      const editor = await open(views, api);
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', findNode(api.provider.currentSymbolNodes, 'index'));
      await api.favorites.refresh();
      const group = ((await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[])[0];
      const fav = ((await api.provider.getChildren(group)) as FavoriteNode[])[0];
      await api.treeView.reveal(fav, { select: true, focus: true });
      await waitFor(() => api.treeView.selection[0]?.type, (t) => t === 'favorite', '選取側邊欄函式書籤');
      await api.commands.openFavorite(fav.fav);
      await api.refreshNow();
      assert.strictEqual(api.followCursor(), undefined, '剛點函式書籤不應搶走選取');
      // 等過 150ms cursorTimer debounce 確認選取未被搶走
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(api.treeView.selection[0]?.type, 'favorite');

      const postLine = editor.document.getText().split('\n').findIndex((l) => l.includes('return "post"'));
      editor.selection = new vscode.Selection(postLine, 0, postLine, 0);
      assert.strictEqual(api.followCursor()?.symbol.path, 'ArticleView.post', '移到別的函式照常跟隨');

      // 行號書籤同理
      await openAt(views, postLine, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await waitFor(
        () => api.treeView.selection[0]?.type,
        (t) => t === 'symbol' || t === 'favorite',
        '等待前一次游標跟隨完成',
      );
      const bmGroup = ((await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[])[0];
      const bmNode = (await api.provider.getChildren(bmGroup)).find((n) => n.type === 'bookmark') as BookmarkNode;
      await api.treeView.reveal(bmNode, { select: true, focus: true });
      await waitFor(() => api.treeView.selection[0]?.type, (t) => t === 'bookmark', '選取側邊欄行號書籤');
      const item = api.provider.getTreeItem(bmNode);
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      await api.refreshNow();
      assert.strictEqual(api.followCursor(), undefined);
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(api.treeView.selection[0]?.type, 'bookmark');

      // 目前檔案收合時游標跟隨不展開它
      api.provider.setExpanded(api.provider.sections.currentFile, false);
      try {
        const getLine = editor.document.getText().split('\n').findIndex((l) => l.includes('return "get"'));
        editor.selection = new vscode.Selection(getLine, 0, getLine, 0);
        assert.strictEqual(api.followCursor(), undefined);
        assert.strictEqual(api.provider.isExpanded(api.provider.sections.currentFile), false);
      } finally {
        api.provider.setExpanded(api.provider.sections.currentFile, true);
      }
    });

    it('大量書籤預設收合分組（> 30 筆或 >= 6 個檔案），搜尋中與手動展開皆正常展開', async () => {
      // 超過書籤數門檻
      await api.store.update(folder(), (d) => {
        let next = d;
        for (let i = 0; i <= AUTO_COLLAPSE_BOOKMARKS; i++) {
          next = addBookmark(next, { id: `bulk-${i}`, file: 'langs/UserService.java', line: i, label: `書籤-${i}` });
        }
        return next;
      });
      await api.favorites.refresh();
      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      assert.strictEqual(api.provider.getTreeItem(groups[0]).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);

      api.searchBox.setQuery('書籤-5');
      const searchGroups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      assert.strictEqual(api.provider.getTreeItem(searchGroups[0]).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      api.searchBox.setQuery('');

      api.provider.setExpanded(groups[0], true);
      const again = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      assert.strictEqual(api.provider.getTreeItem(again[0]).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);

      // 超過檔案分組數門檻
      await resetWorkspace(api);
      const files = ['langs/server.go', 'langs/point.rs', 'langs/schema.sql', 'langs/deploy.sh', 'langs/Repo.kt', 'langs/invoice.rb'];
      assert.strictEqual(files.length, AUTO_COLLAPSE_GROUPS);
      await api.store.update(folder(), (d) => {
        let next = d;
        for (let i = 0; i < AUTO_COLLAPSE_GROUPS - 1; i++) {
          next = addBookmark(next, { id: `grp-${i}`, file: files[i], line: 0, label: `G${i}` });
        }
        return next;
      });
      let fileGroups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      assert.ok(fileGroups.every((g) => api.provider.getTreeItem(g).collapsibleState === vscode.TreeItemCollapsibleState.Expanded));

      await api.store.update(folder(), (d) => addBookmark(d, { id: 'grp-last', file: files[AUTO_COLLAPSE_GROUPS - 1], line: 0, label: 'GLast' }));
      fileGroups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      assert.strictEqual(fileGroups.length, AUTO_COLLAPSE_GROUPS);
      assert.ok(fileGroups.every((g) => api.provider.getTreeItem(g).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed));
    });

    it('依來源分組顯示「檔名:行號」，依檔案分組只顯示行號', async () => {
      const views = workspaceFile('app', 'views.py');
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, { id: newBookmarkId(), file: 'app/views.py', line: 5 });
        next = addBookmark(next, {
          id: newBookmarkId(),
          file: 'app/views.py',
          line: 6,
          source: { author: 'bob', importId: 'i1', originalId: newBookmarkId(), importedAt: '2026-01-01T00:00:00Z' },
        });
        return setFavorite(next, { file: 'app/views.py', path: 'index', kind: 'function' }, true, 4);
      });
      await api.favorites.refresh();
      await open(views, api);

      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksBySource');
      try {
        const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
        assert.deepStrictEqual(groups.map((g) => g.key), ['', 'bob']);
        const descOf = async (g: BmGroupNode) =>
          (await api.provider.getChildren(g)).map((n) => [n.type, String(api.provider.getTreeItem(n).description)] as const);
        const mine = await descOf(groups[0]);
        assert.ok(mine.find(([t]) => t === 'favorite')![1].includes('views.py:5'));
        assert.ok(mine.find(([t]) => t === 'bookmark')![1].includes('views.py:6'));
        assert.ok((await descOf(groups[1]))[0][1].includes('views.py:7'));

        await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
        const byFile = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
        for (const [, d] of await descOf(byFile[0])) {
          assert.ok(!d.includes('views.py'), `依檔案分組不重複檔名：${d}`);
        }
      } finally {
        await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
      }
    });
  });

  describe('常駐搜尋列與快速搜尋書籤', () => {
    const fileA = () => workspaceFile('app', 'tmp_find_a.py');
    const fileB = () => workspaceFile('app', 'tmp_find_b.py');
    const relA = 'app/tmp_find_a.py';
    const relB = 'app/tmp_find_b.py';
    const A_LINES = [
      'def alpha():',
      '    total = compute_price()',
      '    return total',
      '',
      'def beta():',
      '    return 2',
      '',
      'class Box:',
      '    def open(self):',
      '        return "lid"',
      '',
    ];
    const B_LINES = ['def gamma():', '    send_mail()', ''];
    const alphaKey = { file: relA, path: 'alpha', kind: 'function' as const };
    const source = (author: string) => ({ author, importId: 'i-search', originalId: newBookmarkId(), importedAt: '2026-01-01T00:00:00.000Z' });
    const sectionItem = () => api.provider.getTreeItem(api.provider.sections.bookmarks);
    const groupsOf = async () => (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
    type Row = { label: string; node: TreeNode; item: vscode.TreeItem; group: BmGroupNode };
    async function rows(): Promise<Row[]> {
      const out: Row[] = [];
      for (const group of await groupsOf()) {
        for (const node of await api.provider.getChildren(group)) {
          const item = api.provider.getTreeItem(node);
          out.push({ label: labelOf(item), node, item, group });
        }
      }
      return out;
    }
    const labels = async () => (await rows()).map((r) => r.label);
    const find = async (q: string) => {
      api.searchBox.setQuery(q);
      return labels();
    };
    const NAMES = { f: 'priceEntry', b1: '價格計算', b2: 'return 2', b3: 'return "lid"', b4: 'mail sender' };
    const ALL = [NAMES.f, NAMES.b1, NAMES.b2, NAMES.b3, NAMES.b4];

    async function setup(): Promise<void> {
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, {
          id: newBookmarkId(),
          file: relA,
          line: 1,
          label: NAMES.b1,
          tags: ['pricing', 'todo'],
          note: 'check rounding',
          anchor: makeAnchor(A_LINES, 1, 'alpha', 0),
        });
        next = addBookmark(next, { id: newBookmarkId(), file: relA, line: 5, tags: ['api'], anchor: makeAnchor(A_LINES, 5, 'beta', 4) });
        next = addBookmark(next, {
          id: newBookmarkId(),
          file: relA,
          line: 9,
          tags: ['todo'],
          anchor: makeAnchor(A_LINES, 9, 'Box.open', 8),
          source: source('bob'),
        });
        next = addBookmark(next, { id: newBookmarkId(), file: relB, line: 1, label: NAMES.b4, anchor: makeAnchor(B_LINES, 1, 'gamma', 0) });
        next = setFavorite(next, alphaKey, true, 0);
        next = setAlias(next, alphaKey, NAMES.f, 'alpha', 0);
        next = setTags(next, alphaKey, ['pricing']);
        return setNote(next, alphaKey, 'entry point', 0);
      });
      await api.favorites.refresh();
      await api.external.idle();
    }

    before(async () => {
      await fsp.writeFile(fileA().fsPath, A_LINES.join('\n'));
      await fsp.writeFile(fileB().fsPath, B_LINES.join('\n'));
    });

    afterEach(async () => {
      api.searchBox.close();
      api.searchBox.setQuery('');
      api.provider.setQuery('');
      api.store.setHiddenSources([]);
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
    });

    after(async () => {
      await fsp.rm(fileA().fsPath, { force: true });
      await fsp.rm(fileB().fsPath, { force: true });
    });

    it('setQuery 通知與空搜尋行為（含單獨 #／@ 不算搜尋、不加 :search）', async () => {
      await setup();
      assert.strictEqual(api.provider.query, '');
      assert.strictEqual(api.provider.searching, false);
      let fired = 0;
      const sub = api.provider.onDidChangeTreeData(() => fired++);
      try {
        assert.strictEqual(api.provider.setQuery(''), false);
        assert.strictEqual(fired, 0);
        assert.strictEqual(api.provider.setQuery('Login'), true);
        assert.strictEqual(fired, 1);
        assert.strictEqual(api.provider.query, 'Login');
        assert.strictEqual(api.provider.searching, true);
        assert.strictEqual(api.provider.setQuery('Login'), false);
        assert.strictEqual(fired, 1);
        for (const q of ['   ', '#', '@', '# @']) {
          assert.strictEqual(api.provider.setQuery(q), true);
          assert.strictEqual(api.provider.searching, false);
        }
        assert.deepStrictEqual(await labels(), ALL);
        assert.ok((await groupsOf()).every((g) => !String(api.provider.getTreeItem(g).id).endsWith(':search')));
        assert.strictEqual(String(sectionItem().description), '5');
        assert.strictEqual((sectionItem().iconPath as vscode.ThemeIcon).id, 'bookmark');
      } finally {
        sub.dispose();
      }
    });

    it('searchFields 正確抽取行號書籤與函式書籤各欄位，並串接搜尋列過濾文字／#標籤／@來源', async () => {
      await setup();
      const all = await rows();
      const fieldsOf = (name: string) => {
        const node = all.find((r) => r.label === name)!.node as BookmarkNode | FavoriteNode;
        return searchFields((node.type === 'bookmark' ? { kind: 'line', entry: node.entry } : { kind: 'symbol', fav: node.fav }) as never);
      };
      assert.deepStrictEqual(fieldsOf(NAMES.b1), {
        names: ['價格計算'],
        tags: ['pricing', 'todo'],
        author: '',
        file: relA,
        func: 'alpha',
        line: 'total = compute_price()',
        note: 'check rounding',
      });
      assert.deepStrictEqual(fieldsOf(NAMES.f), {
        names: ['priceEntry', 'alpha'],
        tags: ['pricing'],
        author: '',
        file: relA,
        func: 'alpha',
        note: 'entry point',
      });
      // 無 anchor 的他人函式書籤與無自訂名稱函式書籤
      const foreignFn = {
        kind: 'line',
        entry: { bookmark: { id: 'x', file: 'a/b.py', line: 3, symbol: { path: 'Outer.inner', kind: 'method' }, source: { author: 'amy' } } },
      };
      assert.deepStrictEqual(searchFields(foreignFn as never), {
        names: ['inner'],
        tags: [],
        author: 'amy',
        file: 'a/b.py',
        func: 'Outer.inner',
        line: undefined,
        note: undefined,
      });

      // 驗證搜尋列整合比對（細部詞法規則由 unit/filter.test.ts 完整覆蓋）
      assert.deepStrictEqual(await find('價格 rounding'), [NAMES.b1]);
      assert.deepStrictEqual(await find('find_b'), [NAMES.b4]);
      assert.deepStrictEqual(await find('box.open'), [NAMES.b3]);
      assert.deepStrictEqual(await find('#pricing #todo'), [NAMES.b1]);
      assert.deepStrictEqual(await find('@bob return'), [NAMES.b3]);
      assert.deepStrictEqual(await find('zzz_nothing'), []);
    });

    it('標題計數（{0} of {1} match、排除隱藏來源）、放大鏡圖示與 TreeItemLabel highlights 標亮', async () => {
      await setup();
      api.searchBox.setQuery('#todo');
      assert.strictEqual(String(sectionItem().description), '2 of 5 match');
      assert.strictEqual((sectionItem().iconPath as vscode.ThemeIcon).id, 'search');
      assert.strictEqual(sectionItem().collapsibleState, vscode.TreeItemCollapsibleState.Expanded);

      api.searchBox.setQuery('zzz_nothing');
      assert.strictEqual(String(sectionItem().description), '0 of 5 match');
      assert.deepStrictEqual(await groupsOf(), []);

      // 來源篩選隱藏的書籤不算在總數裡
      api.store.setHiddenSources(['bob']);
      assert.deepStrictEqual(await find('#todo'), [NAMES.b1]);
      assert.strictEqual(String(sectionItem().description), '1 of 4 match');
      assert.deepStrictEqual(await find('@bob'), []);
      assert.strictEqual(String(sectionItem().description), '0 of 4 match');
      api.store.setHiddenSources([]);

      // highlights 標亮
      const labelFor = async (q: string, name: string) => {
        api.searchBox.setQuery(q);
        return (await rows()).find((r) => r.label === name)!.item.label;
      };
      assert.deepStrictEqual(await labelFor('SEND', NAMES.b4), { label: 'mail sender', highlights: [[5, 9]] });
      assert.deepStrictEqual(await labelFor('price', NAMES.f), { label: 'priceEntry', highlights: [[0, 5]] });
      assert.deepStrictEqual(await labelFor('價格', NAMES.b1), { label: '價格計算', highlights: [[0, 2]] });
      assert.strictEqual(await labelFor('compute_price', NAMES.b1), NAMES.b1, '非名稱欄位符合不標亮');
      assert.strictEqual(await labelFor('#todo', NAMES.b1), NAMES.b1);
      api.searchBox.setQuery('');
      assert.strictEqual((await rows())[1].item.label, NAMES.b1);
    });

    it('三種分組（檔案／標籤／來源）搜尋中 :search id、分組名稱標亮與展開狀態恢復', async () => {
      await setup();
      // 1. 依檔案分組 + 收合恢復
      const idsBefore = (await groupsOf()).map((g) => String(api.provider.getTreeItem(g).id));
      const g0 = (await groupsOf())[0];
      api.provider.setExpanded(g0, false);
      try {
        assert.strictEqual(api.provider.getTreeItem(g0).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        api.searchBox.setQuery('find_b');
        const byFile = await groupsOf();
        assert.deepStrictEqual(byFile.map((g) => g.rel), [relB]);
        assert.strictEqual(api.provider.getTreeItem(byFile[0]).id, `${idsBefore[1]}:search`);
        assert.deepStrictEqual(api.provider.getTreeItem(byFile[0]).label, { label: 'tmp_find_b.py', highlights: [[4, 10]] });
        api.searchBox.setQuery('return');
        assert.strictEqual(api.provider.getTreeItem((await groupsOf())[0]).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
        api.searchBox.setQuery('');
        assert.strictEqual(api.provider.getTreeItem((await groupsOf())[0]).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        assert.deepStrictEqual((await groupsOf()).map((g) => String(api.provider.getTreeItem(g).id)), idsBefore);
      } finally {
        api.provider.setExpanded(g0, true);
      }

      // 2. 依標籤分組
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByTag');
      const keys = async () => (await groupsOf()).map((g) => [g.key, g.items.length] as const);
      assert.deepStrictEqual(await keys(), [['api', 1], ['pricing', 2], ['todo', 2], ['', 1]]);
      api.searchBox.setQuery('#pricing #todo');
      assert.deepStrictEqual(await keys(), [['pricing', 1], ['todo', 1]]);
      assert.strictEqual(String(sectionItem().description), '1 of 5 match', '同書籤在多標籤分組只計一次');
      api.searchBox.setQuery('#pric');
      const tagItem = api.provider.getTreeItem((await groupsOf())[0]);
      assert.strictEqual(tagItem.id, 'bmTag:pricing:search');
      assert.deepStrictEqual(tagItem.label, { label: '#pricing', highlights: [[1, 5]] });

      // 3. 依來源分組
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksBySource');
      api.searchBox.setQuery('@bo');
      const srcItem = api.provider.getTreeItem((await groupsOf())[0]);
      assert.deepStrictEqual(srcItem.label, { label: 'bob', highlights: [[0, 2]] });
      assert.strictEqual(srcItem.id, 'bmSource:bob:search');
      api.searchBox.setQuery('');
      assert.strictEqual(api.provider.getTreeItem((await groupsOf())[1]).id, 'bmSource:bob');
    });

    it('firstMatch 與三種分組列表第一列完全一致，沒結果時為 undefined', async () => {
      await setup();
      for (const group of ['groupBookmarksByFile', 'groupBookmarksByTag', 'groupBookmarksBySource']) {
        await vscode.commands.executeCommand(`functionBookmarks.${group}`);
        for (const q of ['', 'tmp_find', 'return', '#todo', '@bob', 'find_b', 'zzz_nothing']) {
          api.searchBox.setQuery(q);
          const all = await rows();
          const first = api.provider.firstMatch();
          assert.strictEqual(first ? labelOf(api.provider.getTreeItem(first)) : undefined, all[0]?.label, `${group}「${q}」`);
        }
      }
      api.searchBox.setQuery('tmp_find');
      assert.strictEqual(api.provider.firstMatch()?.type, 'favorite');
      api.searchBox.setQuery('#todo');
      assert.strictEqual(api.provider.firstMatch()?.type, 'bookmark');
    });

    it('搜尋同步、clearSearch（三種分組恢復與冪等）、focusSearch、Esc、↓ 與搜尋列節點', async () => {
      await setup();
      // 清單第一列搜尋節點
      const roots = await api.provider.getChildren();
      assert.strictEqual(roots[0].type, 'search');
      let sItem = api.provider.getTreeItem(api.provider.searchNode);
      assert.strictEqual(sItem.description, 'Search bookmarks…');
      assert.strictEqual(sItem.contextValue, 'fbSearch');
      assert.strictEqual(sItem.command?.command, 'functionBookmarks.focusSearch');

      // 三種分組下 clearSearch 皆完整恢復
      const snapshot = async () => {
        const out: unknown[] = [];
        for (const g of await groupsOf()) {
          const gi = api.provider.getTreeItem(g);
          const kids = await api.provider.getChildren(g);
          out.push([gi.id, labelOf(gi), String(gi.description), kids.map((k) => [api.provider.getTreeItem(k).id, labelOf(api.provider.getTreeItem(k))])]);
        }
        return { groups: out, section: String(sectionItem().description), icon: (sectionItem().iconPath as vscode.ThemeIcon).id };
      };
      for (const group of ['groupBookmarksByFile', 'groupBookmarksByTag', 'groupBookmarksBySource']) {
        await vscode.commands.executeCommand(`functionBookmarks.${group}`);
        const before = await snapshot();
        api.searchBox.setQuery('#todo');
        assert.notDeepStrictEqual(await snapshot(), before);
        await vscode.commands.executeCommand('functionBookmarks.clearSearch');
        assert.deepStrictEqual(await snapshot(), before);
      }
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
      // 無搜尋時再執行 clearSearch 不報錯
      await vscode.commands.executeCommand('functionBookmarks.clearSearch');
      assert.strictEqual(api.provider.query, '');

      // focusSearch 開啟輸入框保留字串，點別處關閉後字串保留
      api.searchBox.setQuery('keep');
      sItem = api.provider.getTreeItem(api.provider.searchNode);
      assert.strictEqual(sItem.label, 'keep');
      assert.strictEqual(sItem.contextValue, 'fbSearch:active');
      await vscode.commands.executeCommand('functionBookmarks.focusSearch');
      assert.strictEqual(api.searchBox.isOpen, true);
      api.searchBox.setQuery('keep2');
      assert.strictEqual(api.provider.query, 'keep2');
      api.searchBox.close();
      assert.strictEqual(api.searchBox.isOpen, false);
      assert.strictEqual(api.provider.query, 'keep2');

      // Esc（searchClearAndClose）清除並關閉，再開一次正常
      await vscode.commands.executeCommand('functionBookmarks.focusSearch');
      await vscode.commands.executeCommand('functionBookmarks.searchClearAndClose');
      assert.strictEqual(api.searchBox.isOpen, false);
      assert.strictEqual(api.provider.query, '');
      assert.deepStrictEqual(await labels(), ALL);

      // ↓（searchToList）關閉輸入框並選取第一個結果
      api.searchBox.setQuery('#todo');
      await vscode.commands.executeCommand('functionBookmarks.focusSearch');
      await vscode.commands.executeCommand('functionBookmarks.searchToList');
      assert.strictEqual(api.searchBox.isOpen, false);
      assert.strictEqual(api.provider.query, '#todo');
      const first = api.provider.firstMatch();
      assert.ok(first);
      const sel = api.treeView.selection[0];
      assert.ok(sel && (sel.type === 'bookmark' || sel.type === 'favorite'));
      assert.strictEqual(api.provider.getTreeItem(sel).id, api.provider.getTreeItem(first).id);
    });

    it('BookmarkSearchBox 持久化到 Memento（searchQuery），不重複通知', () => {
      const state = new Map<string, unknown>([['searchQuery', '#saved']]);
      const memento = {
        keys: () => [...state.keys()],
        get: (key: string, fallback?: unknown) => (state.has(key) ? state.get(key) : fallback),
        update: async (key: string, value: unknown) => {
          if (value === undefined) {
            state.delete(key);
          } else {
            state.set(key, value);
          }
        },
      } as unknown as vscode.Memento;
      const seen: string[] = [];
      const make = () => new BookmarkSearchBox(memento, { onQuery: (q) => seen.push(q), onEnter: () => undefined, onDown: () => undefined });
      const box = make();
      assert.strictEqual(box.query, '#saved');
      assert.deepStrictEqual(seen, []);
      box.setQuery('#saved');
      assert.deepStrictEqual(seen, []);
      box.setQuery('login view');
      assert.deepStrictEqual(seen, ['login view']);
      assert.strictEqual(state.get('searchQuery'), 'login view');
      box.setQuery('login view');
      assert.deepStrictEqual(seen, ['login view']);
      box.setQuery('');
      assert.strictEqual(make().query, '');
      box.dispose();
    });

    it('快速搜尋書籤（searchMarks）：顯示備註首行、可搜備註全文、標示 lost／notOnBranch，按 Esc 取消不跳轉（CR-19）', async () => {
      const views = workspaceFile('app', 'views.py');
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, {
          id: newBookmarkId(),
          file: 'app/views.py',
          line: 0,
          label: '入口點',
          note: '第一行摘要說明\n第二行關鍵字_UNIQUE_NOTE_BODY',
          status: 'lost',
        });
        next = addBookmark(next, { id: newBookmarkId(), file: 'app/views.py', line: 2, label: '別的分支書籤', status: 'notOnBranch' });
        next = setFavorite(next, { file: 'app/views.py', path: 'index', kind: 'function' }, true, 0);
        return setNote(next, { file: 'app/views.py', path: 'index', kind: 'function' }, '函式備註首行\n函式備註次行_FN_BODY', 0);
      });
      await api.favorites.refresh();

      const all = buildSearchMarkItems(api.store, api.favorites, { hideNotOnBranch: false });
      assert.strictEqual(all.length, 3);
      const lostItem = all.find((i) => i.label.includes('入口點'))!;
      const awayItem = all.find((i) => i.label.includes('別的分支書籤'))!;
      const fnItem = all.find((i) => i.label.includes('index'))!;
      assert.ok(lostItem.label.startsWith('$(warning) ') && lostItem.description?.includes('needs checking'));
      assert.ok(lostItem.detail?.includes('第一行摘要說明') && !lostItem.detail.includes('UNIQUE_NOTE_BODY'));
      assert.ok(awayItem.label.startsWith('$(git-branch) ') && awayItem.description?.includes('not on this branch'));
      assert.ok(fnItem.detail?.includes('函式備註首行'));

      assert.strictEqual(filterSearchMarkItems(all, 'UNIQUE_NOTE_BODY').length, 1);
      assert.strictEqual(filterSearchMarkItems(all, 'FN_BODY').length, 1);

      const hidden = buildSearchMarkItems(api.store, api.favorites, { hideNotOnBranch: true });
      assert.strictEqual(hidden.length, 2);
      assert.ok(!hidden.some((i) => i.label.includes('別的分支書籤')));

      // 開啟快速搜尋 QuickPick 並按 Esc 取消：游標與檔案維持原位，再開一次仍正常
      await openAt(views, 10, api);
      await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.searchBookmarks'), 'searchBookmarks 取消');
      assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 10);
      await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.searchBookmarks'), 'searchBookmarks 再次取消');
      assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 10);
    });
  });

  describe('書籤依檔案分組：個別檔案排序', () => {
    const fileA = () => workspaceFile('app', 'tmp_sort_a.py');
    const fileB = () => workspaceFile('app', 'tmp_sort_b.py');
    const fileRoot = () => workspaceFile('tmp_sort_root.py');
    const relA = 'app/tmp_sort_a.py';
    const relB = 'app/tmp_sort_b.py';
    const relRoot = 'tmp_sort_root.py';
    const A_LINES = [
      'def zeta():',
      '    item10 = 10',
      '    return item10',
      '',
      'def alpha():',
      '    item2 = 2',
      '    return item2',
      '',
      'def mid():',
      '    same = 1',
      '    same_two = 2',
      '',
    ];
    const B_LINES = ['def z_b():', '    pass', '', 'def a_b():', '    pass', ''];
    const ROOT_LINES = ['def root_z():', '    pass', '', 'def root_a():', '    pass', ''];

    const groupsOf = async (p = api.provider) => (await p.getChildren(p.sections.bookmarks)) as BmGroupNode[];
    const fileGroup = async (rel: string, p = api.provider) => {
      const g = (await groupsOf(p)).find((x) => x.rel === rel);
      assert.ok(g, `找不到檔案分組 ${rel}`);
      return g;
    };
    const childLabels = async (rel: string, p = api.provider) => {
      const g = await fileGroup(rel, p);
      return (await p.getChildren(g)).map((n) => labelOf(p.getTreeItem(n)));
    };

    async function setupFiles(): Promise<void> {
      await api.store.update(folder(), (d) => {
        let next = setFavorite(d, { file: relA, path: 'zeta', kind: 'function' }, true, 0);
        next = { ...next, symbols: next.symbols.map((m) => (m.path === 'zeta' ? { ...m, number: 1 } : m)) };
        next = addBookmark(next, { id: 'a-item10', file: relA, line: 1, label: 'item10', anchor: makeAnchor(A_LINES, 1, 'zeta', 0) });
        next = setFavorite(next, { file: relA, path: 'alpha', kind: 'function' }, true, 4);
        next = setAlias(next, { file: relA, path: 'alpha', kind: 'function' }, 'BetaFn', 'alpha', 4);
        next = addBookmark(next, { id: 'a-item2', file: relA, line: 5, label: 'item2', number: 2, anchor: makeAnchor(A_LINES, 5, 'alpha', 4) });
        next = addBookmark(next, { id: 'a-dup2', file: relA, line: 10, label: 'dup', anchor: makeAnchor(A_LINES, 10, 'mid', 8) });
        next = addBookmark(next, { id: 'a-dup1', file: relA, line: 9, label: 'dup', anchor: makeAnchor(A_LINES, 9, 'mid', 8) });
        next = addBookmark(next, { id: 'b-z', file: relB, line: 0, label: 'z_line', anchor: makeAnchor(B_LINES, 0) });
        next = addBookmark(next, { id: 'b-a', file: relB, line: 3, label: 'a_line', anchor: makeAnchor(B_LINES, 3) });
        next = addBookmark(next, { id: 'r-z', file: relRoot, line: 0, label: 'z_root', anchor: makeAnchor(ROOT_LINES, 0) });
        return addBookmark(next, { id: 'r-a', file: relRoot, line: 3, label: 'a_root', anchor: makeAnchor(ROOT_LINES, 3) });
      });
      await api.favorites.refresh();
      await api.external.idle();
    }

    before(async () => {
      await fsp.writeFile(fileA().fsPath, A_LINES.join('\n'));
      await fsp.writeFile(fileB().fsPath, B_LINES.join('\n'));
      await fsp.writeFile(fileRoot().fsPath, ROOT_LINES.join('\n'));
    });

    afterEach(async () => {
      api.searchBox.setQuery('');
      api.provider.setQuery('');
      await api.provider.setFileSort(fileA(), 'line');
      await api.provider.setFileSort(fileB(), 'line');
      await api.provider.setFileSort(fileRoot(), 'line');
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
    });

    after(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      for (const u of [fileA(), fileB(), fileRoot()]) {
        await fsp.rm(u.fsPath, { force: true });
      }
    });

    it('切換依標題／依行號：混排自然排序、忽略圈號、同名依行號、標示可見、不寫書籤檔且保留展開狀態', async () => {
      await setupFiles();
      const gA = await fileGroup(relA);
      const gB = await fileGroup(relB);
      api.provider.setExpanded(gA, true);
      api.provider.setExpanded(gB, false);
      try {
        const itemBefore = api.provider.getTreeItem(gA);
        assert.strictEqual(itemBefore.contextValue, 'fbBmFile');
        assert.deepStrictEqual(await childLabels(relA), ['① zeta', 'item10', 'BetaFn', '② item2', 'dup', 'dup']);

        await vscode.commands.executeCommand('functionBookmarks.sortFileBookmarksByTitle', gA);
        const gAAfter = await fileGroup(relA);
        const itemAfter = api.provider.getTreeItem(gAAfter);
        assert.strictEqual(itemAfter.contextValue, 'fbBmFile:byTitle');
        assert.strictEqual(itemAfter.description, 'app · by title');
        assert.strictEqual(itemAfter.id, itemBefore.id);
        assert.strictEqual(itemAfter.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
        assert.strictEqual(api.provider.getTreeItem(await fileGroup(relB)).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);

        const kids = await api.provider.getChildren(gAAfter);
        assert.deepStrictEqual(
          kids.map((n) => labelOf(api.provider.getTreeItem(n))),
          ['BetaFn', 'dup', 'dup', '② item2', 'item10', '① zeta'],
        );
        const dupLines = kids
          .filter((n): n is BookmarkNode => n.type === 'bookmark' && n.entry.bookmark.label === 'dup')
          .map((n) => n.entry.bookmark.line);
        assert.deepStrictEqual(dupLines, [9, 10]);

        // 根目錄檔案 description 直接顯示 by title
        await vscode.commands.executeCommand('functionBookmarks.sortFileBookmarksByTitle', await fileGroup(relRoot));
        assert.strictEqual(api.provider.getTreeItem(await fileGroup(relRoot)).description, 'by title');

        // 不寫進書籤檔
        await api.store.flush();
        const raw = await readStoreFile();
        assert.ok(raw && !raw.includes('byTitle') && !raw.includes('bookmarkFileSort'));

        // 重建 provider 後各檔獨立保留
        const reopened = api.recreateProvider();
        try {
          assert.strictEqual(reopened.fileSortOf(fileA()), 'title');
          assert.strictEqual(reopened.fileSortOf(fileB()), 'line');
          assert.deepStrictEqual(await childLabels(relA, reopened), ['BetaFn', 'dup', 'dup', '② item2', 'item10', '① zeta']);
          assert.deepStrictEqual(await childLabels(relB, reopened), ['z_line', 'a_line']);
        } finally {
          reopened.dispose();
        }

        // 搜尋列篩選時保留排序且 firstMatch 一致；搜尋中可切回依行號
        api.searchBox.setQuery('item');
        assert.deepStrictEqual(await childLabels(relA), ['② item2', 'item10']);
        assert.strictEqual(labelOf(api.provider.getTreeItem(api.provider.firstMatch()!)), '② item2');
        await vscode.commands.executeCommand('functionBookmarks.sortFileBookmarksByLine', await fileGroup(relA));
        assert.deepStrictEqual(await childLabels(relA), ['item10', '② item2']);
        api.searchBox.setQuery('');
        assert.strictEqual(api.provider.fileSortOf(fileA()), 'line');
      } finally {
        api.provider.setExpanded(gB, true);
      }
    });

    it('依標題排序不影響依標籤分組、目前檔案、上下跳轉、導覽、快速搜尋與匯出順序', async () => {
      await setupFiles();
      await vscode.commands.executeCommand('functionBookmarks.sortFileBookmarksByTitle', await fileGroup(relA));

      await open(fileA(), api);
      assert.deepStrictEqual(names(api.provider.currentSymbolNodes), ['zeta', 'alpha', 'mid']);

      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByTag');
      const noTag = (await groupsOf()).find((g) => g.key === '')!;
      const inAUnderTag = (await api.provider.getChildren(noTag))
        .filter((n) => (n.type === 'bookmark' ? n.entry.bookmark.file : n.type === 'favorite' ? n.fav.mark.file : '') === relA)
        .map((n) => labelOf(api.provider.getTreeItem(n)));
      assert.deepStrictEqual(inAUnderTag, ['① zeta', 'item10', 'BetaFn', '② item2', 'dup', 'dup']);
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');

      const editor = await openAt(fileA(), 0, api);
      assert.ok(editor);
      assert.strictEqual((await vscode.commands.executeCommand<{ line: number }>('functionBookmarks.nextBookmark'))?.line, 1);
      assert.strictEqual((await vscode.commands.executeCommand<{ line: number }>('functionBookmarks.nextBookmark'))?.line, 4);
      assert.strictEqual((await vscode.commands.executeCommand<{ line: number }>('functionBookmarks.nextBookmark'))?.line, 5);

      const t1 = await vscode.commands.executeCommand<{ number: number }>('functionBookmarks.tourNext');
      const t2 = await vscode.commands.executeCommand<{ number: number }>('functionBookmarks.tourNext');
      assert.deepStrictEqual([t1?.number, t2?.number], [1, 2]);

      const quick = buildSearchMarkItems(api.store, api.favorites, { hideNotOnBranch: false })
        .filter((i) => i.detail?.includes(relA))
        .map((i) => i.label);
      assert.ok(quick[0].includes('zeta') && quick[1].includes('item10') && quick[2].includes('BetaFn'));

      const outUri = workspaceFile('.tmp-sort-export.json');
      try {
        const exp = await vscode.commands.executeCommand<{ text: string }>('functionBookmarks.exportBookmarks', {
          folder: folder(),
          scope: { kind: 'path', rel: relA },
          format: 'json',
          includeCode: false,
          target: outUri,
        });
        const parsed = JSON.parse(exp!.text) as { bookmarks: { line: number }[] };
        assert.deepStrictEqual(parsed.bookmarks.map((b) => b.line), [0, 1, 4, 5, 9, 10]);
      } finally {
        await vscode.workspace.fs.delete(outUri).then(undefined, () => undefined);
      }
    });

    it('依建立時間排序：先加的排前面、無建立時間排最後、重開保留，側邊欄提示顯示建立時間', async () => {
      // 先在較後面的行加行號書籤，稍等一下再在較前面的行加函式書籤，另加一筆沒有建立時間的舊資料
      await openAt(fileA(), 9, api);
      await api.bookmarks.addLabeled('先加的行書籤');
      await new Promise((r) => setTimeout(r, 30));
      await openAt(fileA(), 0, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.store.update(folder(), (d) =>
        addBookmark(d, { id: 'legacy-no-time', file: relA, line: 5, label: '無建立時間書籤', anchor: makeAnchor(A_LINES, 5) }),
      );
      await api.favorites.refresh();

      // 預設依行號：zeta (0) → 無建立時間書籤 (5) → 先加的行書籤 (9)
      assert.deepStrictEqual(await childLabels(relA), ['zeta', '無建立時間書籤', '先加的行書籤']);

      // 切到依建立時間排序：先加的行書籤 → zeta → 無建立時間書籤（排最後）
      const gA = await fileGroup(relA);
      await vscode.commands.executeCommand('functionBookmarks.sortFileBookmarksByCreated', gA);
      const gAfter = await fileGroup(relA);
      const fileItem = api.provider.getTreeItem(gAfter);
      assert.strictEqual(fileItem.contextValue, 'fbBmFile:byCreated');
      assert.strictEqual(fileItem.description, 'app · by created time');
      assert.deepStrictEqual(await childLabels(relA), ['先加的行書籤', 'zeta', '無建立時間書籤']);

      // 側邊欄提示：有建立時間的顯示 Created YYYY-MM-DD HH:mm，沒有建立時間的不顯示
      const kids = await api.provider.getChildren(gAfter);
      const lineNode = kids.find((k) => k.type === 'bookmark' && k.entry.bookmark.label === '先加的行書籤') as BookmarkNode;
      const fnNode = kids.find((k) => k.type === 'favorite') as FavoriteNode;
      const legacyNode = kids.find((k) => k.type === 'bookmark' && k.entry.bookmark.id === 'legacy-no-time') as BookmarkNode;
      const lineTip = (api.provider.getTreeItem(lineNode).tooltip as vscode.MarkdownString).value;
      const fnTip = (api.provider.getTreeItem(fnNode).tooltip as vscode.MarkdownString).value;
      const legacyTip = (api.provider.getTreeItem(legacyNode).tooltip as vscode.MarkdownString).value;
      assert.ok(lineTip.includes(`Created ${formatLocalDateTime(lineNode.entry.bookmark.createdAt)}`), lineTip);
      assert.ok(fnTip.includes(`Created ${formatLocalDateTime(fnNode.fav.mark.addedAt)}`), fnTip);
      assert.ok(!legacyTip.includes('Created '), `沒有建立時間不應顯示 Created：${legacyTip}`);

      // 重建 provider 後保留依建立時間排序
      const reopened = api.recreateProvider();
      try {
        assert.strictEqual(reopened.fileSortOf(fileA()), 'created');
        assert.deepStrictEqual(await childLabels(relA, reopened), ['先加的行書籤', 'zeta', '無建立時間書籤']);
      } finally {
        reopened.dispose();
      }

      // 切回依行號排序
      await vscode.commands.executeCommand('functionBookmarks.sortFileBookmarksByLine', gAfter);
      assert.strictEqual(api.provider.fileSortOf(fileA()), 'line');
      assert.strictEqual(api.provider.getTreeItem(await fileGroup(relA)).contextValue, 'fbBmFile');
      assert.deepStrictEqual(await childLabels(relA), ['zeta', '無建立時間書籤', '先加的行書籤']);
    });
  });
});
