import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { addBookmark, emptyStore, setAlias, setFavorite, setNote, setTags } from '../../../src/storage/marks';
import { makeAnchor, newBookmarkId } from '../../../src/bookmarks/model';
import { BookmarkSearchBox } from '../../../src/views/searchBox';
import { tagsPrompt } from '../../../src/bookmarks/commands';
import { NoteEditor, saveShortcut } from '../../../src/views/noteEditor';
import { LSP_KIND } from '../../../src/symbols/symbolService';
import { buildSearchMarkItems, filterSearchMarkItems } from '../../../src/views/search';
import { searchFields } from '../../../src/views/tree';
import type { BmGroupNode, BookmarkNode, DirNode, FavoriteNode, FileNode, SymbolNode, TreeNode } from '../../../src/views/tree';

function findExtension(): vscode.Extension<ExtensionApi> | undefined {
  return vscode.extensions.all.find((e) => e.packageJSON?.name === 'function-bookmarks') as vscode.Extension<ExtensionApi> | undefined;
}

function folder(): vscode.WorkspaceFolder {
  return vscode.workspace.workspaceFolders![0];
}

function workspaceFile(...parts: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(folder().uri.fsPath, ...parts));
}

async function open(uri: vscode.Uri, api: ExtensionApi): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  await api.refreshNow();
  return editor;
}

function names(nodes: SymbolNode[]): unknown[] {
  return nodes.map((n) => (n.children.length ? { [n.symbol.name]: names(n.children) } : n.symbol.name));
}

function findNode(nodes: SymbolNode[], p: string): SymbolNode | undefined {
  for (const n of nodes) {
    if (n.symbol.path === p) {
      return n;
    }
    const hit = findNode(n.children, p);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

async function readStoreFile(): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(workspaceFile('.vscode', 'function-bookmarks.json')));
  } catch {
    return undefined;
  }
}

const isCursor = /cursor/i.test(vscode.env.appName);

/** 備註的預覽分頁數（內建 Markdown 預覽）。 */
function previewTabCount(): number {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('markdown.preview')).length;
}

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const start = Date.now();
  let v = await fn();
  while (!ok(v) && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 100));
    v = await fn();
  }
  return v;
}

describe('Function Bookmarks（整合測試）', () => {
  let api: ExtensionApi;

  before(async () => {
    const ext = findExtension();
    assert.ok(ext, '找不到套件');
    api = await ext.activate();
  });

  beforeEach(async () => {
    await api.store.update(folder(), () => emptyStore());
    await api.favorites.refresh();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(workspaceFile('.vscode'), { recursive: true }).then(undefined, () => undefined);
  });

  describe('M1：目前檔案的函式', () => {
    it('Python：列出 view 函式與 class-based view 的方法', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      assert.deepStrictEqual(names(api.provider.currentSymbolNodes), ['index', { ArticleView: ['get', 'post'] }]);
      assert.strictEqual(api.provider.currentFile?.source, 'rules');
    });

    it('Django template：templates/ 下的 html 套用 block、include 規則', async () => {
      await open(workspaceFile('app', 'templates', 'app', 'login.html'), api);
      assert.deepStrictEqual(names(api.provider.currentSymbolNodes), [
        'base.html',
        { content: ['partials/nav.html', 'form'] },
        { scripts: ['submit'] },
      ]);
    });

    it('Markdown：標題依層級列成目錄，程式碼區塊裡的 # 不算', async () => {
      await open(workspaceFile('docs', 'guide.md'), api);
      assert.deepStrictEqual(names(api.provider.currentSymbolNodes), [{ 使用手冊: ['安裝', { 設定: ['進階設定'] }] }]);
    });

    it('Django 規則不套用到 templates/ 以外的 html', async () => {
      await open(workspaceFile('static', 'plain.html'), api);
      assert.deepStrictEqual(api.provider.currentSymbolNodes, []);
    });

    it('點擊函式：跳到名稱位置並選取', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      const post = findNode(api.provider.currentSymbolNodes, 'ArticleView.post')!;
      const item = api.provider.getTreeItem(post);
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      const editor = vscode.window.activeTextEditor!;
      assert.strictEqual(editor.document.getText(editor.selection), 'post');
    });

    it('游標所在的函式：nodeAt 找出最內層節點', async () => {
      const editor = await open(workspaceFile('app', 'views.py'), api);
      const line = editor.document.getText().split('\n').findIndex((l) => l.includes('return "get"'));
      assert.strictEqual(api.provider.nodeAt(line)?.symbol.path, 'ArticleView.get');
    });

    it('編輯後重新整理，新函式出現', async () => {
      const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'function a() {}\n' });
      const editor = await vscode.window.showTextDocument(doc);
      await api.refreshNow();
      await editor.edit((b) => b.insert(new vscode.Position(1, 0), 'const b = () => {};\n'));
      await api.refreshNow();
      assert.deepStrictEqual(names(api.provider.currentSymbolNodes), ['a', 'b']);
    });

    it('detection.source = languageServer：改用語言伺服器（TypeScript 內建）', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      await cfg.update('detection.source', 'languageServer', vscode.ConfigurationTarget.Workspace);
      try {
        const doc = await vscode.workspace.openTextDocument({
          language: 'typescript',
          content: 'export class Greeter {\n  hello() {}\n}\nexport function main() {}\nconst value = 1;\n',
        });
        await vscode.window.showTextDocument(doc);
        const got = await waitFor(
          async () => {
            await vscode.commands.executeCommand('functionBookmarks.refresh');
            return names(api.provider.currentSymbolNodes);
          },
          (v) => v.length > 0,
          15000,
        );
        assert.deepStrictEqual(got, [{ Greeter: ['hello'] }, 'main']);
        assert.strictEqual(api.provider.currentFile?.source, 'languageServer');
      } finally {
        await cfg.update('detection.source', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });

    it('停用規則的設定立即生效', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      await cfg.update('detection.disabledRules', ['html-id', 'py-def', 'py-method'], vscode.ConfigurationTarget.Workspace);
      try {
        await open(workspaceFile('app', 'views.py'), api);
        assert.deepStrictEqual(names(api.provider.currentSymbolNodes), ['ArticleView']);
      } finally {
        await cfg.update('detection.disabledRules', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });
  });

  describe('M2：函式書籤（原本的收藏）與自訂名稱', () => {
    it('加入函式書籤：寫入書籤檔，關閉所有檔案後書籤區仍看得到', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      const get = findNode(api.provider.currentSymbolNodes, 'ArticleView.get')!;
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', get);
      const text = await readStoreFile();
      assert.ok(text?.includes('"path": "ArticleView.get"'), text);
      assert.ok(api.provider.getTreeItem(get).description?.toString().startsWith('★'));

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

    it('從游標位置切換收藏（編輯器右鍵選單）', async () => {
      const editor = await open(workspaceFile('app', 'views.py'), api);
      const line = editor.document.getText().split('\n').findIndex((l) => l.includes('return "post"'));
      editor.selection = new vscode.Selection(line, 0, line, 0);
      await vscode.commands.executeCommand('functionBookmarks.toggleFavorite');
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all.map((f) => f.mark.path), ['ArticleView.post']);
      await vscode.commands.executeCommand('functionBookmarks.toggleFavorite');
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all, []);
    });

    it('自訂顯示名稱：樹狀檢視顯示新名稱，提示中保留原名與路徑；清空即恢復', async () => {
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

    it('函式被刪除（例如 git pull）：收藏反灰顯示「找不到函式」；恢復後自動找回', async () => {
      // 用臨時檔案，測試中斷也不會弄壞範例檔
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
        );
        assert.strictEqual(missing, 'missing');
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`\n\n${full}`));
        const back = await waitFor(
          async () => {
            await api.favorites.refresh();
            return api.favorites.all[0];
          },
          (f) => f?.status === 'ok',
        );
        assert.strictEqual(back.status, 'ok');
        assert.strictEqual(back.symbol?.nameLine, 6, '行號跟著更新');
      } finally {
        await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
      }
    });

    it('檔案改名：收藏跟著更新路徑', async () => {
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
        );
        assert.deepStrictEqual(files, ['app/tmp_rename_b.py']);
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        for (const u of [from, to]) {
          await vscode.workspace.fs.delete(u).then(undefined, () => undefined);
        }
      }
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

    it('書籤檔格式壞掉時不覆寫', async () => {
      const file = workspaceFile('.vscode', 'function-bookmarks.json');
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode('{ broken'));
      await waitFor(() => api.store.isBroken(folder()), (v) => v);
      await open(workspaceFile('app', 'views.py'), api);
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', findNode(api.provider.currentSymbolNodes, 'index'));
      assert.strictEqual(await readStoreFile(), '{ broken');
      await vscode.workspace.fs.delete(file);
      await waitFor(() => api.store.isBroken(folder()), (v) => !v);
    });
  });

  describe('M2：整個專案', () => {
    it('依資料夾列出檔案，展開檔案才讀取函式', async () => {
      const top = await api.provider.getChildren(api.provider.sections.project);
      const labels = top.map((n) => api.provider.getTreeItem(n).label);
      assert.deepStrictEqual(labels, ['app', 'docs', 'langs', 'static', 'templates']);
      const app = top[0] as DirNode;
      const appChildren = await api.provider.getChildren(app);
      const views = appChildren.find((n): n is FileNode => n.type === 'file' && n.rel === 'app/views.py')!;
      const symbols = (await api.provider.getChildren(views)) as SymbolNode[];
      assert.deepStrictEqual(names(symbols), ['index', { ArticleView: ['get', 'post'] }]);
    });

    it('搜尋用的清單包含所有函式與 Django block，不含 extends／include', async () => {
      const entries = await api.collectProjectSymbols();
      const keys = entries.map((e) => `${e.rel}:${e.symbol.path}`);
      for (const k of ['app/views.py:ArticleView.get', 'app/templates/app/login.html:content.form', 'templates/base.html:title', 'templates/partials/nav.html:links']) {
        assert.ok(keys.includes(k), k);
      }
      assert.ok(!entries.some((e) => e.symbol.kind === 'reference'));
    });
  });

  describe('M2.1：使用回饋', () => {
    it('切換檔案再回來，函式的收合狀態維持不變', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      const cls = findNode(api.provider.currentSymbolNodes, 'ArticleView')!;
      assert.strictEqual(api.provider.getTreeItem(cls).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      api.provider.setExpanded(cls, false);
      await open(workspaceFile('templates', 'base.html'), api);
      await open(workspaceFile('app', 'views.py'), api);
      const again = findNode(api.provider.currentSymbolNodes, 'ArticleView')!;
      assert.notStrictEqual(again, cls, '節點是重新建立的');
      assert.strictEqual(api.provider.getTreeItem(again).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      api.provider.setExpanded(again, true);
    });

    it('點函式書籤跳到函式：選取留在書籤上，不跳到目前檔案；之後移動游標才跟隨', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.functionBookmarks');
      const editor = await open(workspaceFile('app', 'views.py'), api);
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', findNode(api.provider.currentSymbolNodes, 'index'));
      await api.favorites.refresh();
      const group = ((await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[])[0];
      const fav = ((await api.provider.getChildren(group)) as FavoriteNode[])[0];
      await api.treeView.reveal(fav, { select: true, focus: true });
      await waitFor(() => api.treeView.selection[0]?.type, (t) => t === 'favorite');
      await api.commands.openFavorite(fav.fav);
      await api.refreshNow();
      assert.strictEqual(api.followCursor(), undefined, '不應搶走選取');
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(api.treeView.selection[0]?.type, 'favorite', '選取仍在書籤上');

      const line = editor.document.getText().split('\n').findIndex((l) => l.includes('return "post"'));
      const active = vscode.window.activeTextEditor!;
      active.selection = new vscode.Selection(line, 0, line, 0);
      assert.strictEqual(api.followCursor()?.symbol.path, 'ArticleView.post', '移到別的函式時照常跟隨');
    });

    it('目前檔案收合時，游標跟隨不會把它展開', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.functionBookmarks');
      const editor = await open(workspaceFile('app', 'views.py'), api);
      api.provider.setExpanded(api.provider.sections.currentFile, false);
      try {
        const line = editor.document.getText().split('\n').findIndex((l) => l.includes('return "get"'));
        editor.selection = new vscode.Selection(line, 0, line, 0);
        assert.strictEqual(api.followCursor(), undefined);
        assert.strictEqual(api.provider.isExpanded(api.provider.sections.currentFile), false);
      } finally {
        api.provider.setExpanded(api.provider.sections.currentFile, true);
      }
    });

    it('焦點暫時離開編輯器時，目前檔案的函式不會被清空', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      const before = api.provider.currentSymbolNodes;
      await api.provider.refresh(undefined);
      assert.strictEqual(api.provider.currentSymbolNodes, before);
    });

    it('收藏的函式在行號旁顯示書籤符號；取消後移除', async () => {
      const editor = await open(workspaceFile('app', 'views.py'), api);
      const get = findNode(api.provider.currentSymbolNodes, 'ArticleView.get')!;
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', get);
      const lines = await waitFor(
        async () => {
          await api.gutter.update();
          return api.gutter.linesFor(editor.document.uri);
        },
        (v) => v.length === 1,
      );
      assert.deepStrictEqual(lines, [get.symbol.nameLine]);
      await vscode.commands.executeCommand('functionBookmarks.removeFavorite', get);
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(editor.document.uri), []);
    });

    it('備註：在編輯分頁寫好存檔後套用並關閉；側邊欄圖示換色、提示顯示全文；行號旁顯示備註圖示', async () => {
      const editor = await open(workspaceFile('app', 'views.py'), api);
      const viewsUri = editor.document.uri;
      const post = findNode(api.provider.currentSymbolNodes, 'ArticleView.post')!;
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', post);
      await vscode.commands.executeCommand('functionBookmarks.editNote', post);
      const noteEditor = vscode.window.activeTextEditor!;
      assert.ok(api.notes.isNoteDocument(noteEditor.document.uri), '應開啟備註分頁');
      assert.strictEqual(noteEditor.document.languageId, 'markdown');
      assert.ok(await waitFor(previewTabCount, (n) => n === 1), '右側並排 Markdown 預覽');
      await noteEditor.edit((b) => b.insert(new vscode.Position(0, 0), '送出文章\n\n- 需要登入\n- 會寄通知信'));
      if (isCursor) {
        assert.ok(noteEditor.document.uri.path.endsWith('.markdown'), 'Cursor 的編輯檔用 .markdown，才是一般文字編輯');
      }
      await noteEditor.document.save();
      const note = await waitFor(() => api.store.get(viewsUri, post.symbol)?.note, (v) => !!v);
      assert.strictEqual(note, '送出文章\n\n- 需要登入\n- 會寄通知信');
      await waitFor(
        () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.label.includes('post')),
        (open) => !open,
      );
      assert.strictEqual(await waitFor(previewTabCount, (n) => n === 0), 0, '存檔後預覽分頁也一起關閉');

      const item = api.provider.getTreeItem(post);
      assert.strictEqual(((item.iconPath as vscode.ThemeIcon).color as unknown as { id: string }).id, 'charts.blue');
      assert.strictEqual(item.label, 'post', '名稱不變，也不另外加圖示');
      assert.ok((item.tooltip as vscode.MarkdownString).value.includes('- 會寄通知信'));
      assert.ok((item.tooltip as vscode.MarkdownString).value.includes('command:functionBookmarks.previewNote?'), '提示中有「在預覽中開啟」');

      await vscode.commands.executeCommand('functionBookmarks.previewNote', post);
      assert.strictEqual(await waitFor(previewTabCount, (n) => n === 1), 1, '預覽備註開啟預覽分頁');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');

      await vscode.window.showTextDocument(viewsUri);
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(viewsUri, 'favorite'), [post.symbol.nameLine], '已加入書籤的函式顯示書籤圖示');

      await api.commands.editNote(post, '');
      assert.strictEqual(api.store.get(viewsUri, post.symbol)?.note, undefined);
      assert.strictEqual((api.provider.getTreeItem(post).iconPath as vscode.ThemeIcon).color, undefined);
    });

    it('內建 Markdown 預覽：mermaid 區塊交給本套件繪製，並保留同步捲動用的行號', async () => {
      const html = await vscode.commands.executeCommand<string>(
        'markdown.api.render',
        '# t\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n```js\nx()\n```\n',
      );
      assert.ok(/<pre class="code-line fb-mermaid" data-line="2">flowchart TD/.test(html), html);
      assert.ok(html.includes('A --&gt; B'), '內容要跳脫');
      assert.ok(!html.includes('fb-mermaid" data-line="7"'), '其他程式碼區塊不受影響');
    });

    it('備註分頁不存檔直接關閉：不變更', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      const get = findNode(api.provider.currentSymbolNodes, 'ArticleView.get')!;
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', get);
      await api.commands.editNote(get, '原本的備註');
      await vscode.commands.executeCommand('functionBookmarks.editNote', get);
      const noteEditor = vscode.window.activeTextEditor!;
      assert.strictEqual(noteEditor.document.getText(), '原本的備註');
      await noteEditor.edit((b) => b.insert(new vscode.Position(0, 0), '改了但不存'));
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      assert.strictEqual(api.store.get(get.uri, get.symbol)?.note, '原本的備註');
    });

    it('整個專案：沒有函式的檔案不顯示展開鈕，點擊直接開檔', async () => {
      const top = await api.provider.getChildren(api.provider.sections.project);
      const staticDir = top.find((n) => api.provider.getTreeItem(n).label === 'static') as DirNode;
      const files = (await api.provider.getChildren(staticDir)) as FileNode[];
      // 檔案節點先回傳，函式數量在背景計算
      await api.provider.whenCounted();
      const plain = api.provider.getTreeItem(files[0]);
      assert.strictEqual(plain.collapsibleState, vscode.TreeItemCollapsibleState.None);
      assert.strictEqual(plain.command?.command, 'vscode.open');
      const app = top.find((n) => api.provider.getTreeItem(n).label === 'app') as DirNode;
      const views = ((await api.provider.getChildren(app)) as FileNode[]).find((n) => n.rel === 'app/views.py')!;
      assert.strictEqual(api.provider.getTreeItem(views).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    });
  });

  describe('M3：行號書籤', () => {
    const fileA = () => workspaceFile('app', 'tmp_bm_a.py');
    const fileB = () => workspaceFile('app', 'tmp_bm_b.py');
    const body = Array.from({ length: 20 }, (_, i) => `line_${i} = ${i}`).join('\n') + '\n';
    const linesOf = (uri: vscode.Uri) => api.store.bookmarksFor(uri).map((b) => b.line);

    before(async () => {
      await vscode.workspace.fs.writeFile(fileA(), new TextEncoder().encode(`def helper():\n    pass\n\n${body}`));
      await vscode.workspace.fs.writeFile(fileB(), new TextEncoder().encode(body));
    });

    after(async () => {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      for (const u of [fileA(), fileB()]) {
        await vscode.workspace.fs.delete(u).then(undefined, () => undefined);
      }
    });

    async function at(uri: vscode.Uri, line: number): Promise<vscode.TextEditor> {
      const editor = await vscode.window.showTextDocument(uri);
      editor.selection = new vscode.Selection(line, 0, line, 0);
      return editor;
    }

    it('切換書籤：加入、記錄該行內容與所在函式、再按一次移除；側邊欄依檔案分組', async () => {
      await at(fileA(), 1);
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
    });

    it('多游標時每一行各自切換', async () => {
      const editor = await at(fileB(), 0);
      editor.selections = [3, 5, 5, 7].map((l) => new vscode.Selection(l, 0, l, 0));
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      assert.deepStrictEqual(linesOf(fileB()), [3, 5, 7]);
      await api.bookmarks.clearFile(fileB(), true);
      assert.deepStrictEqual(linesOf(fileB()), []);
    });

    it('編輯時平移：上方插入、行首 Enter、刪除整行（移到下一行）', async () => {
      const editor = await at(fileB(), 10);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await editor.edit((b) => b.insert(new vscode.Position(2, 0), 'a = 1\nb = 2\n'));
      assert.deepStrictEqual(await waitFor(() => linesOf(fileB()), (v) => v[0] === 12), [12]);
      await editor.edit((b) => b.insert(new vscode.Position(12, 0), '\n'));
      assert.deepStrictEqual(await waitFor(() => linesOf(fileB()), (v) => v[0] === 13), [13]);
      await editor.edit((b) => b.delete(new vscode.Range(12, 0, 14, 0)));
      assert.deepStrictEqual(await waitFor(() => linesOf(fileB()), (v) => v[0] === 12), [12], '書籤所在的行被刪除，移到下一行');
      assert.strictEqual(editor.document.lineAt(12).text, 'line_11 = 11');
      await editor.document.save();
      await api.tracker.refreshAnchors(editor.document);
      assert.strictEqual(api.store.bookmarksFor(fileB())[0].anchor?.text, 'line_11 = 11', '存檔時更新 anchor');
      await api.bookmarks.clearFile(fileB(), true);
    });

    it('檔案開著時被外部修改（例如 git pull）：VS Code 重新載入時給出精確差異，書籤跟著移動', async () => {
      const editor = await at(fileB(), 15);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await editor.document.save();
      const text = editor.document.getText();
      await vscode.workspace.fs.writeFile(fileB(), new TextEncoder().encode(`new_top = 0\n${text}`));
      await waitFor(() => editor.document.getText().startsWith('new_top'), (v) => v);
      assert.deepStrictEqual(await waitFor(() => linesOf(fileB()), (v) => v[0] === 16), [16]);
      await api.bookmarks.clearFile(fileB(), true);
    });

    it('名稱、標籤、依標籤分組、備註', async () => {
      await at(fileA(), 5);
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

      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByTag');
      try {
        const tags = await api.provider.getChildren(api.provider.sections.bookmarks);
        // 排序依編輯器語系而定（Cursor 與 VS Code 可能不同），只比對內容
        assert.deepStrictEqual(tags.map((t) => String(api.provider.getTreeItem(t).label)).sort(), ['#auth', '#待修']);
      } finally {
        await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
      }
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileA(), 'bookmark'), [5]);
      await api.bookmarks.clearAll(true);
      assert.strictEqual(api.store.allBookmarks().length, 0);
    });

    it('下一個／上一個書籤：跨檔案、頭尾相接；只顯示書籤', async () => {
      await at(fileA(), 4);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await at(fileB(), 2);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await at(fileA(), 0);
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

      await vscode.commands.executeCommand('functionBookmarks.showBookmarksOnly');
      try {
        const roots = await api.provider.getChildren();
        assert.deepStrictEqual(roots.map((r) => (r.type === 'section' ? r.section : r.type)), ['search', 'bookmarks']);
      } finally {
        await vscode.commands.executeCommand('functionBookmarks.showAll');
      }
      await api.bookmarks.clearAll(true);
    });
  });

  describe('書籤與收藏整合', () => {
    const fileC = () => workspaceFile('app', 'tmp_mix.py');
    const src = ['def alpha():', '    x = 1', '    return x', '', '', 'def beta():', '    y = 2', '    return y', ''].join('\n');

    before(async () => {
      await vscode.workspace.fs.writeFile(fileC(), new TextEncoder().encode(src));
    });

    after(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.workspace.fs.delete(fileC()).then(undefined, () => undefined);
    });

    async function at(line: number): Promise<vscode.TextEditor> {
      const editor = await vscode.window.showTextDocument(fileC());
      editor.selection = new vscode.Selection(line, 0, line, 0);
      await api.refreshNow();
      return editor;
    }

    /** 每項測試開始前書籤會被清空，這裡建立：函式書籤 beta（第 5 行）＋行號書籤（第 6 行）。 */
    async function setupMix(): Promise<{ beta: FavoriteNode; line: BookmarkNode }> {
      await at(5);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await at(6);
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

    it('Ctrl+Alt+B：在函式名稱那一行建立函式書籤，其他行建立行號書籤；書籤區依行號混排', async () => {
      await at(0);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await at(6);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await at(5);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all.map((f) => f.mark.path).sort(), ['alpha', 'beta']);
      assert.deepStrictEqual(api.store.bookmarksFor(fileC()).map((b) => b.line), [6]);

      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const group = groups.find((g) => g.rel === 'app/tmp_mix.py')!;
      const children = await api.provider.getChildren(group);
      assert.deepStrictEqual(
        children.map((c) => `${c.type}:${String(api.provider.getTreeItem(c).label)}`),
        ['favorite:alpha', 'favorite:beta', 'bookmark:y = 2'],
        '同一檔案內依行號混排',
      );
      assert.ok(String(api.provider.getTreeItem(api.provider.sections.bookmarks).description).startsWith('3'));

      await at(0);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all.map((f) => f.mark.path), ['beta'], '再按一次取消函式書籤');
    });

    it('滑鼠移到函式名稱上：提示中可加入／移除書籤，並顯示備註；同一位置只有一個我們的提示', async () => {
      await at(0);
      const ours = async (line: number, ch: number) =>
        ((await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', fileC(), new vscode.Position(line, ch))) ?? [])
          .flatMap((h) => h.contents)
          .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
          .filter((v) => v.includes('command:functionBookmarks.hoverAction'));
      const hover = await waitFor(() => ours(0, 5), (h) => h.length === 1);
      assert.strictEqual(hover.length, 1);
      assert.ok(hover[0].includes('star-empty'), '尚未加入時顯示 ☆');
      assert.deepStrictEqual(await ours(1, 5), [], '不在函式名稱上不顯示');

      const arg = (action: string) => ({ action, uri: fileC().toString(), path: 'alpha', kind: 'function', line: 0 });
      await vscode.commands.executeCommand('functionBookmarks.hoverAction', arg('toggle'));
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all.map((f) => f.mark.path), ['alpha']);
      const on = await ours(0, 5);
      assert.ok(on[0].includes('star-full'), '已加入時顯示 ★ 移除書籤');

      const node = findNode(api.provider.currentSymbolNodes, 'alpha')!;
      await api.commands.editNote(node, '筆記內容');
      const withNote = await ours(0, 5);
      assert.strictEqual(withNote.length, 1, '備註併入同一個提示，不會跳出兩個');
      assert.ok(withNote[0].includes('筆記內容'));

      await vscode.commands.executeCommand('functionBookmarks.hoverAction', arg('toggle'));
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all, []);

      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      await cfg.update('hover.enabled', false, vscode.ConfigurationTarget.Workspace);
      try {
        assert.deepStrictEqual(await waitFor(() => ours(0, 5), (h) => h.length === 0), [], '設定關閉後不顯示');
      } finally {
        await cfg.update('hover.enabled', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });

    it('沒加入書籤的函式不能改名、寫備註；滑鼠提示只顯示「加入書籤」', async () => {
      await at(0);
      const node = findNode(api.provider.currentSymbolNodes, 'alpha')!;
      await api.commands.rename(node, '不該成功');
      await api.commands.editNote(node, '不該成功');
      assert.strictEqual(api.store.get(fileC(), node.symbol), undefined);
      const item = api.provider.getTreeItem(node);
      assert.ok(/^fbSymbol:nofav/.test(item.contextValue ?? ''), '右鍵選單依此隱藏改名與備註');
      const hover = ((await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', fileC(), new vscode.Position(0, 5))) ?? [])
        .flatMap((h) => h.contents)
        .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
        .find((v) => v.includes('command:functionBookmarks.hoverAction'))!;
      assert.ok(hover.includes('%22toggle%22'));
      assert.ok(!hover.includes('%22rename%22') && !hover.includes('%22note%22'), '未加入書籤時不顯示改名與備註');
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', node);
      await api.commands.rename(node, '第一個');
      assert.strictEqual(api.store.get(fileC(), node.symbol)?.alias, '第一個', '加入書籤後就能改名');
    });

    it('程式碼中改了函式名稱：書籤、自訂名稱、備註、標籤自動轉到新名稱', async () => {
      const editor = await at(5);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      const beta = findNode(api.provider.currentSymbolNodes, 'beta')!;
      await api.commands.rename(beta, '第二個');
      await api.commands.editNote(beta, '說明');
      await api.commands.editTags(beta, '#api');
      // 在編輯器裡把 beta 改成 beta_v2（同一行）
      await editor.edit((b) => b.replace(new vscode.Range(5, 4, 5, 8), 'beta_v2'));
      const moved = await waitFor(
        () => api.store.allFavorites().find((f) => f.mark.file === 'app/tmp_mix.py'),
        (f) => f?.mark.path === 'beta_v2',
      );
      assert.deepStrictEqual(
        { path: moved?.mark.path, alias: moved?.mark.alias, note: moved?.mark.note, tags: moved?.mark.tags },
        { path: 'beta_v2', alias: '第二個', note: '說明', tags: ['api'] },
      );
      await api.favorites.refresh();
      assert.strictEqual(api.favorites.all.find((f) => f.mark.path === 'beta_v2')?.status, 'ok', '不再顯示找不到函式');
      await vscode.commands.executeCommand('workbench.action.files.revert');
    });

    it('檔案沒開著時被外部改了函式名稱（例如 git pull）：背景確認時也會轉移', async () => {
      await at(0);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.workspace.fs.writeFile(fileC(), new TextEncoder().encode(src.replace('def alpha(', 'def alpha_renamed(')));
      try {
        const f = await waitFor(
          async () => {
            await api.favorites.refresh();
            return api.favorites.all.find((x) => x.mark.file === 'app/tmp_mix.py');
          },
          (x) => x?.mark.path === 'alpha_renamed',
        );
        assert.strictEqual(f?.status, 'ok');
      } finally {
        await vscode.workspace.fs.writeFile(fileC(), new TextEncoder().encode(src));
      }
    });

    it('行號右鍵選單：指定的行切換書籤', async () => {
      await at(0);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark', { lineNumber: 3, uri: fileC() });
      assert.ok(api.store.bookmarksFor(fileC()).some((b) => b.line === 2));
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark', { lineNumber: 3, uri: fileC() });
      assert.ok(!api.store.bookmarksFor(fileC()).some((b) => b.line === 2));
    });

    it('函式書籤也能加標籤；依標籤分組時兩種一起列出', async () => {
      const { beta, line } = await setupMix();
      await api.commands.editTags(beta, '#api');
      await api.bookmarks.editTags(line, '#api #db');
      await api.favorites.refresh();
      assert.deepStrictEqual(api.favorites.all.find((f) => f.mark.path === 'beta')?.mark.tags, ['api']);
      assert.strictEqual(api.provider.getTreeItem(beta).contextValue?.startsWith('fbBookmark:fn'), true, '函式書籤與行號書籤共用右鍵選單');
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByTag');
      try {
        const tags = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
        const apiGroup = tags.find((t) => t.key === 'api')!;
        assert.deepStrictEqual(apiGroup.items.map((i) => i.kind).sort(), ['line', 'symbol']);
      } finally {
        await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
      }
    });

    it('下一個／上一個與清除：兩種書籤一起', async () => {
      await setupMix();
      await at(0);
      await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
      const pos = () => `${path.basename(vscode.window.activeTextEditor!.document.uri.fsPath)}:${vscode.window.activeTextEditor!.selection.active.line}`;
      assert.strictEqual(pos(), 'tmp_mix.py:5', '先到函式書籤 beta');
      await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
      assert.strictEqual(pos(), 'tmp_mix.py:6', '再到行號書籤');
      await api.bookmarks.clearFile(fileC(), true);
      await api.favorites.refresh();
      assert.strictEqual(api.store.bookmarksFor(fileC()).length, 0);
      assert.ok(!api.favorites.all.some((f) => f.mark.file === 'app/tmp_mix.py'));
    });

    it('點書籤跳轉後，側邊欄選取留在書籤上（不被游標跟隨搶走）', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.functionBookmarks');
      await at(7);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      // 等移動游標觸發的「游標跟隨」做完：它的 reveal 是非同步的，慢的機器上會晚到、蓋掉下面選取的書籤（CI 偶發）
      await new Promise((r) => setTimeout(r, 400));
      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const group = groups.find((g) => g.rel === 'app/tmp_mix.py')!;
      const node = (await api.provider.getChildren(group))[0] as BookmarkNode;
      await api.treeView.reveal(node, { select: true, focus: true });
      await waitFor(() => api.treeView.selection[0]?.type, (t) => t === 'bookmark');
      const item = api.provider.getTreeItem(node);
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      await api.refreshNow();
      assert.strictEqual(api.followCursor(), undefined, '不應跳到最近的函式');
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(api.treeView.selection[0]?.type, 'bookmark');
      await api.bookmarks.clearFile(fileC(), true);
    });
  });

  describe('M4／M5：外部改檔（git pull、切換分支、合併、AI 改檔）', () => {
    const file = (n: string) => workspaceFile('app', `tmp_ext_${n}.py`);
    const made: vscode.Uri[] = [];
    const content = (n: number, p = 'v') => Array.from({ length: n }, (_, i) => `${p}_${i} = compute_${p}(${i})`);
    const write = (uri: vscode.Uri, ls: string[]) =>
      vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(ls.join('\n') + '\n'));
    const state = (uri: vscode.Uri) => api.store.bookmarksFor(uri).map((b) => `${b.line}${b.status === 'lost' ? '?' : ''}`);
    const settle = (uri: vscode.Uri, want: string[]) =>
      waitFor(
        async () => {
          await api.external.idle();
          return state(uri);
        },
        (v) => JSON.stringify(v) === JSON.stringify(want),
        8000,
      );

    /** 建立檔案並直接在指定行加書籤（不開啟檔案）。 */
    async function plant(uri: vscode.Uri, ls: string[], at: number[]): Promise<void> {
      made.push(uri);
      await write(uri, ls);
      const rel = `app/${path.basename(uri.fsPath)}`;
      await api.store.update(folder(), (d) =>
        at.reduce((acc, line) => addBookmark(acc, { id: newBookmarkId(), file: rel, line, anchor: makeAnchor(ls, line) }), d),
      );
      await api.external.idle();
    }

    after(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      for (const u of made) {
        await vscode.workspace.fs.delete(u).then(undefined, () => undefined);
      }
      await vscode.workspace.fs.delete(workspaceFile('.vscode', 'bookmarks.json')).then(undefined, () => undefined);
    });

    it('沒開著的檔案被改（git pull）：上方插入、下方刪除，書籤依差異移動', async () => {
      const uri = file('pull');
      const old = content(30);
      await plant(uri, old, [3, 20]);
      await write(uri, ['import os', 'import sys', ...old.slice(0, 15), ...old.slice(18)]);
      assert.deepStrictEqual(await settle(uri, ['5', '19']), ['5', '19']);
      assert.strictEqual(api.store.bookmarksFor(uri)[0].anchor?.text, old[3]);
    });

    it('多個檔案同時被改（AI 改檔、切換分支）：一起換算', async () => {
      const uris = ['m1', 'm2', 'm3'].map(file);
      const olds = uris.map((_, i) => content(20, `f${i}`));
      for (let i = 0; i < uris.length; i++) {
        await plant(uris[i], olds[i], [10]);
      }
      await Promise.all(uris.map((u, i) => write(u, [...Array.from({ length: i + 1 }, (_, j) => `# added ${j}`), ...olds[i]])));
      for (let i = 0; i < uris.length; i++) {
        assert.deepStrictEqual(await settle(uris[i], [String(11 + i)]), [String(11 + i)]);
      }
    });

    it('書籤那一行被搬到很遠的地方：後備定位找回來', async () => {
      const uri = file('move');
      const old = content(40);
      await plant(uri, old, [30]);
      await write(uri, [old[30], ...old.slice(0, 30), ...old.slice(31)]);
      assert.deepStrictEqual(await settle(uri, ['0']), ['0']);
    });

    it('書籤那一行被刪除：標成需確認並反灰；「移到游標所在的行」放回去', async () => {
      const uri = file('lost');
      const old = content(20);
      await plant(uri, old, [8]);
      await write(uri, [...old.slice(0, 8), ...old.slice(9)]);
      assert.deepStrictEqual(await settle(uri, ['8?']), ['8?']);
      const groups = await api.provider.getChildren(api.provider.sections.bookmarks);
      const group = groups.find((g) => (g as BmGroupNode).rel === 'app/tmp_ext_lost.py')!;
      const node = (await api.provider.getChildren(group))[0] as BookmarkNode;
      const item = api.provider.getTreeItem(node);
      assert.ok(String(item.contextValue).includes(':lost'));
      assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'warning');

      const editor = await vscode.window.showTextDocument(uri);
      editor.selection = new vscode.Selection(6, 0, 6, 0);
      await vscode.commands.executeCommand('functionBookmarks.moveBookmarkToCursor', node);
      assert.deepStrictEqual(state(uri), ['6']);
      assert.strictEqual(api.store.bookmarksFor(uri)[0].anchor?.text, old[6]);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('合併衝突：衝突範圍內的書籤標成需確認，衝突解決後恢復', async () => {
      const uri = file('conflict');
      const old = content(20);
      await plant(uri, old, [5, 15]);
      await write(uri, [...old.slice(0, 4), '<<<<<<< HEAD', ...old.slice(4, 7), '=======', 'theirs = 1', '>>>>>>> feature', ...old.slice(7)]);
      assert.deepStrictEqual(await settle(uri, ['6?', '19']), ['6?', '19']);
      await write(uri, old);
      assert.deepStrictEqual(await settle(uri, ['5', '15']), ['5', '15']);
    });

    it('開著的檔案整份被取代（格式化工具等）：依差異換算；沒存檔就關閉：換算回磁碟內容', async () => {
      const uri = file('replace');
      const old = content(20);
      await plant(uri, old, [10]);
      const editor = await vscode.window.showTextDocument(uri);
      await api.external.idle();
      const next = ['import os', 'import re', 'import sys', ...old.slice(0, 5), ...old.slice(6)].join('\n') + '\n';
      await editor.edit((b) => b.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), next));
      assert.deepStrictEqual(await settle(uri, ['12']), ['12']);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      assert.deepStrictEqual(await settle(uri, ['10']), ['10']);
    });

    it('乾淨文件第一次編輯：上方插入 3 行後立刻存檔，書籤移到 N+3 且 anchor.text 保留原本內容', async () => {
      const uri = file('first_edit_save');
      const old = content(20);
      await plant(uri, old, [8]);
      const editor = await open(uri, api);
      await api.external.idle();
      assert.strictEqual(editor.document.isDirty, false);
      assert.ok(await editor.edit((b) => b.insert(new vscode.Position(8, 0), 'ins_0 = 0\nins_1 = 1\nins_2 = 2\n')));
      // 300ms 內立刻存檔（不先等 timer 到期）
      assert.ok(await editor.document.save());
      await api.external.idle();
      const bm = await waitFor(
        async () => {
          await api.external.idle();
          return api.store.bookmarksFor(uri)[0];
        },
        (b) => b?.line === 11 && b.anchor?.text === old[8] && b.anchor?.before[1] === 'ins_2 = 2',
        8000,
      );
      assert.strictEqual(bm.line, 11);
      assert.strictEqual(bm.anchor?.text, old[8]);
      assert.deepStrictEqual(bm.anchor?.before, ['ins_1 = 1', 'ins_2 = 2']);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('乾淨文件第一次編輯就刪掉書籤那一行：依 onLineDelete 設定處理（remove／markLost／moveToNext）', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      try {
        for (const mode of ['remove', 'markLost', 'moveToNext'] as const) {
          await cfg.update('bookmarks.onLineDelete', mode, vscode.ConfigurationTarget.Workspace);
          const uri = file(`first_del_${mode}`);
          const old = content(15);
          await plant(uri, old, [6]);
          const editor = await open(uri, api);
          await api.external.idle();
          assert.strictEqual(editor.document.isDirty, false);
          assert.ok(await editor.edit((b) => b.delete(new vscode.Range(6, 0, 7, 0))));
          await waitFor(() => editor.document.isDirty, (v) => v);
          await api.external.idle();
          const list = await waitFor(
            async () => {
              await api.external.idle();
              return api.store.bookmarksFor(uri);
            },
            (bms) => {
              if (mode === 'remove') {
                return bms.length === 0;
              }
              if (mode === 'markLost') {
                return bms.length === 1 && bms[0].status === 'lost';
              }
              return bms.length === 1 && bms[0].line === 6 && bms[0].status === undefined;
            },
            8000,
          );
          if (mode === 'remove') {
            assert.deepStrictEqual(list, [], 'remove：書籤應被刪除');
          } else if (mode === 'markLost') {
            assert.strictEqual(list.length, 1);
            assert.strictEqual(list[0].status, 'lost', 'markLost：書籤應標成 lost');
          } else {
            assert.strictEqual(list.length, 1);
            assert.strictEqual(list[0].line, 6, 'moveToNext：移到原本的下一行');
            assert.strictEqual(list[0].status, undefined, 'moveToNext：不應標成 lost');
            assert.strictEqual(editor.document.lineAt(list[0].line).text, old[7]);
          }
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
      } finally {
        await cfg.update('bookmarks.onLineDelete', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });

    it('「匯入書籤」也認得 alefragnani Bookmarks 的 .vscode/bookmarks.json：匯入成自己的書籤；重複匯入不會重複', async () => {
      const uri = file('imp');
      made.push(uri);
      const ls = content(10);
      await write(uri, ls);
      const json = {
        files: [
          {
            path: 'app/tmp_ext_imp.py',
            bookmarks: [
              { line: 2, column: 0, label: '登入' },
              { line: 4, column: 3, label: '' },
              { line: 999, column: 0, label: '' },
            ],
          },
          { path: 'app/not_exists.py', bookmarks: [{ line: 1, column: 0, label: '' }] },
        ],
      };
      await vscode.workspace.fs.writeFile(
        workspaceFile('.vscode', 'bookmarks.json'),
        new TextEncoder().encode(JSON.stringify(json, null, '\t')),
      );
      type R = { format: string; imported: number; skipped: number };
      const importOld = () =>
        vscode.commands.executeCommand<R>('functionBookmarks.importBookmarks', { uri: workspaceFile('.vscode', 'bookmarks.json'), confirmed: true });
      const r = await importOld();
      assert.deepStrictEqual({ format: r.format, imported: r.imported, skipped: r.skipped }, { format: 'alefragnani', imported: 2, skipped: 2 });
      assert.deepStrictEqual(
        api.store.bookmarksFor(uri).map((b) => [b.line, b.label, b.anchor?.text, b.source]),
        [
          [2, '登入', ls[2], undefined],
          [4, undefined, ls[4], undefined],
        ],
      );
      const again = await importOld();
      assert.deepStrictEqual({ imported: again.imported, skipped: again.skipped }, { imported: 0, skipped: 4 });
      assert.strictEqual(api.store.bookmarksFor(uri).length, 2);
      const cmds = await vscode.commands.getCommands(true);
      assert.ok(!cmds.includes('functionBookmarks.importAlefragnani'), '獨立的指令已拿掉');
    });
  });

  describe('實際模擬 Cursor AI 改檔（真實的 Django views）', () => {
    const fsp = require('fs/promises') as typeof import('fs/promises');
    const VIEWS = [
      'import json',
      'from django.http import JsonResponse',
      'from django.shortcuts import get_object_or_404, render',
      'from django.views import View',
      '',
      'from .forms import ArticleForm',
      'from .models import Article',
      '',
      '',
      'def article_list(request):',
      '    qs = Article.objects.filter(published=True).order_by("-created_at")',
      '    keyword = request.GET.get("q")',
      '    if keyword:',
      '        qs = qs.filter(title__icontains=keyword)',
      '    return render(request, "app/article_list.html", {"articles": qs})',
      '',
      '',
      'class ArticleCreateView(View):',
      '    template_name = "app/article_form.html"',
      '',
      '    def get(self, request):',
      '        return render(request, self.template_name, {"form": ArticleForm()})',
      '',
      '    def post(self, request):',
      '        form = ArticleForm(request.POST)',
      '        if not form.is_valid():',
      '            return render(request, self.template_name, {"form": form}, status=400)',
      '        article = form.save(commit=False)',
      '        article.author = request.user',
      '        article.save()',
      '        return JsonResponse({"id": article.pk})',
      '',
      '',
      'def article_api(request, pk):',
      '    article = get_object_or_404(Article, pk=pk)',
      '    payload = json.loads(request.body or "{}")',
      '    article.title = payload.get("title", article.title)',
      '    article.save(update_fields=["title"])',
      '    return JsonResponse({"id": article.pk, "title": article.title})',
    ];
    /** 書籤放在這幾行（用內容找行號，之後也用內容驗證位置）。 */
    const MARKS = [
      '    qs = Article.objects.filter(published=True).order_by("-created_at")',
      '        if not form.is_valid():',
      '    payload = json.loads(request.body or "{}")',
    ];
    const made: vscode.Uri[] = [];
    let seq = 0;

    const text = (ls: string[]) => ls.join('\n') + '\n';
    /** 檢查每個書籤是否還在原本那段程式碼上（比對去掉縮排後的內容）。 */
    async function where(uri: vscode.Uri): Promise<string[]> {
      await api.external.idle();
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const lines = doc ? doc.getText().split(/\r?\n/) : (await fsp.readFile(uri.fsPath, 'utf8')).split(/\r?\n/);
      return api.store
        .bookmarksFor(uri)
        .map((b) => (b.status === 'lost' ? `?${b.anchor?.text}` : (lines[b.line] ?? '').trim()));
    }
    const expectMarks = (want = MARKS.map((m) => m.trim())) => want;
    async function settle(uri: vscode.Uri, want: string[]): Promise<string[]> {
      return waitFor(() => where(uri), (v) => JSON.stringify(v) === JSON.stringify(want), 8000);
    }

    async function plant(): Promise<vscode.Uri> {
      const uri = workspaceFile('app', `tmp_ai_views_${++seq}.py`);
      made.push(uri);
      await fsp.writeFile(uri.fsPath, text(VIEWS));
      const rel = `app/${path.basename(uri.fsPath)}`;
      await api.store.update(folder(), (d) =>
        MARKS.reduce((acc, m) => {
          const line = VIEWS.indexOf(m);
          return addBookmark(acc, { id: newBookmarkId(), file: rel, line, anchor: makeAnchor(VIEWS, line) });
        }, d),
      );
      await api.external.idle();
      return uri;
    }

    /** AI 的典型修改：最上面加 import 和一個新函式、把 post 包進 try/except（縮排改變）、改寫 article_api 的一部分。 */
    function aiRefactor(ls: string[]): string[] {
      const out = [...ls];
      out.splice(out.indexOf('import json'), 1, 'import json', 'import logging');
      out.splice(out.indexOf('from .models import Article') + 1, 0, '', 'logger = logging.getLogger(__name__)', '', '', 'def health(request):', '    return JsonResponse({"ok": True})');
      const s = out.indexOf('        form = ArticleForm(request.POST)');
      const e = out.indexOf('        return JsonResponse({"id": article.pk})');
      const body = out.slice(s, e + 1).map((l) => `    ${l}`);
      out.splice(s, e - s + 1, '        try:', ...body, '        except Exception:', '            logger.exception("create article failed")', '            raise');
      const t = out.indexOf('    article.title = payload.get("title", article.title)');
      out.splice(t, 1, '    title = payload.get("title")', '    if title:', '        article.title = title.strip()');
      return out;
    }

    after(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      for (const u of made) {
        await fsp.rm(u.fsPath, { force: true });
      }
    });

    it('檔案沒開著：AI 直接寫磁碟（加函式、包 try/except 改縮排、改寫一段）', async () => {
      const uri = await plant();
      await fsp.writeFile(uri.fsPath, text(aiRefactor(VIEWS)));
      assert.deepStrictEqual(await settle(uri, expectMarks()), expectMarks());
    });

    it('檔案沒開著：分好幾次串流寫入（中間是寫到一半的內容）', async () => {
      const uri = await plant();
      const final = aiRefactor(VIEWS);
      for (const n of [5, 18, 30]) {
        await fsp.writeFile(uri.fsPath, text(final.slice(0, n)));
        await new Promise((r) => setTimeout(r, 400));
      }
      await fsp.writeFile(uri.fsPath, text(final));
      assert.deepStrictEqual(await settle(uri, expectMarks()), expectMarks());
    });

    it('檔案沒開著：先寫暫存檔再改名覆蓋原檔（原子寫入）', async () => {
      const uri = await plant();
      const tmp = `${uri.fsPath}.tmp-${Date.now()}`;
      await fsp.writeFile(tmp, text(aiRefactor(VIEWS)));
      await fsp.rename(tmp, uri.fsPath);
      assert.deepStrictEqual(await settle(uri, expectMarks()), expectMarks());
    });

    it('檔案開著（沒修改）：AI 寫磁碟，編輯器重新載入', async () => {
      const uri = await plant();
      await vscode.window.showTextDocument(uri);
      await api.external.idle();
      await fsp.writeFile(uri.fsPath, text(aiRefactor(VIEWS)));
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())!;
      await waitFor(() => doc.getText(), (t) => t.includes('def health'), 8000);
      assert.deepStrictEqual(await settle(uri, expectMarks()), expectMarks());
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('檔案開著：在編輯器裡一段一段套用 AI 修改（多行換成多行），存檔', async () => {
      const uri = await plant();
      const editor = await vscode.window.showTextDocument(uri);
      await api.external.idle();
      const doc = editor.document;
      const find = (s: string) => doc.getText().split(/\r?\n/).indexOf(s);
      // 1. 把整個 post 方法換成包了 try/except 的版本（Cursor 套用修改常這樣整段取代）
      const s = find('    def post(self, request):');
      const e = find('        return JsonResponse({"id": article.pk})');
      const post = doc.getText().split(/\r?\n/).slice(s, e + 1);
      const wrapped = [post[0], '        try:', ...post.slice(1).map((l) => `    ${l}`), '        except Exception:', '            raise'];
      await editor.edit((b) => b.replace(new vscode.Range(s, 0, e + 1, 0), wrapped.join('\n') + '\n'));
      // 2. 整個 article_list 函式換成新版（書籤那一行內容不變）
      const ls = find('def article_list(request):');
      const le = find('    return render(request, "app/article_list.html", {"articles": qs})');
      await editor.edit((b) =>
        b.replace(
          new vscode.Range(ls, 0, le + 1, 0),
          [
            'def article_list(request):',
            '    """文章列表，可用 q 搜尋標題。"""',
            '    qs = Article.objects.filter(published=True).order_by("-created_at")',
            '    keyword = (request.GET.get("q") or "").strip()',
            '    if keyword:',
            '        qs = qs.filter(title__icontains=keyword)',
            '    return render(request, "app/article_list.html", {"articles": qs, "q": keyword})',
          ].join('\n') + '\n',
        ),
      );
      // 3. 最上面插入新的 import
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'import logging\n'));
      assert.deepStrictEqual(await settle(uri, expectMarks()), expectMarks());
      await doc.save();
      assert.deepStrictEqual(await settle(uri, expectMarks()), expectMarks());
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('AI 把函式整個搬到檔案最後、刪掉另一個函式：搬走的找回來，刪掉的標成需確認', async () => {
      const uri = await plant();
      const out = [...VIEWS];
      const s = out.indexOf('def article_list(request):');
      const listFn = out.splice(s, 6); // 整個 article_list 函式
      const a = out.indexOf('def article_api(request, pk):');
      out.splice(a, out.length - a); // 刪掉 article_api
      out.push(...listFn);
      await fsp.writeFile(uri.fsPath, text(out));
      const want = [MARKS[0].trim(), MARKS[1].trim(), `?${MARKS[2].trim()}`];
      const sorted = (v: string[]) => JSON.stringify([...v].sort());
      const got = await waitFor(() => where(uri), (v) => sorted(v) === sorted(want), 8000);
      assert.deepStrictEqual([...got].sort(), [...want].sort());
    });

    it('AI 同時改好幾個檔案', async () => {
      const uris = [await plant(), await plant(), await plant()];
      await Promise.all(uris.map((u) => fsp.writeFile(u.fsPath, text(aiRefactor(VIEWS)))));
      for (const u of uris) {
        assert.deepStrictEqual(await settle(u, expectMarks()), expectMarks());
      }
    });
  });

  describe('M5：切換分支（真的在臨時 git 專案裡切換）', () => {
    const fsp = require('fs/promises') as typeof import('fs/promises');
    const cp = require('child_process') as typeof import('child_process');
    const root = () => folder().uri.fsPath;
    const git = (...args: string[]) =>
      cp.execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], {
        cwd: root(),
        stdio: 'pipe',
      });
    const fileA = () => workspaceFile('app', 'tmp_branch_a.py');
    const fileB = () => workspaceFile('app', 'tmp_branch_b.py');
    const fileC = () => workspaceFile('app', 'tmp_branch_c.py');
    const fileC2 = () => workspaceFile('app', 'tmp_branch_c2.py');
    const main = Array.from({ length: 20 }, (_, i) => `common_${i} = shared_value(${i})`);
    const feature = [...main.slice(0, 5), 'def feature_only():', '    return build_feature_payload()', '', ...main.slice(5)];
    const cLines = Array.from({ length: 12 }, (_, i) => `renamed_${i} = compute_rename(${i})`);
    const text = (ls: string[]) => ls.join('\n') + '\n';
    const rel = (u: vscode.Uri) => `app/${path.basename(u.fsPath)}`;
    const state = (uri: vscode.Uri) => api.store.bookmarksFor(uri).map((b) => (b.status === 'notOnBranch' ? '~' : b.status === 'lost' ? `${b.line}?` : String(b.line)));
    async function settle(uri: vscode.Uri, want: string[]): Promise<string[]> {
      return waitFor(
        async () => {
          await api.branches.refresh();
          await api.external.idle();
          return state(uri);
        },
        (v) => JSON.stringify(v) === JSON.stringify(want),
        10000,
      );
    }
    async function plant(uri: vscode.Uri, ls: string[], lines: number[]): Promise<void> {
      await api.store.update(folder(), (d) =>
        lines.reduce((acc, line) => addBookmark(acc, { id: newBookmarkId(), file: rel(uri), line, anchor: makeAnchor(ls, line) }), d),
      );
      await api.external.idle();
    }
    async function checkout(...args: string[]): Promise<void> {
      git('checkout', ...args);
      await api.branches.refresh();
    }

    before(async function () {
      this.timeout(60000);
      await fsp.rm(path.join(root(), '.git'), { recursive: true, force: true });
      git('init');
      git('checkout', '-b', 'main');
      await fsp.writeFile(fileA().fsPath, text(main));
      await fsp.writeFile(fileC().fsPath, text(cLines));
      git('add', rel(fileA()), rel(fileC()));
      git('commit', '-m', 'main');
      git('checkout', '-b', 'feature');
      await fsp.writeFile(fileA().fsPath, text(feature));
      await fsp.writeFile(fileB().fsPath, text(['def only_here():', '    pass', '    return feature_file_value()']));
      git('add', rel(fileA()), rel(fileB()));
      git('commit', '-m', 'feature');
      await api.branches.rescan();
    });

    beforeEach(async () => {
      // 每項都從 feature 分支、書籤在固定位置開始
      await checkout('feature');
      await api.store.update(folder(), () => emptyStore());
      await api.external.idle();
      await plant(fileA(), feature, [6, 15]);
      await plant(fileB(), ['def only_here():', '    pass', '    return feature_file_value()'], [2]);
    });

    after(async function () {
      this.timeout(60000);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fsp.rm(path.join(root(), '.git'), { recursive: true, force: true });
      for (const u of [fileA(), fileB(), fileC(), fileC2()]) {
        await fsp.rm(u.fsPath, { force: true });
      }
      await api.branches.rescan();
    });

    it('檔案沒開著：切到 main，feature 才有的程式碼與檔案標成不在此分支，共同的程式碼換算位置；切回 feature 全部恢復', async () => {
      assert.strictEqual(api.treeView.description, 'feature', '標題旁顯示目前分支');
      await checkout('main');
      assert.deepStrictEqual(await settle(fileA(), ['~', '12']), ['~', '12']);
      assert.deepStrictEqual(await settle(fileB(), ['~']), ['~']);
      assert.strictEqual(api.treeView.description, 'main');
      const groups = await api.provider.getChildren(api.provider.sections.bookmarks);
      const group = groups.find((g) => (g as BmGroupNode).rel === rel(fileA()))!;
      const node = (await api.provider.getChildren(group))[0] as BookmarkNode;
      const item = api.provider.getTreeItem(node);
      assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'git-branch');
      assert.ok(String(item.contextValue).includes(':away'));

      await checkout('feature');
      assert.deepStrictEqual(await settle(fileA(), ['6', '15']), ['6', '15']);
      assert.deepStrictEqual(await settle(fileB(), ['2']), ['2']);
      const [f, c] = api.store.bookmarksFor(fileA());
      assert.strictEqual(f.anchor?.text, 'return build_feature_payload()');
      assert.strictEqual(f.positions?.main?.status, 'notOnBranch');
      assert.deepStrictEqual(c.positions?.main, { line: 12 });
    });

    it('檔案開著：切分支時編輯器重新載入，一樣換算；來回切換不累積誤差', async () => {
      await vscode.window.showTextDocument(fileA());
      await api.external.idle();
      for (let i = 0; i < 2; i++) {
        await checkout('main');
        assert.deepStrictEqual(await settle(fileA(), ['~', '12']), ['~', '12']);
        await checkout('feature');
        assert.deepStrictEqual(await settle(fileA(), ['6', '15']), ['6', '15']);
      }
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === fileA().toString())!;
      assert.strictEqual(doc.isDirty, false);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('隱藏不在此分支的書籤；只在這個分支顯示的書籤，在其他分支看不到、也不會被移動', async () => {
      await checkout('main');
      await settle(fileA(), ['~', '12']);
      await vscode.commands.executeCommand('functionBookmarks.hideNotOnBranch');
      const groups = await api.provider.getChildren(api.provider.sections.bookmarks);
      assert.ok(!groups.some((g) => (g as BmGroupNode).rel === rel(fileB())), '整個檔案都不在此分支：不列出');
      await vscode.commands.executeCommand('functionBookmarks.showNotOnBranch');
      await checkout('feature');
      await settle(fileA(), ['6', '15']);

      const entry = api.store.allBookmarks().find((e) => e.bookmark.file === rel(fileA()) && e.bookmark.line === 15)!;
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkBranchOnly', { type: 'bookmark', entry });
      assert.strictEqual(api.store.bookmarksFor(fileA()).find((b) => b.id === entry.bookmark.id)?.homeBranch, 'feature');
      await checkout('main');
      assert.deepStrictEqual(await settle(fileA(), ['~']), ['~'], '只屬於 feature 的書籤在 main 看不到');
      const hidden = api.store.bookmarksFor(fileA(), { includeHidden: true }).find((b) => b.id === entry.bookmark.id)!;
      assert.strictEqual(hidden.line, 15, '隱藏期間不換算');
      await checkout('feature');
      assert.deepStrictEqual(await settle(fileA(), ['6', '15']), ['6', '15']);
      const back = api.store.allBookmarks().find((e) => e.bookmark.id === entry.bookmark.id)!;
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkAllBranches', { type: 'bookmark', entry: back });
      assert.strictEqual(api.store.bookmarksFor(fileA()).find((b) => b.id === entry.bookmark.id)?.scope, undefined);
    });

    it('檔案在分支間改名：書籤跟著改名後的檔案；切回去再跟回來', async () => {
      await plant(fileC(), cLines, [3]);
      git('checkout', '-b', 'renamed');
      git('mv', rel(fileC()), rel(fileC2()));
      git('commit', '-m', 'rename');
      assert.deepStrictEqual(await settle(fileC2(), ['3']), ['3']);
      assert.deepStrictEqual(state(fileC()), []);
      await checkout('feature');
      assert.deepStrictEqual(await settle(fileC(), ['3']), ['3']);
      git('branch', '-D', 'renamed');
    });

    it('清理已刪除分支的紀錄', async () => {
      git('checkout', '-b', 'temp');
      await fsp.writeFile(fileA().fsPath, text(['# temp', ...feature]));
      git('commit', '-am', 'temp');
      await settle(fileA(), ['7', '16']);
      await checkout('feature');
      await settle(fileA(), ['6', '15']);
      assert.ok(api.store.bookmarksFor(fileA())[0].positions?.temp, '記下了 temp 分支的位置');
      git('branch', '-D', 'temp');
      const removed = await vscode.commands.executeCommand<string[]>('functionBookmarks.cleanBranchRecords', ['temp']);
      assert.deepStrictEqual(removed, ['temp']);
      assert.strictEqual(api.store.bookmarksFor(fileA())[0].positions?.temp, undefined);
      assert.ok(!api.external.snapshotBranches(fileA()).includes('temp'));
    });
  });

  describe('M6：匯出與匯入書籤、來源篩選', () => {
    const fsp = require('fs/promises') as typeof import('fs/promises');
    const fileA = () => workspaceFile('app', 'tmp_share_a.py');
    const relA = 'app/tmp_share_a.py';
    const BASE = [
      'import json',
      '',
      '',
      'def helper(payload):',
      '    data = json.loads(payload)',
      '    return data["value"]',
      '',
      '',
      'def save_article(request):',
      '    article = Article.objects.get(pk=request.POST["id"])',
      '    article.title = request.POST["title"]',
      '    article.save()',
      '    return JsonResponse({"ok": True})',
    ];
    const text = (ls: string[]) => ls.join('\n') + '\n';
    type Exported = { bookmarks: { kind: string; line: number; label?: string; path?: string; anchor?: unknown }[]; files?: Record<string, unknown>; includesCode: boolean };

    /** 自己的書籤：兩個行號書籤（一個有名稱、標籤、備註）＋一個函式書籤。 */
    async function setupMine(): Promise<void> {
      // 先讓外部變動監看處理完「清空書籤」（忘掉上一個測試記住的檔案內容），
      // 否則改檔的事件晚到時，會拿上一個測試的內容換算這次剛加的書籤（CI 偶發）
      await api.external.idle();
      await fsp.writeFile(fileA().fsPath, text(BASE));
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, { id: newBookmarkId(), file: relA, line: 10, label: '改標題', tags: ['article'], note: '要檢查權限', anchor: makeAnchor(BASE, 10) });
        next = addBookmark(next, { id: newBookmarkId(), file: relA, line: 4, anchor: makeAnchor(BASE, 4) });
        return setFavorite(next, { file: relA, path: 'helper', kind: 'function' }, true, 3);
      });
      await api.favorites.refresh();
      await api.external.idle();
    }
    const exportJson = async (includeCode = true) =>
      (await vscode.commands.executeCommand<{ count: number; text: string }>('functionBookmarks.exportBookmarks', {
        folder: folder(),
        scope: { kind: 'all' },
        includeImported: false,
        format: 'json',
        includeCode,
        target: 'clipboard',
      }))!;
    const importText = (t: string, author = 'alex.chen', mode: 'replace' | 'merge' = 'replace') =>
      vscode.commands.executeCommand<{ imported: number; lost: number }>('functionBookmarks.importBookmarks', { text: t, folder: folder(), author, mode, confirmed: true });
    const foreign = () => api.store.bookmarksFor(fileA()).filter((b) => b.source);

    after(async () => {
      await vscode.commands.executeCommand('functionBookmarks.filterBookmarkSources', []);
      await fsp.rm(fileA().fsPath, { force: true });
      await fsp.rm(workspaceFile('tmp_share_export.csv').fsPath, { force: true });
    });

    it('匯出 JSON：行號書籤＋函式書籤、每個檔案的行雜湊、匯出者；複製到剪貼簿', async () => {
      await setupMine();
      const r = await exportJson();
      assert.strictEqual(r.count, 3);
      const data = JSON.parse(r.text) as Exported & { format: string; exportedBy: string };
      assert.strictEqual(data.format, 'function-bookmarks/v1');
      assert.ok(data.exportedBy);
      assert.deepStrictEqual(data.bookmarks.map((b) => [b.kind, b.line, b.label ?? b.path]).sort(), [
        ['line', 10, '改標題'],
        ['line', 4, undefined],
        ['symbol', 3, 'helper'],
      ].sort());
      assert.ok(data.files?.[relA], '附上行雜湊');
      assert.strictEqual(await vscode.env.clipboard.readText(), r.text);
    });

    it('匯入：對方匯出後我這邊的檔案改過，依行雜湊換算到正確位置；函式書籤用名稱找；別人的書籤用紫色、懸停顯示來源', async () => {
      await setupMine();
      const exported = (await exportJson()).text;
      await api.store.update(folder(), () => emptyStore());
      await api.favorites.refresh();
      // 我這邊：上面多了兩行 import，save_article 裡多一行
      const mine = ['import logging', 'import os', ...BASE.slice(0, 10), '    logger.info("saving")', ...BASE.slice(10)];
      await fsp.writeFile(fileA().fsPath, text(mine));
      const r = await importText(exported);
      assert.deepStrictEqual({ imported: r.imported, lost: r.lost }, { imported: 3, lost: 0 });
      const got = foreign().map((b) => [b.line, mine[b.line].trim(), b.source?.author, b.symbol?.path]);
      assert.deepStrictEqual(got, [
        [5, 'def helper(payload):', 'alex.chen', 'helper'],
        [6, 'data = json.loads(payload)', 'alex.chen', undefined],
        [13, 'article.title = request.POST["title"]', 'alex.chen', undefined],
      ]);
      const labeled = foreign().find((b) => b.label === '改標題')!;
      assert.deepStrictEqual([labeled.tags, labeled.note], [['article'], '要檢查權限']);

      await vscode.window.showTextDocument(fileA());
      api.gutter.schedule(0);
      const lines = await waitFor(() => api.gutter.linesFor(fileA(), 'foreign'), (v) => v.length === 3);
      assert.deepStrictEqual(lines, [5, 6, 13]);
      const groups = await api.provider.getChildren(api.provider.sections.bookmarks);
      const g = groups.find((x) => (x as BmGroupNode).rel === relA)!;
      const node = (await api.provider.getChildren(g)).find((n) => (n as BookmarkNode).entry?.bookmark.label === '改標題') as BookmarkNode;
      const item = api.provider.getTreeItem(node);
      assert.ok(String(item.description).includes('@alex.chen'));
      assert.ok(String(item.contextValue).includes(':foreign'));
      assert.ok((item.tooltip as vscode.MarkdownString).value.replace(/\\/g, '').includes('From alex.chen'));
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('同一來源再匯入：取代不會重複；合併時同一筆更新、新的加入；自己的書籤不受影響', async () => {
      await setupMine();
      const exported = (await exportJson()).text;
      await importText(exported);
      await importText(exported);
      assert.strictEqual(foreign().length, 3, '取代');
      const data = JSON.parse(exported) as Exported;
      data.bookmarks.find((b) => b.label === '改標題')!.label = '改標題（新）';
      data.bookmarks.push({ ...data.bookmarks[0], kind: 'line', line: 12, label: '新的', anchor: undefined, path: undefined, id: 'new-one' } as never);
      await importText(JSON.stringify(data), 'alex.chen', 'merge');
      assert.deepStrictEqual(foreign().map((b) => b.label ?? '').sort(), ['', '', '改標題（新）', '新的'].sort());
      assert.strictEqual(api.store.bookmarksFor(fileA()).filter((b) => !b.source).length, 2, '自己的兩個行號書籤還在');
    });

    it('不含程式碼內容：沒有行雜湊與 anchor，匯入時照行號放', async () => {
      await setupMine();
      const t = (await exportJson(false)).text;
      const data = JSON.parse(t) as Exported;
      assert.strictEqual(data.includesCode, false);
      assert.strictEqual(data.files, undefined);
      assert.ok(data.bookmarks.every((b) => b.anchor === undefined));
      assert.ok(!t.includes('Article.objects'), '不含任何程式碼');
      await importText(t, 'amy.lin');
      assert.deepStrictEqual(
        api.store.bookmarksFor(fileA()).filter((b) => b.source?.author === 'amy.lin').map((b) => b.line),
        [3, 4, 10],
      );
    });

    it('篩選來源、依來源分組、上下跳轉只在篩選結果內；修改來源註記、轉成我的、刪除來源', async () => {
      await setupMine();
      await importText((await exportJson()).text);
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksBySource');
      let groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      assert.deepStrictEqual(groups.map((g) => [g.key, g.items.length]), [
        ['', 3],
        ['alex.chen', 3],
      ]);
      await vscode.commands.executeCommand('functionBookmarks.filterBookmarkSources', ['alex.chen']);
      groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      assert.deepStrictEqual(groups.map((g) => g.key), ['']);
      assert.ok(String(api.treeView.description).includes('filtered'));
      await vscode.window.showTextDocument(fileA());
      const visited = new Set<number>();
      for (let i = 0; i < 6; i++) {
        visited.add((await api.bookmarks.go(1))!.line);
      }
      assert.deepStrictEqual([...visited].sort((a, b) => a - b), [3, 4, 10], '只在自己的書籤間跳');
      await vscode.commands.executeCommand('functionBookmarks.filterBookmarkSources', []);

      assert.ok(await vscode.commands.executeCommand('functionBookmarks.renameBookmarkSource', 'alex.chen', 'alex'));
      assert.ok(foreign().every((b) => b.source?.author === 'alex'));
      const one = api.store.allBookmarks().find((e) => e.bookmark.source && e.bookmark.label === '改標題')!;
      await vscode.commands.executeCommand('functionBookmarks.makeBookmarkMine', { type: 'bookmark', entry: one });
      assert.strictEqual(foreign().length, 2);
      assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.deleteBookmarkSource', 'alex', true), 2);
      assert.strictEqual(foreign().length, 0);
      assert.deepStrictEqual(api.store.sources(), []);
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('從剪貼簿匯入；匯出 Markdown 表格與 CSV', async () => {
      await setupMine();
      await vscode.env.clipboard.writeText((await exportJson()).text);
      const r = await vscode.commands.executeCommand<{ imported: number }>('functionBookmarks.importBookmarks', {
        from: 'clipboard',
        folder: folder(),
        author: 'clip',
        confirmed: true,
      });
      assert.strictEqual(r.imported, 3);

      const md = await vscode.commands.executeCommand<{ text: string }>('functionBookmarks.exportBookmarks', {
        folder: folder(),
        scope: { kind: 'tag', tag: 'article' },
        includeImported: true,
        format: 'markdown',
        includeCode: true,
        target: 'clipboard',
      });
      const rows = md.text.trim().split('\n');
      assert.strictEqual(rows.length, 4, '表頭、分隔線、我的與 clip 的各一筆');
      assert.ok(rows[0].includes('Code') && rows[0].includes('Source'));
      assert.ok(md.text.includes('| app/tmp_share_a.py | 11 | 改標題 | #article | 要檢查權限 | `article.title = request.POST["title"]` |'));

      const out = workspaceFile('tmp_share_export.csv');
      await vscode.commands.executeCommand('functionBookmarks.exportBookmarks', {
        folder: folder(),
        scope: { kind: 'path', rel: 'app' },
        includeImported: false,
        format: 'csv',
        includeCode: false,
        target: out,
      });
      const csv = await fsp.readFile(out.fsPath, 'utf8');
      assert.ok(csv.startsWith('﻿File,Line,Name,Kind,Tags,Note,Source'));
      assert.ok(csv.includes('app/tmp_share_a.py,4,helper,function,,,'));
      assert.strictEqual(csv.trim().split('\r\n').length, 4);
    });
  });

  describe('M7：數字快速書籤、顏色、行尾名稱、隱藏圖示、狀態列', () => {
    const fsp = require('fs/promises') as typeof import('fs/promises');
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

    async function at(line: number): Promise<vscode.TextEditor> {
      const editor = await vscode.window.showTextDocument(fileN());
      editor.selection = new vscode.Selection(line, 0, line, 0);
      await api.refreshNow();
      return editor;
    }
    const lineBm = (line: number) => api.store.bookmarksFor(fileN()).find((b) => b.line === line);
    const helperMark = () => api.store.get(fileN(), { path: 'helper', kind: 'function' });
    async function children(): Promise<TreeNode[]> {
      await api.favorites.refresh();
      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const group = groups.find((g) => g.rel === relN);
      return group ? api.provider.getChildren(group) : [];
    }
    const label = (n: TreeNode) => String(api.provider.getTreeItem(n).label);
    const iconColor = (n: TreeNode) => ((api.provider.getTreeItem(n).iconPath as vscode.ThemeIcon).color as unknown as { id: string } | undefined)?.id;

    it('Ctrl+Alt+Shift+數字：沒有書籤的行直接加入並給號碼；側邊欄與行號旁圖示顯示號碼', async () => {
      await at(1);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 3 });
      assert.strictEqual(lineBm(1)?.number, 3);
      const kids = await children();
      assert.ok(kids.some((k) => k.type === 'bookmark' && label(k) === '③ x = 1'), kids.map(label).join(', '));
      await api.gutter.update();
      assert.strictEqual(api.gutter.iconAt(fileN(), 1), 'bookmark|teal|3');
      // 再按一次同一個號碼：拿掉號碼，書籤保留
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 3 });
      assert.ok(lineBm(1));
      assert.strictEqual(lineBm(1)?.number, undefined);
    });

    it('號碼已被使用：確認後移過來（函式名稱那一行建立函式書籤），取消則不動', async () => {
      await at(1);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 2 });
      await at(3);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 2 }, false);
      assert.strictEqual(helperMark()?.favorite, true, '已建立函式書籤');
      assert.strictEqual(helperMark()?.number, undefined, '取消時號碼不移動');
      assert.strictEqual(lineBm(1)?.number, 2);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 2 }, true);
      assert.strictEqual(helperMark()?.number, 2);
      assert.strictEqual(lineBm(1)?.number, undefined, '同一個號碼只留一個');
      const kids = await children();
      assert.ok(kids.some((k) => k.type === 'favorite' && label(k) === '② helper'), kids.map(label).join(', '));
      await api.gutter.update();
      assert.strictEqual(api.gutter.iconAt(fileN(), 3), 'favorite|teal|2');
    });

    it('Ctrl+Alt+數字跳到書籤（行號書籤與函式書籤）；沒有這個號碼時不跳', async () => {
      await at(6);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 5 });
      await at(3);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 1 });
      await at(0);
      const r = await vscode.commands.executeCommand<{ line: number }>('functionBookmarks.goToNumberedBookmark', { number: 5 });
      assert.strictEqual(r?.line, 6);
      assert.strictEqual(vscode.window.activeTextEditor!.selection.active.line, 6);
      await vscode.commands.executeCommand('functionBookmarks.goToNumberedBookmark', { number: 1 });
      assert.strictEqual(vscode.window.activeTextEditor!.selection.active.line, 3, '函式書籤跳到函式名稱');
      assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.goToNumberedBookmark', { number: 9 }), undefined);
      // 從右鍵選單「設定書籤號碼」：下一個空號、拿掉號碼
      const node = (await children()).find((k) => k.type === 'bookmark') as BookmarkNode;
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkNumber', node, null);
      assert.strictEqual(lineBm(6)?.number, undefined);
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkNumber', node, 'next');
      assert.strictEqual(lineBm(6)?.number, 2, '下一個空號（1 已被使用）');
      // 取消函式書籤時號碼一併拿掉
      await at(3);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      assert.strictEqual(helperMark()?.number, undefined);
      assert.ok(!api.store.numbered().has(1));
    });

    it('設定 autoNumber：新增的書籤自動給下一個空號', async () => {
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.autoNumber', true, vscode.ConfigurationTarget.Workspace);
      await at(1);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await at(3);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      assert.strictEqual(lineBm(1)?.number, 1);
      assert.strictEqual(helperMark()?.number, 2);
      // 快捷鍵直接指定號碼時，用指定的號碼（不會因為剛自動給了號碼就當成要拿掉）
      await at(7);
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 3 });
      assert.strictEqual(lineBm(7)?.number, 3);
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.autoNumber', undefined, vscode.ConfigurationTarget.Workspace);
    });

    it('書籤顏色與標籤顏色：書籤自己的顏色優先，其次是標籤的顏色', async () => {
      await at(1);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await at(6);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      let kids = await children();
      const first = kids.find((k) => k.type === 'bookmark' && (k as BookmarkNode).entry.bookmark.line === 1) as BookmarkNode;
      const second = kids.find((k) => k.type === 'bookmark' && (k as BookmarkNode).entry.bookmark.line === 6) as BookmarkNode;
      await api.bookmarks.editTags(first, '#todo');
      await api.bookmarks.editTags(second, '#todo');
      await vscode.commands.executeCommand('functionBookmarks.setTagColor', 'todo', 'green');
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkColor', second, 'red');
      kids = await children();
      const byLine = (l: number) => kids.find((k) => k.type === 'bookmark' && (k as BookmarkNode).entry.bookmark.line === l)!;
      assert.strictEqual(iconColor(byLine(1)), 'charts.green', '用標籤的顏色');
      assert.strictEqual(iconColor(byLine(6)), 'charts.red', '書籤自己的顏色優先');
      await api.gutter.update();
      assert.strictEqual(api.gutter.iconAt(fileN(), 1), 'bookmark|green|');
      assert.strictEqual(api.gutter.iconAt(fileN(), 6), 'bookmark|red|');
      assert.ok((await readStoreFile())?.includes('"tagColors"'), '標籤顏色存在書籤檔');
      // 依標籤分組時，標籤節點也是這個顏色，可從右鍵設定
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByTag');
      const tags = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const todo = tags.find((t) => t.key === 'todo')!;
      assert.strictEqual(api.provider.getTreeItem(todo).contextValue, 'fbBmTag');
      assert.strictEqual(iconColor(todo), 'charts.green');
      await vscode.commands.executeCommand('functionBookmarks.setTagColor', todo, null);
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkColor', second, null);
      await api.gutter.update();
      assert.strictEqual(api.gutter.iconAt(fileN(), 1), 'bookmark|teal|', '清除後恢復預設');
      assert.strictEqual(api.gutter.iconAt(fileN(), 6), 'bookmark|teal|');
    });

    it('需確認的書籤在行號旁用灰色問號圖示，滑鼠提示有需確認說明', async () => {
      const stale = makeAnchor(['deleted_a = 1', 'deleted_b = 2', 'deleted_c = 3'], 1);
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, {
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
      await at(1);
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileN(), 'bookmark'), [1, 6], 'lines 分類維持 bookmark');
      assert.strictEqual(api.gutter.iconAt(fileN(), 1), 'lost|red|');
      assert.strictEqual(api.gutter.iconAt(fileN(), 6), 'lost|teal|2');
      assert.strictEqual(api.gutter.labelAt(fileN(), 6), '②', '行尾仍顯示號碼');
      const hover1 = api.gutter.hoverAt(fileN(), 1);
      assert.ok(hover1, '需確認書籤應有滑鼠提示');
      assert.ok(hover1.startsWith('**待確認項目**'), hover1);
      assert.ok(hover1.includes('#todo'), hover1);
      assert.ok(hover1.includes('The bookmarked line could not be found'), hover1);
      const hover6 = api.gutter.hoverAt(fileN(), 6);
      assert.ok(hover6?.includes('The bookmarked line could not be found'), hover6);

      // 移到游標所在的行後不再是需確認，恢復一般書籤圖示
      const node = (await children()).find((k) => k.type === 'bookmark' && (k as BookmarkNode).entry.bookmark.line === 1) as BookmarkNode;
      await at(7);
      await vscode.commands.executeCommand('functionBookmarks.moveBookmarkToCursor', node);
      await api.gutter.update();
      assert.strictEqual(api.gutter.iconAt(fileN(), 7), 'bookmark|red|');
      assert.strictEqual(api.gutter.hoverAt(fileN(), 7), undefined);
    });

    it('行尾顯示名稱（與號碼），可在設定關閉', async () => {
      await at(6);
      await api.bookmarks.addLabeled('第二個變數');
      await at(1);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await vscode.commands.executeCommand('functionBookmarks.toggleNumberedBookmark', { number: 4 });
      await api.gutter.update();
      assert.strictEqual(api.gutter.labelAt(fileN(), 6), '第二個變數');
      assert.strictEqual(api.gutter.labelAt(fileN(), 1), '④', '沒有名稱時只顯示號碼');
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.showLabelAtLineEnd', false, vscode.ConfigurationTarget.Workspace);
      await api.gutter.update();
      assert.strictEqual(api.gutter.labelAt(fileN(), 6), undefined);
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.showLabelAtLineEnd', undefined, vscode.ConfigurationTarget.Workspace);
    });

    it('暫時隱藏全部圖示；狀態列顯示目前檔案的書籤數與隱藏、篩選狀態', async () => {
      await at(1);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await at(3);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      await api.favorites.refresh();
      api.statusBar.update();
      assert.strictEqual(api.statusBar.text, '$(bookmark) 2');
      await vscode.commands.executeCommand('functionBookmarks.hideBookmarkIcons');
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileN(), 'bookmark'), []);
      assert.deepStrictEqual(api.gutter.linesFor(fileN(), 'favorite'), []);
      assert.ok(api.statusBar.text?.includes('$(eye-closed)'));
      assert.ok(api.store.bookmarksFor(fileN()).length === 1, '書籤不受影響');
      await vscode.commands.executeCommand('functionBookmarks.showBookmarkIcons');
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileN(), 'bookmark'), [1]);
      assert.deepStrictEqual(api.gutter.linesFor(fileN(), 'favorite'), [3]);
      await vscode.commands.executeCommand('functionBookmarks.filterBookmarkSources', ['someone']);
      api.statusBar.update();
      assert.ok(api.statusBar.text?.includes('$(filter)'));
      await vscode.commands.executeCommand('functionBookmarks.filterBookmarkSources', []);
      api.statusBar.update();
      assert.strictEqual(api.statusBar.text, '$(bookmark) 2');
    });
  });

  describe('更多語言：C／C++、Rust、Go、Java、C#、Kotlin、Swift、PHP、Ruby', () => {
    after(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    const tops = () => names(api.provider.currentSymbolNodes);

    it('開檔後側邊欄列出函式與類別', async () => {
      const expect: [string, unknown[]][] = [
        ['sample.c', ['point', 'add', 'make_point', 'color', 'main']],
        ['App.jsx', [{ App: ['handleClick', 'renderItem'] }, 'Header', 'Footer', 'Card', 'Input', { Legacy: ['handleInc', 'componentDidMount', 'render'] }, { useCounter: ['inc'] }]],
        ['Panel.tsx', [{ App: ['handleClick', 'renderItem'] }, 'Header', 'Footer', 'Card', 'Input', { Legacy: ['handleInc', 'componentDidMount', 'render'] }, { useCounter: ['inc'] }]],
        ['point.rs', ['Point', 'Meters', { Point: ['new', 'first'] }, { 'fmt::Display for Point': ['fmt'] }, { Shape: ['name'] }, 'Command', { tests: ['it_works'] }, 'run', 'square']],
        ['server.go', ['Server', 'Handler', 'NewServer', 'Server.Start', 'Server.Addr', 'Map']],
        ['controller.php', [{ Controller: ['__construct', 'index'] }, 'helper']],
        ['invoice.rb', [{ Billing: [{ Invoice: ['self.create_for', 'total', 'paid?', 'notes'] }] }, 'helper']],
        ['UserService.java', [{ UserService: ['run', 'UserService', 'findAll', 'group', 'text', 'Status', 'Pair'] }]],
        ['OrderService.cs', [{ 'App.Services': [{ OrderService: ['OrderService', 'Index', 'Sum', 'Find'] }, 'Money', 'Point'] }]],
        // 沒有 Kotlin 擴充時編輯器把它當成純文字，改用副檔名判斷
        ['Repo.kt', ['User', { Repo: ['load', 'second', 'create'] }, 'main']],
      ];
      for (const [file, want] of expect) {
        await open(workspaceFile('langs', file), api);
        assert.deepStrictEqual(tops(), want, file);
      }
      await open(workspaceFile('langs', 'widget.cpp'), api);
      const app = tops()[0] as Record<string, unknown[]>;
      assert.ok(JSON.stringify(app.app).includes('Widget::paint'), JSON.stringify(app));
    });

    it('Protocol Buffers、Vue、Svelte、Shell、SQL：開檔後側邊欄列出（沒有對應擴充時依副檔名判斷）', async () => {
      const expect: [string, unknown[]][] = [
        ['greeter.proto', [{ Greeter: ['SayHello', 'Watch', 'WithOptions'] }, { HelloRequest: ['Inner', 'Mood', 'choice'] }, 'HelloReply', 'google.protobuf.MessageOptions']],
        ['Counter.vue', ['save', 'reset']],
        ['Widget.svelte', ['preload', 'increment']],
        ['deploy.sh', ['log', 'deploy', 'cleanup']],
        ['schema.sql', ['public.add_one', 'active_users', 'trg_audit']],
      ];
      for (const [file, want] of expect) {
        await open(workspaceFile('langs', file), api);
        assert.deepStrictEqual(tops(), want, file);
      }
      const keys = (await api.collectProjectSymbols()).map((e) => `${e.rel}:${e.symbol.path}`);
      for (const k of ['langs/greeter.proto:Greeter.SayHello', 'langs/Counter.vue:save', 'langs/Widget.svelte:increment', 'langs/deploy.sh:deploy', 'langs/schema.sql:public.add_one']) {
        assert.ok(keys.includes(k), `${k} 不在整個專案的清單中`);
      }
    });

    it('整個專案與搜尋函式包含新語言的檔案（不必開檔）', async () => {
      const keys = (await api.collectProjectSymbols()).map((e) => `${e.rel}:${e.symbol.path}`);
      for (const k of ['langs/point.rs:Point.new', 'langs/server.go:Server.Start', 'langs/invoice.rb:Billing.Invoice.total', 'langs/Repo.kt:Repo.load', 'langs/ViewController.swift:ViewController.viewDidLoad']) {
        assert.ok(keys.includes(k), `${k} 不在清單中`);
      }
    });

    it('函式書籤：Rust 方法改名後仍找得到', async () => {
      const fsp = require('fs/promises') as typeof import('fs/promises');
      const file = workspaceFile('langs', 'tmp_rename.rs');
      await fsp.writeFile(file.fsPath, 'struct A;\nimpl A {\n    fn old_name(&self) -> i32 {\n        1\n    }\n}\n');
      try {
        const editor = await open(file, api);
        editor.selection = new vscode.Selection(2, 4, 2, 4);
        await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
        await api.favorites.refresh();
        assert.deepStrictEqual(api.favorites.all.map((f) => f.mark.path), ['A.old_name']);
        await editor.edit((e) => e.replace(new vscode.Range(2, 7, 2, 15), 'new_name'));
        await api.refreshNow();
        const found = await waitFor(
          async () => {
            await api.favorites.refresh();
            return api.favorites.all.map((f) => `${f.mark.path}:${f.status}`);
          },
          (v) => v.includes('A.new_name:ok'),
        );
        assert.deepStrictEqual(found, ['A.new_name:ok']);
      } finally {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await fsp.rm(file.fsPath, { force: true });
      }
    });
  });

  describe('M8：測試偵測規則、設定整理', () => {
    after(async () => {
      api.ruleTester.stop();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('在目前檔案標示每條規則抓到的函式；再執行一次關閉', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      const hits = await vscode.commands.executeCommand<{ ruleId: string; name: string; nameLine: number }[]>('functionBookmarks.testDetectionRules');
      assert.ok(hits, '應有結果');
      const got = hits.map((h) => `${h.ruleId}:${h.name}:${h.nameLine}`);
      assert.ok(got.includes('py-def:index:4'), got.join(', '));
      assert.ok(got.some((g) => g.startsWith('py-class:ArticleView:')), got.join(', '));
      assert.ok(got.some((g) => g.endsWith(':get:11')), got.join(', '));
      assert.ok(api.ruleTester.testing);
      // 編輯後自動更新
      const editor = vscode.window.activeTextEditor!;
      await editor.edit((e) => e.insert(new vscode.Position(0, 0), 'def added():\n    pass\n'));
      const after = await waitFor(
        () => api.ruleTester.results,
        (r) => r.some((h) => h.name === 'added'),
      );
      assert.ok(after.some((h) => h.name === 'added' && h.nameLine === 0));
      await vscode.commands.executeCommand('undo');
      await vscode.commands.executeCommand('functionBookmarks.testDetectionRules');
      assert.strictEqual(api.ruleTester.testing, undefined, '再執行一次關閉');
      assert.deepStrictEqual(api.ruleTester.results, []);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    });

    it('側邊欄圖示用字型圖示（在工具列的亮度才會和內建圖示一致），字型檔有打包', async () => {
      const ext = findExtension()!;
      const pkg = ext.packageJSON as {
        contributes: { viewsContainers: { activitybar: { icon: string }[] }; icons: Record<string, { default: { fontPath: string; fontCharacter: string } }> };
      };
      assert.strictEqual(pkg.contributes.viewsContainers.activitybar[0].icon, '$(function-bookmarks-logo)');
      const font = pkg.contributes.icons['function-bookmarks-logo'].default;
      assert.strictEqual(font.fontCharacter.length, 5, 'fontCharacter 應為反斜線加 4 碼');
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ext.extensionUri, font.fontPath));
      assert.strictEqual(new TextDecoder('latin1').decode(bytes.slice(0, 4)), 'wOFF');
    });

    it('設定分成幾個分類並有順序；每個指令在命令選擇區都有分類', () => {
      const pkg = findExtension()!.packageJSON as {
        contributes: { configuration: { title: string; properties: Record<string, { order?: number }> }[]; commands: { category?: string }[] };
      };
      assert.ok(Array.isArray(pkg.contributes.configuration) && pkg.contributes.configuration.length >= 4);
      for (const group of pkg.contributes.configuration) {
        for (const [k, v] of Object.entries(group.properties)) {
          assert.strictEqual(typeof v.order, 'number', `${k} 沒有 order`);
        }
      }
      assert.ok(pkg.contributes.commands.every((c) => c.category));
      const all = Object.assign({}, ...pkg.contributes.configuration.map((g) => g.properties));
      for (const k of ['functionBookmarks.bookmarks.autoNumber', 'functionBookmarks.bookmarks.showLabelAtLineEnd', 'functionBookmarks.statusBar.enabled']) {
        assert.ok(k in all, k);
      }
    });
  });

  describe('M2：Django template 連結與繼承', () => {
    it('點擊 extends 開啟父 template；include 開啟被引入的 template', async () => {
      await open(workspaceFile('app', 'templates', 'app', 'login.html'), api);
      const ext = api.provider.currentSymbolNodes[0];
      await api.commands.openTemplate(ext);
      assert.ok(vscode.window.activeTextEditor!.document.uri.path.endsWith('templates/base.html'));
      await open(workspaceFile('app', 'templates', 'app', 'login.html'), api);
      const inc = findNode(api.provider.currentSymbolNodes, 'content.partials/nav.html')!;
      await api.commands.openTemplate(inc);
      assert.ok(vscode.window.activeTextEditor!.document.uri.path.endsWith('templates/partials/nav.html'));
    });

    it('覆寫父 template 的 block：顯示「覆寫 base.html」，可跳到父 template 的同名 block', async () => {
      await open(workspaceFile('app', 'templates', 'app', 'login.html'), api);
      const content = findNode(api.provider.currentSymbolNodes, 'content')!;
      assert.ok(content.override, '應標示覆寫');
      assert.ok(String(api.provider.getTreeItem(content).description).includes('base.html'));
      assert.strictEqual(findNode(api.provider.currentSymbolNodes, 'content.form')?.override, undefined, 'form 是新 block');
      await vscode.commands.executeCommand('functionBookmarks.goToParentBlock', content);
      const editor = vscode.window.activeTextEditor!;
      assert.ok(editor.document.uri.path.endsWith('templates/base.html'));
      assert.strictEqual(editor.document.getText(editor.selection), 'content');
    });
  });

  describe('Review 修正：來源篩選、不在此分支、分組檔名、快速切換', () => {
    const fsp = require('fs/promises') as typeof import('fs/promises');
    const fileR = () => workspaceFile('app', 'tmp_review.py');
    const relR = 'app/tmp_review.py';
    const LINES = ['def alpha():', '    x = 1', '    return x', '', 'x_global = 1', 'y_global = 2', 'def beta():', '    return 2', ''];
    const config = () => vscode.workspace.getConfiguration('functionBookmarks');
    const alphaKey = { file: relR, path: 'alpha', kind: 'function' as const };
    const betaKey = { file: relR, path: 'beta', kind: 'function' as const };
    const source = (author: string) => ({ author, importId: 'i1', originalId: newBookmarkId(), importedAt: '2026-01-01T00:00:00.000Z' });
    const lineBms = () => api.store.bookmarksFor(fileR());
    const sectionDesc = () => String(api.provider.getTreeItem(api.provider.sections.bookmarks).description);
    const groupsOf = async () => (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];

    /** 自己的行號書籤（line 4）、自己的函式書籤（alpha）、別人 bob 的行號書籤（line 5）。 */
    async function setupThree(): Promise<void> {
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, { id: newBookmarkId(), file: relR, line: 4, anchor: makeAnchor(LINES, 4) });
        next = addBookmark(next, { id: newBookmarkId(), file: relR, line: 5, anchor: makeAnchor(LINES, 5), source: source('bob') });
        return setFavorite(next, alphaKey, true, 0);
      });
      await api.favorites.refresh();
    }
    async function openR(line = 0): Promise<vscode.TextEditor> {
      const editor = await open(fileR(), api);
      editor.selection = new vscode.Selection(line, 0, line, 0);
      return editor;
    }

    before(async () => {
      await fsp.writeFile(fileR().fsPath, LINES.join('\n'));
    });
    afterEach(async () => {
      api.store.setHiddenSources([]);
      await config().update('bookmarks.onLineDelete', undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fsp.writeFile(fileR().fsPath, LINES.join('\n'));
    });
    after(async () => {
      api.store.setHiddenSources([]);
      await fsp.rm(fileR().fsPath, { force: true });
    });

    it('隱藏「我的」：函式書籤與行號書籤從側邊欄、標題數字、行號圖示、上下跳轉、狀態列一起消失', async () => {
      await setupThree();
      await openR(0);
      await api.gutter.update();
      api.statusBar.update();
      assert.strictEqual(sectionDesc(), '3');
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), [0]);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'bookmark'), [4]);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'foreign'), [5]);
      assert.strictEqual(api.statusBar.text, '$(bookmark) 3');

      api.store.setHiddenSources(['']);
      await api.gutter.update();
      api.statusBar.update();
      const groups = await groupsOf();
      assert.deepStrictEqual(groups.map((g) => g.items.length), [1], '書籤區只剩 bob 的一筆');
      const kids = await api.provider.getChildren(groups[0]);
      assert.deepStrictEqual(kids.map((k) => k.type), ['bookmark']);
      assert.strictEqual((kids[0] as BookmarkNode).entry.bookmark.source?.author, 'bob');
      assert.strictEqual(sectionDesc(), '1', '標題數字只算看得到的');
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), [], '函式書籤的圖示消失');
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'bookmark'), [], '自己的行號書籤圖示消失');
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'foreign'), [5]);
      assert.ok(api.statusBar.text?.startsWith('$(bookmark) 1 '), api.statusBar.text);
      for (let i = 0; i < 3; i++) {
        assert.strictEqual((await api.bookmarks.go(1))?.line, 5, '上下跳轉只會跳到 bob 的書籤');
      }
      assert.strictEqual((await api.bookmarks.go(-1))?.line, 5);

      api.store.setHiddenSources([]);
      await api.gutter.update();
      assert.strictEqual(sectionDesc(), '3');
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), [0]);
    });

    it('隱藏「我的」：有備註的函式書籤不會改顯示成備註圖示；只有備註（沒加書籤）的函式照常顯示備註圖示', async () => {
      await setupThree();
      await api.store.update(folder(), (d) => setNote(setNote(d, alphaKey, 'alpha 的備註', 0), betaKey, 'beta 的備註', 6));
      await api.favorites.refresh();
      await openR(0);
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), [0]);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'note'), [6], 'beta 只有備註');

      api.store.setHiddenSources(['']);
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), []);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'note'), [6], '被隱藏的函式書籤 alpha 不顯示備註圖示');
    });

    it('隱藏 bob：自己的函式書籤與行號書籤照常顯示', async () => {
      await setupThree();
      await openR(0);
      api.store.setHiddenSources(['bob']);
      await api.gutter.update();
      assert.strictEqual(sectionDesc(), '2');
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), [0]);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'foreign'), []);
    });

    describe('不在此分支（notOnBranch）的書籤不會被誤刪、誤改', () => {
      /** 把指定行的書籤標成「不在此分支」（不一定要真的切分支）。 */
      async function plantAway(line = 4): Promise<string> {
        const id = newBookmarkId();
        // 真正不在此分支的書籤，那一行的內容和 anchor 對不上（內容相符時會被當成已找回而恢復）
        const other = ['feature_a()', 'feature_b()', 'feature_c()', 'feature_d()', 'feature_e()', 'feature_f()', 'feature_g()'];
        await api.store.update(folder(), (d) => addBookmark(d, { id, file: relR, line, anchor: makeAnchor(other, line), status: 'notOnBranch' }));
        return id;
      }
      const away = (id: string) => lineBms().find((b) => b.id === id);

      it('在同一行切換書籤：只新增自己的，不刪除不在此分支的那個', async () => {
        const id = await plantAway(4);
        await openR(4);
        await api.bookmarks.toggle({ uri: fileR(), line: 4 });
        const list = lineBms();
        assert.strictEqual(list.length, 2);
        assert.strictEqual(away(id)?.status, 'notOnBranch');
        assert.ok(list.some((b) => b.id !== id && b.line === 4 && b.status === undefined), '新增了自己的書籤');
        // 再切換一次：只拿掉自己的，不在此分支的仍在
        await api.bookmarks.toggle({ uri: fileR(), line: 4 });
        assert.deepStrictEqual(lineBms().map((b) => b.id), [id]);
        assert.strictEqual(away(id)?.status, 'notOnBranch');
      });

      for (const mode of ['remove', 'markLost'] as const) {
        it(`刪除那一行（onLineDelete = ${mode}）：自己的書籤依設定處理，不在此分支的不刪除、狀態不變`, async () => {
          await config().update('bookmarks.onLineDelete', mode, vscode.ConfigurationTarget.Workspace);
          const awayId = await plantAway(4);
          const mineId = newBookmarkId();
          await api.store.update(folder(), (d) => addBookmark(d, { id: mineId, file: relR, line: 4, anchor: makeAnchor(LINES, 4) }));
          const editor = await openR(4);
          await api.external.idle();
          assert.ok(await editor.edit((b) => b.delete(new vscode.Range(3, 0, 4, LINES[4].length))));
          const mine = await waitFor(
            () => lineBms().find((b) => b.id === mineId),
            (v) => (mode === 'remove' ? v === undefined : v?.status === 'lost'),
          );
          if (mode === 'remove') {
            assert.strictEqual(mine, undefined, '自己的書籤被刪除');
          } else {
            assert.strictEqual(mine?.status, 'lost', '自己的書籤標成需確認');
          }
          const kept = away(awayId);
          assert.ok(kept, '不在此分支的書籤還在');
          assert.strictEqual(kept.status, 'notOnBranch');
        });
      }

      it('清除檔案、清除全部：保留不在此分支與被來源篩選隱藏的書籤', async () => {
        await setupThree();
        const awayId = await plantAway(1);
        await openR(0);
        api.store.setHiddenSources(['bob']);
        await api.bookmarks.clearFile(fileR(), true);
        assert.strictEqual(lineBms().length, 2, '剩下不在此分支與 bob 的');
        assert.strictEqual(away(awayId)?.status, 'notOnBranch');
        assert.ok(lineBms().some((b) => b.source?.author === 'bob'), '被隱藏的 bob 書籤保留');
        await api.favorites.refresh();
        assert.strictEqual(api.favorites.all.length, 0, '自己的函式書籤被清除');

        // clearAll：同理
        await api.store.update(folder(), (d) => setFavorite(addBookmark(d, { id: newBookmarkId(), file: relR, line: 5, anchor: makeAnchor(LINES, 5) }), betaKey, true, 6));
        await api.favorites.refresh();
        await api.bookmarks.clearAll(true);
        await api.favorites.refresh();
        assert.strictEqual(lineBms().length, 2);
        assert.strictEqual(away(awayId)?.status, 'notOnBranch');
        assert.ok(lineBms().some((b) => b.source?.author === 'bob'));
        assert.strictEqual(api.favorites.all.length, 0);
      });

      it('「我的」被隱藏時清除檔案、清除全部：只清除看得到的，看不到的函式書籤與行號書籤保留', async () => {
        await setupThree();
        await openR(0);
        api.store.setHiddenSources(['']);
        await api.bookmarks.clearFile(fileR(), true);
        // 看得到的（bob 的）被清掉；看不到的（自己的行號書籤與函式書籤）保留
        assert.deepStrictEqual(lineBms().map((b) => [b.line, b.source?.author]), [[4, undefined]], '自己的行號書籤沒被清掉');
        assert.ok(api.store.get(fileR(), alphaKey)?.favorite, '自己的函式書籤沒被清掉');
        await api.bookmarks.clearAll(true);
        assert.strictEqual(lineBms().length, 1, '整個畫面上沒有書籤，什麼都不清');
        assert.ok(api.store.get(fileR(), alphaKey)?.favorite);
        // 顯示出來之後清除：全部清掉
        api.store.setHiddenSources([]);
        await api.bookmarks.clearAll(true);
        await api.favorites.refresh();
        assert.strictEqual(lineBms().length, 0);
        assert.strictEqual(api.favorites.all.length, 0);
      });
    });

    describe('「我的」被隱藏時新增書籤：不改篩選，提示可以顯示', () => {
      it('在函式名稱那一行切換：新增函式書籤，篩選不變並提示', async () => {
        await openR(6);
        api.store.setHiddenSources(['']);
        const before = api.bookmarks.mineHiddenNotices;
        await api.bookmarks.toggle({ uri: fileR(), line: 6 });
        assert.ok(api.store.get(fileR(), betaKey)?.favorite);
        assert.ok(api.store.hiddenSourceList.includes(''), '篩選不自動改');
        assert.strictEqual(api.bookmarks.mineHiddenNotices, before + 1, '有提示');
      });

      it('原本已是函式書籤：看不到時按切換不會取消，只提示', async () => {
        await api.store.update(folder(), (d) => setFavorite(d, alphaKey, true, 0));
        await api.favorites.refresh();
        await openR(0);
        api.store.setHiddenSources(['']);
        const before = api.bookmarks.mineHiddenNotices;
        await api.bookmarks.toggle({ uri: fileR(), line: 0 });
        await api.favorites.refresh();
        assert.ok(api.store.get(fileR(), alphaKey)?.favorite, '沒有被取消');
        assert.strictEqual(api.bookmarks.mineHiddenNotices, before + 1);
        // 「我的」顯示著再按一次才是取消
        api.store.setHiddenSources([]);
        await api.bookmarks.toggle({ uri: fileR(), line: 0 });
        assert.ok(!api.store.get(fileR(), alphaKey)?.favorite);
      });

      it('在一般行切換：新增行號書籤；那一行已有看不到的自己的書籤時不重複新增、也不拿掉', async () => {
        await openR(5);
        api.store.setHiddenSources(['']);
        await api.bookmarks.toggle({ uri: fileR(), line: 5 });
        assert.deepStrictEqual(lineBms().map((b) => b.line), [5]);
        assert.ok(api.store.hiddenSourceList.includes(''));
        await api.bookmarks.toggle({ uri: fileR(), line: 5 });
        assert.deepStrictEqual(lineBms().map((b) => b.line), [5], '再按一次：看不到的書籤保留，也沒有多一個');
      });

      it('設定號碼：隱藏中也能對剛加的書籤設定', async () => {
        await openR(5);
        api.store.setHiddenSources(['']);
        await api.extras.setNumber({ type: 'line', uri: fileR(), line: 5 }, 7, true);
        const b = lineBms().find((x) => x.line === 5);
        assert.strictEqual(b?.number, 7);
        assert.ok(api.store.hiddenSourceList.includes(''));
      });
    });

    it('依來源分組：行號書籤與函式書籤都顯示「檔名:行號」；依檔案分組只有行號', async () => {
      await setupThree();
      await openR(0);
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksBySource');
      const groups = await groupsOf();
      assert.deepStrictEqual(groups.map((g) => g.key), ['', 'bob']);
      const descOf = async (g: BmGroupNode) =>
        Promise.all((await api.provider.getChildren(g)).map(async (n) => [n.type, String(api.provider.getTreeItem(n).description)] as const));
      const mine = await descOf(groups[0]);
      assert.strictEqual(mine.length, 2);
      const favDesc = mine.find(([t]) => t === 'favorite')![1];
      const lineDesc = mine.find(([t]) => t === 'bookmark')![1];
      assert.ok(favDesc.includes('tmp_review.py:1'), favDesc);
      assert.ok(lineDesc.includes('tmp_review.py:5'), lineDesc);
      const bob = await descOf(groups[1]);
      assert.ok(bob[0][1].includes('tmp_review.py:6'), bob[0][1]);

      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
      const byFile = await groupsOf();
      assert.deepStrictEqual(byFile.map((g) => g.rel), [relR]);
      for (const [, d] of await descOf(byFile[0])) {
        assert.ok(!d.includes('tmp_review.py'), `依檔案分組不重複檔名：${d}`);
      }
    });

    it('快速切換分頁：連續 refresh 兩個編輯器不等第一個，最後顯示的是第二個', async () => {
      const a = await open(workspaceFile('app', 'views.py'), api);
      const b = await open(fileR(), api);
      const sameFile = (u: vscode.Uri | undefined, want: vscode.Uri) => u?.toString() === want.toString();
      const p1 = api.provider.refresh(a);
      const p2 = api.provider.refresh(b);
      await Promise.all([p1, p2]);
      assert.ok(sameFile(api.provider.currentFile?.uri, b.document.uri), '最後一次 refresh 的檔案');
      // 反過來
      const p3 = api.provider.refresh(b);
      const p4 = api.provider.refresh(a);
      await Promise.all([p3, p4]);
      assert.ok(sameFile(api.provider.currentFile?.uri, a.document.uri));
      assert.deepStrictEqual(names(api.provider.currentSymbolNodes), ['index', { ArticleView: ['get', 'post'] }]);
    });
  });

  describe('常駐搜尋列', () => {
    const fsp = require('fs/promises') as typeof import('fs/promises');
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
    const labelOf = (item: vscode.TreeItem) => (typeof item.label === 'string' ? item.label : (item.label?.label ?? ''));
    type Row = { label: string; node: TreeNode; item: vscode.TreeItem; group: BmGroupNode };
    /** 目前側邊欄「書籤」區列出的全部書籤，依顯示順序（分組依序、組內依序）。 */
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
    /** 搜尋後列出的書籤名稱（依顯示順序）。 */
    async function find(query: string): Promise<string[]> {
      api.searchBox.setQuery(query);
      return labels();
    }
    const sorted = (a: string[]) => [...a].sort();

    // b1 價格計算、b2 return 2（沒有名稱，顯示那一行程式碼）、b3 return "lid"（bob 的）、b4 mail sender、f priceEntry（函式書籤 alpha 的自訂名稱）
    const NAMES = { f: 'priceEntry', b1: '價格計算', b2: 'return 2', b3: 'return "lid"', b4: 'mail sender' };
    /** 沒有搜尋時的顯示順序：檔案 a 的（第 0 行的函式書籤、第 1、5、9 行），再來檔案 b。 */
    const ALL = [NAMES.f, NAMES.b1, NAMES.b2, NAMES.b3, NAMES.b4];

    /**
     * 自己的：行號書籤 b1（名稱、標籤 pricing todo、備註）、b2（標籤 api）、b4（另一個檔案）、函式書籤 alpha（自訂名稱、標籤 pricing、備註）；
     * bob 的：b3（標籤 todo）。
     */
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
      // 不管測試成功或失敗，都把搜尋清空，避免影響其他測試
      api.searchBox.setQuery('');
      api.provider.setQuery('');
      api.store.setHiddenSources([]);
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
    });

    after(async () => {
      api.searchBox.setQuery('');
      await fsp.rm(fileA().fsPath, { force: true });
      await fsp.rm(fileB().fsPath, { force: true });
    });

    it('setQuery：回傳有沒有變、有變才通知重畫；只有空白或單獨的 #、@ 不算搜尋', () => {
      assert.strictEqual(api.provider.query, '');
      assert.strictEqual(api.provider.searching, false);
      let fired = 0;
      const sub = api.provider.onDidChangeTreeData(() => fired++);
      try {
        assert.strictEqual(api.provider.setQuery(''), false, '空的再設空的：沒變');
        assert.strictEqual(fired, 0);
        assert.strictEqual(api.provider.setQuery('Login'), true);
        assert.strictEqual(fired, 1);
        assert.strictEqual(api.provider.query, 'Login', 'query 原樣保留（不轉小寫、不去空白）');
        assert.strictEqual(api.provider.searching, true);
        assert.strictEqual(api.provider.setQuery('Login'), false, '同樣的字串：沒變');
        assert.strictEqual(fired, 1);
        for (const q of ['   ', '#', '@', '# @']) {
          assert.strictEqual(api.provider.setQuery(q), true);
          assert.strictEqual(api.provider.query, q);
          assert.strictEqual(api.provider.searching, false, `「${q}」不算搜尋`);
        }
        assert.strictEqual(api.provider.setQuery(''), true);
        assert.strictEqual(api.provider.searching, false);
      } finally {
        sub.dispose();
      }
    });

    it('沒有搜尋時：全部書籤照原樣列出，沒有 :search 的分組 id', async () => {
      await setup();
      assert.deepStrictEqual(await labels(), ALL);
      for (const g of await groupsOf()) {
        assert.ok(!String(api.provider.getTreeItem(g).id).endsWith(':search'), String(api.provider.getTreeItem(g).id));
      }
      assert.strictEqual(String(sectionItem().description), '5');
      assert.strictEqual((sectionItem().iconPath as vscode.ThemeIcon).id, 'bookmark');
    });

    it('只有單獨的 # 或 @ 不算搜尋：列出全部、分組 id 不加 :search', async () => {
      await setup();
      assert.deepStrictEqual(await find('# @'), ALL);
      assert.ok((await groupsOf()).every((g) => !String(api.provider.getTreeItem(g).id).endsWith(':search')));
      assert.strictEqual(String(sectionItem().description), '5');
    });

    it('依名稱搜尋：書籤名稱、函式書籤的自訂名稱與原名、沒有名稱時顯示的那一行程式碼；不分大小寫、部分比對', async () => {
      await setup();
      assert.deepStrictEqual(await find('價格'), [NAMES.b1], '行號書籤的名稱');
      assert.deepStrictEqual(await find('SENDER'), [NAMES.b4], '不分大小寫');
      assert.deepStrictEqual(await find('priceentry'), [NAMES.f], '函式書籤的自訂名稱');
      assert.deepStrictEqual(sorted(await find('alpha')), sorted([NAMES.f, NAMES.b1]), '函式書籤的原名（自訂名稱底下）；也比對書籤所在的函式 alpha');
      assert.deepStrictEqual(await find('return 2'), [NAMES.b2], '沒有名稱的書籤：顯示的是那一行程式碼');
      assert.deepStrictEqual(await find('nothing_like_this'), []);
    });

    it('依標籤搜尋（不加 #）：行號書籤與函式書籤的標籤文字都比對', async () => {
      await setup();
      assert.deepStrictEqual(await find('pricing'), [NAMES.f, NAMES.b1]);
      assert.deepStrictEqual(await find('API'), [NAMES.b2]);
      assert.deepStrictEqual(await find('tod'), [NAMES.b1, NAMES.b3], '部分比對');
    });

    it('依檔名搜尋（相對路徑）', async () => {
      await setup();
      assert.deepStrictEqual(await find('find_b'), [NAMES.b4]);
      assert.deepStrictEqual(await find('app/tmp_find_a'), [NAMES.f, NAMES.b1, NAMES.b2, NAMES.b3]);
      assert.deepStrictEqual(await find('TMP_FIND'), ALL);
    });

    it('依所在函式搜尋：行號書籤所在的函式路徑、函式書籤本身的路徑', async () => {
      await setup();
      assert.deepStrictEqual(await find('beta'), [NAMES.b2], '書籤在 beta 裡');
      assert.deepStrictEqual(await find('box.open'), [NAMES.b3], '函式路徑 Box.open');
      assert.deepStrictEqual(await find('gamma'), [NAMES.b4]);
    });

    it('依該行程式碼搜尋', async () => {
      await setup();
      assert.deepStrictEqual(await find('compute_price'), [NAMES.b1]);
      assert.deepStrictEqual(await find('send_mail'), [NAMES.b4]);
      assert.deepStrictEqual(await find('"lid"'), [NAMES.b3]);
    });

    it('依備註搜尋：行號書籤與函式書籤的備註', async () => {
      await setup();
      assert.deepStrictEqual(await find('rounding'), [NAMES.b1]);
      assert.deepStrictEqual(await find('POINT'), [NAMES.f]);
    });

    it('空白隔開的每個字都要符合（可分散在不同欄位）', async () => {
      await setup();
      assert.deepStrictEqual(await find('價格 rounding'), [NAMES.b1], '名稱＋備註');
      assert.deepStrictEqual(await find('find_a return'), [NAMES.b2, NAMES.b3], '檔名＋程式碼');
      assert.deepStrictEqual(await find('find_b return'), []);
      assert.deepStrictEqual(await find('  return   lid  '), [NAMES.b3], '多餘的空白忽略');
    });

    it('#標籤：只比對標籤；多個 #標籤 每個都要有；與一般文字並用', async () => {
      await setup();
      assert.deepStrictEqual(await find('#todo'), [NAMES.b1, NAMES.b3]);
      assert.deepStrictEqual(await find('#TOD'), [NAMES.b1, NAMES.b3], '不分大小寫、部分比對');
      assert.deepStrictEqual(await find('#pricing'), [NAMES.f, NAMES.b1], '函式書籤的標籤也算');
      assert.deepStrictEqual(await find('#pricing #todo'), [NAMES.b1]);
      assert.deepStrictEqual(await find('#pricing #api'), []);
      assert.deepStrictEqual(await find('#alpha'), [], '#只比對標籤，不比對名稱或函式');
      assert.deepStrictEqual(await find('#todo return'), [NAMES.b3], '標籤＋一般文字');
      assert.deepStrictEqual(await find('# api'), [NAMES.b2], '單獨一個 # 忽略');
    });

    it('@來源：只找那個人匯入的書籤；多個符合任一；自己的書籤找不到', async () => {
      await setup();
      assert.deepStrictEqual(await find('@bob'), [NAMES.b3]);
      assert.deepStrictEqual(await find('@BO'), [NAMES.b3], '不分大小寫、部分比對');
      assert.deepStrictEqual(await find('@alice'), []);
      assert.deepStrictEqual(await find('@alice @bob'), [NAMES.b3], '符合任一個');
      assert.deepStrictEqual(await find('@bob return'), [NAMES.b3]);
      assert.deepStrictEqual(await find('@bob price'), []);
      assert.deepStrictEqual(await find('@bob #todo'), [NAMES.b3]);
      assert.deepStrictEqual(await find('@bob #api'), []);
      assert.deepStrictEqual(await find('@mail'), [], '自己的書籤沒有來源，名稱裡有 mail 也不會被 @ 找到');
      assert.deepStrictEqual(await find('@ api'), [NAMES.b2], '單獨一個 @ 忽略');
    });

    it('標題的計數：「{0} of {1} match」，沒有搜尋時是總數；沒結果時是 0；圖示在搜尋時換成放大鏡', async () => {
      await setup();
      assert.strictEqual(String(sectionItem().description), '5');
      api.searchBox.setQuery('#todo');
      assert.strictEqual(String(sectionItem().description), '2 of 5 match');
      assert.strictEqual((sectionItem().iconPath as vscode.ThemeIcon).id, 'search');
      assert.strictEqual(sectionItem().collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      api.searchBox.setQuery('tmp_find');
      assert.strictEqual(String(sectionItem().description), '5 of 5 match');
      api.searchBox.setQuery('zzz_nothing');
      assert.strictEqual(String(sectionItem().description), '0 of 5 match');
      assert.deepStrictEqual(await groupsOf(), [], '沒有結果：不列任何分組');
      api.searchBox.setQuery('');
      assert.strictEqual(String(sectionItem().description), '5');
      assert.strictEqual((sectionItem().iconPath as vscode.ThemeIcon).id, 'bookmark');
    });

    it('標題的計數：被來源篩選隱藏的書籤不算在總數裡，搜尋也找不到', async () => {
      await setup();
      api.store.setHiddenSources(['bob']);
      assert.deepStrictEqual(await find('#todo'), [NAMES.b1]);
      assert.strictEqual(String(sectionItem().description), '1 of 4 match');
      assert.deepStrictEqual(await find('@bob'), []);
      assert.strictEqual(String(sectionItem().description), '0 of 4 match');
    });

    it('符合的字用 highlights 標亮：名稱、不分大小寫、多個字、沒符合名稱時不標', async () => {
      await setup();
      const labelFor = async (query: string, name: string) => {
        api.searchBox.setQuery(query);
        const hit = (await rows()).find((r) => r.label === name);
        assert.ok(hit, `「${query}」找不到 ${name}`);
        return hit.item.label;
      };
      assert.deepStrictEqual(await labelFor('sender', NAMES.b4), { label: 'mail sender', highlights: [[5, 11]] });
      assert.deepStrictEqual(await labelFor('SEND', NAMES.b4), { label: 'mail sender', highlights: [[5, 9]] });
      assert.deepStrictEqual(await labelFor('price', NAMES.f), { label: 'priceEntry', highlights: [[0, 5]] }, '函式書籤的名稱');
      assert.deepStrictEqual(await labelFor('return 2', NAMES.b2), { label: 'return 2', highlights: [[0, 6], [7, 8]] }, '多個字各自標亮');
      assert.deepStrictEqual(await labelFor('價格', NAMES.b1), { label: '價格計算', highlights: [[0, 2]] }, '中文');
      assert.strictEqual(await labelFor('compute_price', NAMES.b1), NAMES.b1, '符合的是那一行程式碼，不是名稱：不標亮');
      assert.strictEqual(await labelFor('#todo', NAMES.b1), NAMES.b1, '#標籤 不在書籤名稱上標亮');
      api.searchBox.setQuery('');
      assert.strictEqual((await rows())[1].item.label, NAMES.b1, '清除搜尋後是純文字');
    });

    it('依檔案分組：只列有結果的檔案，分組 id 加上 :search，檔名標亮；清除後 id 恢復', async () => {
      await setup();
      const idsBefore = (await groupsOf()).map((g) => String(api.provider.getTreeItem(g).id));
      assert.strictEqual(idsBefore.length, 2);
      assert.ok(idsBefore.every((id) => id.startsWith('bmFile:') && !id.endsWith(':search')));

      api.searchBox.setQuery('mail');
      let groups = await groupsOf();
      assert.deepStrictEqual(groups.map((g) => g.rel), [relB], '檔案 a 沒有結果，不列出');
      const item = api.provider.getTreeItem(groups[0]);
      assert.strictEqual(item.id, `${idsBefore[1]}:search`);
      assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);

      api.searchBox.setQuery('find_b');
      groups = await groupsOf();
      assert.deepStrictEqual(api.provider.getTreeItem(groups[0]).label, { label: 'tmp_find_b.py', highlights: [[4, 10]] });

      api.searchBox.setQuery('return');
      groups = await groupsOf();
      assert.deepStrictEqual(groups.map((g) => [g.rel, g.items.length]), [[relA, 2]]);

      api.searchBox.setQuery('find');
      groups = await groupsOf();
      assert.deepStrictEqual(groups.map((g) => [g.rel, g.items.length]), [[relA, 4], [relB, 1]]);
      assert.ok(groups.every((g) => String(api.provider.getTreeItem(g).id).endsWith(':search')));

      api.searchBox.setQuery('');
      assert.deepStrictEqual((await groupsOf()).map((g) => String(api.provider.getTreeItem(g).id)), idsBefore);
    });

    it('依標籤分組：搜尋 #標籤 時只列出符合的標籤分組；一般文字時列出符合書籤的全部標籤', async () => {
      await setup();
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByTag');
      const keys = async () => (await groupsOf()).map((g) => [g.key, g.items.length] as const);
      assert.deepStrictEqual(await keys(), [['api', 1], ['pricing', 2], ['todo', 2], ['', 1]], '沒有搜尋：全部標籤，沒有標籤的在最後');

      api.searchBox.setQuery('#todo');
      assert.deepStrictEqual(await keys(), [['todo', 2]], 'b1 還有 pricing 標籤，但不另外列出');
      api.searchBox.setQuery('#pric');
      assert.deepStrictEqual(await keys(), [['pricing', 2]], '部分比對');
      api.searchBox.setQuery('#pricing #todo');
      assert.deepStrictEqual(await keys(), [['pricing', 1], ['todo', 1]], '只有 b1 兩個標籤都有；兩個分組各列一次');
      assert.deepStrictEqual(await labels(), [NAMES.b1, NAMES.b1]);
      assert.strictEqual(String(sectionItem().description), '1 of 5 match', '同一個書籤出現在兩個分組，計數只算一次');

      api.searchBox.setQuery('pricing');
      assert.deepStrictEqual(await keys(), [['pricing', 2], ['todo', 1]], '一般文字：書籤的標籤都列');
      assert.strictEqual(String(sectionItem().description), '2 of 5 match');

      api.searchBox.setQuery('mail');
      assert.deepStrictEqual(await keys(), [['', 1]], '沒有標籤的書籤歸在「沒有標籤」');

      api.searchBox.setQuery('#pric');
      const item = api.provider.getTreeItem((await groupsOf())[0]);
      assert.strictEqual(item.id, 'bmTag:pricing:search');
      assert.deepStrictEqual(item.label, { label: '#pricing', highlights: [[1, 5]] }, '標籤分組名稱標亮搜尋的標籤');

      api.searchBox.setQuery('');
      assert.deepStrictEqual(await keys(), [['api', 1], ['pricing', 2], ['todo', 2], ['', 1]]);
      assert.strictEqual(api.provider.getTreeItem((await groupsOf())[1]).id, 'bmTag:pricing');
    });

    it('依來源分組：自己的在前，沒結果的來源不列出；來源名稱標亮', async () => {
      await setup();
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksBySource');
      const keys = async () => (await groupsOf()).map((g) => [g.key, g.items.length] as const);
      assert.deepStrictEqual(await keys(), [['', 4], ['bob', 1]]);

      api.searchBox.setQuery('return');
      assert.deepStrictEqual(await keys(), [['', 1], ['bob', 1]]);
      api.searchBox.setQuery('mail');
      assert.deepStrictEqual(await keys(), [['', 1]], 'bob 沒有結果，不列出');
      assert.strictEqual(api.provider.getTreeItem((await groupsOf())[0]).id, 'bmSource::search', '自己的分組也加 :search');
      api.searchBox.setQuery('@bob');
      assert.deepStrictEqual(await keys(), [['bob', 1]], '自己的沒有結果，不列出');
      api.searchBox.setQuery('@bo');
      const item = api.provider.getTreeItem((await groupsOf())[0]);
      assert.deepStrictEqual(item.label, { label: 'bob', highlights: [[0, 2]] });
      assert.strictEqual(item.id, 'bmSource:bob:search');
      assert.strictEqual(item.description, '1');

      api.searchBox.setQuery('');
      assert.deepStrictEqual(await keys(), [['', 4], ['bob', 1]]);
      assert.strictEqual(api.provider.getTreeItem((await groupsOf())[1]).id, 'bmSource:bob');
    });

    it('搜尋中分組一律展開（先前收合的分組裡也可能有結果）；清除搜尋後恢復原本的收合狀態', async () => {
      await setup();
      const g0 = (await groupsOf())[0];
      api.provider.setExpanded(g0, false);
      try {
        assert.strictEqual(api.provider.getTreeItem(g0).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, '前提：使用者收合了這個分組');
        api.searchBox.setQuery('return');
        assert.strictEqual(api.provider.getTreeItem((await groupsOf())[0]).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
        api.searchBox.setQuery('');
        assert.strictEqual(api.provider.getTreeItem((await groupsOf())[0]).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      } finally {
        api.provider.setExpanded(g0, true);
      }
    });

    it('firstMatch：依側邊欄順序的第一個結果；沒結果是 undefined', async () => {
      await setup();
      const first = () => {
        const n = api.provider.firstMatch();
        return n ? labelOf(api.provider.getTreeItem(n)) : undefined;
      };
      api.searchBox.setQuery('tmp_find');
      assert.strictEqual(first(), NAMES.f, '同一個檔案：依行號，函式書籤（第 0 行）在前');
      assert.strictEqual(api.provider.firstMatch()?.type, 'favorite');
      assert.deepStrictEqual(await labels(), ALL, '整個列表的順序：檔案、行號');
      api.searchBox.setQuery('find_b');
      assert.strictEqual(first(), NAMES.b4, '只有第二個檔案有結果');
      api.searchBox.setQuery('#todo');
      assert.strictEqual(first(), NAMES.b1);
      assert.strictEqual(api.provider.firstMatch()?.type, 'bookmark');
      api.searchBox.setQuery('return');
      assert.strictEqual(first(), NAMES.b2);
      api.searchBox.setQuery('zzz_nothing');
      assert.strictEqual(api.provider.firstMatch(), undefined);

      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksBySource');
      api.searchBox.setQuery('return');
      assert.strictEqual(first(), NAMES.b2, '依來源分組：自己的分組在前');
      api.searchBox.setQuery('@bob');
      assert.strictEqual(first(), NAMES.b3);

      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByTag');
      api.searchBox.setQuery('return');
      assert.strictEqual(first(), NAMES.b2, '依標籤分組：api 在 todo 前');
      api.searchBox.setQuery('#todo');
      assert.strictEqual(first(), NAMES.b1);
      api.searchBox.setQuery('mail');
      assert.strictEqual(first(), NAMES.b4, '沒有標籤的分組');
    });

    it('firstMatch 與列表第一列一致（三種分組）', async () => {
      await setup();
      for (const group of ['groupBookmarksByFile', 'groupBookmarksByTag', 'groupBookmarksBySource']) {
        await vscode.commands.executeCommand(`functionBookmarks.${group}`);
        for (const q of ['', 'tmp_find', 'return', '#todo', '@bob', 'find_b', 'zzz_nothing']) {
          api.searchBox.setQuery(q);
          const all = await rows();
          const first = api.provider.firstMatch();
          assert.strictEqual(first ? labelOf(api.provider.getTreeItem(first)) : undefined, all[0]?.label, `${group}，搜尋「${q}」`);
        }
      }
    });

    it('清除搜尋後恢復原本的書籤與分組（依檔案、標籤、來源）', async () => {
      await setup();
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
        assert.ok(before.groups.length > 0, group);
        api.searchBox.setQuery('#todo');
        assert.notDeepStrictEqual(await snapshot(), before, `${group}：搜尋中列表不同`);
        api.searchBox.setQuery('');
        assert.deepStrictEqual(await snapshot(), before, `${group}：清除搜尋後恢復`);
      }
    });

    it('searchFields：行號書籤與函式書籤比對的欄位', async () => {
      await setup();
      const all = await rows();
      const fieldsOf = (name: string) => {
        const node = all.find((r) => r.label === name)!.node as BookmarkNode | FavoriteNode;
        return searchFields((node.type === 'bookmark' ? { kind: 'line', entry: node.entry } : { kind: 'symbol', fav: node.fav }) as never);
      };
      assert.strictEqual(all.length, 5);
      assert.deepStrictEqual(fieldsOf(NAMES.b1), {
        names: ['價格計算'],
        tags: ['pricing', 'todo'],
        author: '',
        file: relA,
        func: 'alpha',
        line: 'total = compute_price()',
        note: 'check rounding',
      });
      assert.deepStrictEqual(fieldsOf(NAMES.b2), { names: ['return 2'], tags: ['api'], author: '', file: relA, func: 'beta', line: 'return 2', note: undefined });
      assert.deepStrictEqual(fieldsOf(NAMES.b3), {
        names: ['return "lid"'],
        tags: ['todo'],
        author: 'bob',
        file: relA,
        func: 'Box.open',
        line: 'return "lid"',
        note: undefined,
      });
      assert.deepStrictEqual(fieldsOf(NAMES.f), {
        names: ['priceEntry', 'alpha'],
        tags: ['pricing'],
        author: '',
        file: relA,
        func: 'alpha',
        note: 'entry point',
      });
    });

    it('searchFields：沒有 anchor 的別人的函式書籤用 symbol 路徑當所在函式；函式書籤沒有自訂名稱時只有原名', () => {
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
      const fav = { kind: 'symbol', fav: { mark: { file: 'a/b.py', path: 'Outer.inner', kind: 'method', tags: ['t'], note: 'n' } } };
      assert.deepStrictEqual(searchFields(fav as never), { names: ['inner'], tags: ['t'], author: '', file: 'a/b.py', func: 'Outer.inner', note: 'n' });
    });

    it('searchBox.setQuery 同步到側邊欄；清除後恢復', async () => {
      await setup();
      assert.strictEqual(api.searchBox.query, '');
      api.searchBox.setQuery('#todo');
      assert.strictEqual(api.searchBox.query, '#todo');
      assert.strictEqual(api.provider.query, '#todo');
      assert.strictEqual(api.provider.searching, true);
      assert.deepStrictEqual(await labels(), [NAMES.b1, NAMES.b3]);
      api.searchBox.setQuery('');
      assert.strictEqual(api.searchBox.query, '');
      assert.strictEqual(api.provider.query, '');
      assert.strictEqual(api.provider.searching, false);
      assert.deepStrictEqual(await labels(), ALL);
    });

    it('BookmarkSearchBox：搜尋字串存在工作區狀態 searchQuery，重新建立時讀回；同樣的字串不重複通知', () => {
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
      assert.strictEqual(box.query, '#saved', '重開編輯器後讀回上次的搜尋');
      assert.deepStrictEqual(seen, [], '建立時不通知');
      box.setQuery('#saved');
      assert.deepStrictEqual(seen, [], '沒變：不通知');
      box.setQuery('login view');
      assert.deepStrictEqual(seen, ['login view']);
      assert.strictEqual(state.get('searchQuery'), 'login view');
      assert.strictEqual(box.query, 'login view');
      box.setQuery('login view');
      assert.deepStrictEqual(seen, ['login view'], '同樣的字串不重複通知');
      box.setQuery('');
      assert.deepStrictEqual(seen, ['login view', '']);
      assert.strictEqual(state.get('searchQuery'), '');
      assert.strictEqual(make().query, '', '清除後重開是空的');
      box.dispose();
    });

    it('指令 clearSearch：清除搜尋，側邊欄恢復；沒有搜尋時再執行也不會出錯', async () => {
      await setup();
      api.searchBox.setQuery('#todo @bob');
      assert.strictEqual(api.provider.searching, true);
      await vscode.commands.executeCommand('functionBookmarks.clearSearch');
      assert.strictEqual(api.provider.query, '');
      assert.strictEqual(api.provider.searching, false);
      assert.strictEqual(api.searchBox.query, '');
      assert.deepStrictEqual(await labels(), ALL);
      await vscode.commands.executeCommand('functionBookmarks.clearSearch');
      assert.strictEqual(api.provider.query, '');
    });

    it('指令 focusSearch：開啟輸入框，不改動搜尋字串；關閉輸入框後字串保留', async () => {
      api.searchBox.setQuery('keep');
      try {
        await vscode.commands.executeCommand('functionBookmarks.focusSearch');
        assert.strictEqual(api.searchBox.isOpen, true);
        assert.strictEqual(api.searchBox.query, 'keep');
        assert.strictEqual(api.provider.query, 'keep');
        // 輸入框開著時從程式改字串：一起更新
        api.searchBox.setQuery('keep2');
        assert.strictEqual(api.provider.query, 'keep2');
        api.searchBox.close();
        assert.strictEqual(api.searchBox.isOpen, false);
        assert.strictEqual(api.provider.query, 'keep2', '點到別處關閉：字串保留');
      } finally {
        api.searchBox.close();
        api.searchBox.setQuery('');
      }
    });

    it('Esc（searchClearAndClose）：清除搜尋並關閉輸入框', async () => {
      await setup();
      api.searchBox.setQuery('price');
      await vscode.commands.executeCommand('functionBookmarks.focusSearch');
      try {
        await vscode.commands.executeCommand('functionBookmarks.searchClearAndClose');
        assert.strictEqual(api.searchBox.isOpen, false);
        assert.strictEqual(api.provider.query, '');
        assert.deepStrictEqual(await labels(), ALL);
      } finally {
        api.searchBox.close();
      }
    });

    it('↓（searchToList）：關閉輸入框，選取第一個結果並保留搜尋', async () => {
      await setup();
      api.searchBox.setQuery('#todo');
      await vscode.commands.executeCommand('functionBookmarks.focusSearch');
      try {
        await vscode.commands.executeCommand('functionBookmarks.searchToList');
        assert.strictEqual(api.searchBox.isOpen, false);
        assert.strictEqual(api.provider.query, '#todo');
        const first = api.provider.firstMatch();
        assert.ok(first);
        const sel = api.treeView.selection[0];
        assert.ok(sel && (sel.type === 'bookmark' || sel.type === 'favorite'), '選取了書籤');
        assert.strictEqual(api.provider.getTreeItem(sel).id, api.provider.getTreeItem(first).id);
      } finally {
        api.searchBox.close();
      }
    });

    it('清單第一列是搜尋列：沒有搜尋時顯示提示，搜尋中顯示字串並有清除鈕', async () => {
      const roots = await api.provider.getChildren();
      assert.strictEqual(roots[0].type, 'search');
      let item = api.provider.getTreeItem(api.provider.searchNode);
      assert.strictEqual(item.label, '');
      assert.strictEqual(item.description, 'Search bookmarks…');
      assert.strictEqual(item.contextValue, 'fbSearch');
      assert.strictEqual(item.command?.command, 'functionBookmarks.focusSearch');
      api.searchBox.setQuery('#todo login');
      item = api.provider.getTreeItem(api.provider.searchNode);
      assert.strictEqual(item.label, '#todo login');
      assert.strictEqual(item.description, undefined);
      assert.strictEqual(item.contextValue, 'fbSearch:active');
    });

    it('指令都有登記（命令選擇區找得到）', async () => {
      const all = await vscode.commands.getCommands(true);
      for (const id of ['clearSearch', 'focusSearch', 'searchToList', 'searchClearAndClose']) {
        assert.ok(all.includes(`functionBookmarks.${id}`), id);
      }
    });
  });

  describe('啟動效能與計時紀錄', () => {
    it('啟動完成後記錄各階段耗時，且啟動不卡在背景掃描', async () => {
      const phases = api.startupTimings.map((t) => t.phase);
      assert.ok(phases.includes('store.init'), '有記錄 store.init');
      assert.ok(phases.includes('branches.refresh'), '有記錄 branches.refresh');
      assert.ok(phases.includes('activate.total'), '有記錄 activate.total');
      // 驗證新增函式書籤後，不必等 favorites.refresh() 就能立即在清單看得到
      await api.store.update(folder(), (d) =>
        setFavorite(d, { file: 'app/views.py', path: 'index', kind: 'function' }, true, 1),
      );
      assert.strictEqual(api.favorites.all.length, 1, '寫入 store 後立即可見函式書籤');
      await api.favorites.whenReady();
      assert.strictEqual(api.favorites.all[0].status, 'ok');
    });
  });

  describe('快速搜尋書籤（searchMarks 補強）', () => {
    it('說明列帶出備註第一行，並能搜尋備註全文（含第二行）與標示需確認／不在此分支', async () => {
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, {
          id: newBookmarkId(),
          file: 'app/views.py',
          line: 0,
          label: '入口點',
          note: '第一行摘要說明\n第二行關鍵字_UNIQUE_NOTE_BODY',
          status: 'lost',
        });
        next = addBookmark(next, {
          id: newBookmarkId(),
          file: 'app/views.py',
          line: 2,
          label: '別的分支書籤',
          status: 'notOnBranch',
        });
        next = setFavorite(next, { file: 'app/views.py', path: 'index', kind: 'function' }, true, 0);
        next = setNote(next, { file: 'app/views.py', path: 'index', kind: 'function' }, '函式備註首行\n函式備註次行_FN_BODY', 0);
        return next;
      });
      await api.favorites.refresh();

      // 預設不隱藏不在此分支
      const all = buildSearchMarkItems(api.store, api.favorites, { hideNotOnBranch: false });
      assert.strictEqual(all.length, 3);
      const lostItem = all.find((i) => i.label.includes('入口點'));
      const awayItem = all.find((i) => i.label.includes('別的分支書籤'));
      const fnItem = all.find((i) => i.label.includes('index'));
      assert.ok(lostItem && lostItem.label.startsWith('$(warning) '), '需確認顯示警告圖示');
      assert.ok(lostItem.description?.includes('needs checking'), '需確認標示文字');
      assert.ok(lostItem.detail?.includes('第一行摘要說明'), '說明列帶出備註第一行');
      assert.ok(!lostItem.detail?.includes('UNIQUE_NOTE_BODY'), '說明列只帶第一行');
      assert.ok(awayItem && awayItem.label.startsWith('$(git-branch) '), '不在此分支顯示分支圖示');
      assert.ok(awayItem.description?.includes('not on this branch'), '不在此分支標示文字');
      assert.ok(fnItem && fnItem.detail?.includes('函式備註首行'), '函式書籤說明列帶出備註第一行');

      // 透過 filter.ts 可搜到備註第二行內容
      assert.strictEqual(filterSearchMarkItems(all, 'UNIQUE_NOTE_BODY').length, 1);
      assert.strictEqual(filterSearchMarkItems(all, 'FN_BODY').length, 1);

      // 跟隨「隱藏不在此分支」設定
      const hidden = buildSearchMarkItems(api.store, api.favorites, { hideNotOnBranch: true });
      assert.strictEqual(hidden.length, 2);
      assert.ok(!hidden.some((i) => i.label.includes('別的分支書籤')));
    });
  });

  describe('標籤編輯提示與 autoNumber 一致', () => {
    it('行號書籤與函式書籤共用所有書籤的標籤提示清單', async () => {
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, { id: newBookmarkId(), file: 'app/views.py', line: 0, tags: ['lineTag', 'shared'] });
        next = setFavorite(next, { file: 'app/views.py', path: 'index', kind: 'function' }, true, 0);
        next = setTags(next, { file: 'app/views.py', path: 'index', kind: 'function' }, ['fnTag', 'shared']);
        return next;
      });
      assert.deepStrictEqual(api.store.allTags(), ['fnTag', 'lineTag', 'shared']);
      const prompt = tagsPrompt(api.store);
      assert.ok(prompt.includes('#fnTag') && prompt.includes('#lineTag') && prompt.includes('#shared'), prompt);
    });

    it('函式加標籤時順便新增書籤會套用 autoNumber 設定', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      await cfg.update('bookmarks.autoNumber', true, vscode.ConfigurationTarget.Workspace);
      try {
        await open(workspaceFile('app', 'views.py'), api);
        const indexNode = findNode(api.provider.currentSymbolNodes, 'index')!;
        // 還沒加入書籤，直接加標籤 → 順便加入函式書籤並自動編號 1
        await api.commands.editTags(indexNode, '#core');
        const mark = api.store.get(workspaceFile('app', 'views.py'), indexNode.symbol);
        assert.strictEqual(mark?.favorite, true);
        assert.deepStrictEqual(mark?.tags, ['core']);
        assert.strictEqual(mark?.number, 1, '應套用 autoNumber 自動配 1 號');

        // 已經是書籤再改標籤：不重新配號（仍維持 1 號）
        await api.commands.editTags(indexNode, '#core #auth');
        const updated = api.store.get(workspaceFile('app', 'views.py'), indexNode.symbol);
        assert.strictEqual(updated?.number, 1);
      } finally {
        await cfg.update('bookmarks.autoNumber', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });
  });

  describe('小細節（清理 notes、存檔快捷鍵提示、storage 切換、LSP 種類）', () => {
    it('NoteEditor 啟動時一併清除異常關閉殘留的 notes/ 與 previews/ 暫存檔', async () => {
      const base = workspaceFile('.tmp-note-cleanup-test');
      const staleNote = vscode.Uri.joinPath(base, 'notes', 'stale.md');
      const stalePreview = vscode.Uri.joinPath(base, 'previews', 'stale.md');
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(base, 'notes'));
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(base, 'previews'));
        await vscode.workspace.fs.writeFile(staleNote, new TextEncoder().encode('leftover'));
        await vscode.workspace.fs.writeFile(stalePreview, new TextEncoder().encode('leftover'));
        const editor = new NoteEditor(base);
        try {
          await editor.cleanup;
          const noteExists = await vscode.workspace.fs.stat(staleNote).then(() => true, () => false);
          const prevExists = await vscode.workspace.fs.stat(stalePreview).then(() => true, () => false);
          assert.strictEqual(noteExists, false, '殘留的 notes 暫存檔已清除');
          assert.strictEqual(prevExists, false, '殘留的 previews 暫存檔已清除');
        } finally {
          editor.dispose();
        }
      } finally {
        await vscode.workspace.fs.delete(base, { recursive: true }).then(undefined, () => undefined);
      }
    });

    it('saveShortcut 依平台顯示 Cmd+S 或 Ctrl+S', () => {
      assert.strictEqual(saveShortcut('darwin'), 'Cmd+S');
      assert.strictEqual(saveShortcut('win32'), 'Ctrl+S');
      assert.strictEqual(saveShortcut('linux'), 'Ctrl+S');
    });

    it('LSP 後備涵蓋 Interface／Struct／Enum／Module／Namespace／Package', () => {
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Interface], 'class');
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Struct], 'class');
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Enum], 'class');
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Module], 'block');
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Namespace], 'block');
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Package], 'block');
    });

    it('切換 functionBookmarks.storage 偵測來源資料、不悄悄覆蓋目標，並支援複製與合併', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      api.store.suppressStoragePrompt = true;
      api.store.lastStorageSwitch = undefined;
      try {
        // 先在 file 模式建立一筆書籤
        await api.store.update(folder(), (d) =>
          addBookmark(d, { id: 'from-file', file: 'app/views.py', line: 1, label: '來自檔案' }),
        );
        // 切到 workspaceState（此時 workspaceState 是空的）
        await cfg.update('storage', 'workspaceState', vscode.ConfigurationTarget.Workspace);
        const sw1 = await waitFor(() => api.store.lastStorageSwitch, (v) => v?.to === 'workspaceState');
        assert.ok(sw1, '觸發 storage 切換偵測');
        assert.strictEqual(sw1.from, 'file');
        assert.strictEqual(sw1.targetHadData, false);
        assert.strictEqual(api.store.allBookmarks().length, 0, '尚未選擇複製前不主動覆蓋目標');

        // 執行複製並加上 workspaceState 專屬書籤
        await api.store.migrateStorageData(sw1.prevData, 'copy');
        assert.deepStrictEqual(api.store.allBookmarks().map((e) => e.bookmark.id), ['from-file']);
        await api.store.update(folder(), (d) =>
          addBookmark(d, { id: 'from-ws', file: 'app/views.py', line: 3, label: '來自工作區狀態' }),
        );

        // 再切回 file（此時 file 端已經有 from-file）→ 絕不悄悄覆蓋，可選擇合併
        api.store.lastStorageSwitch = undefined;
        await cfg.update('storage', 'file', vscode.ConfigurationTarget.Workspace);
        const sw2 = await waitFor(() => api.store.lastStorageSwitch, (v) => v?.to === 'file');
        assert.ok(sw2, '切回 file 時觸發偵測');
        assert.strictEqual(sw2.targetHadData, true, '偵測到目標端已有資料');
        assert.deepStrictEqual(api.store.allBookmarks().map((e) => e.bookmark.id), ['from-file'], '不悄悄覆蓋目標端');

        await api.store.migrateStorageData(sw2.prevData, 'merge');
        assert.deepStrictEqual(api.store.allBookmarks().map((e) => e.bookmark.id).sort(), ['from-file', 'from-ws'], '合併保留兩邊');
      } finally {
        // 清空 workspaceState 殘留資料並恢復設定
        await cfg.update('storage', 'workspaceState', vscode.ConfigurationTarget.Workspace);
        await waitFor(() => vscode.workspace.getConfiguration('functionBookmarks').get('storage'), (v) => v === 'workspaceState');
        await api.store.update(folder(), () => emptyStore());
        await cfg.update('storage', undefined, vscode.ConfigurationTarget.Workspace);
        await waitFor(() => vscode.workspace.getConfiguration('functionBookmarks').get('storage'), (v) => v === 'file');
        api.store.lastStorageSwitch = undefined;
        api.store.suppressStoragePrompt = false;
      }
    });
  });

  describe('備註存檔是否關閉分頁（notes.closeOnSave）', () => {
    it('closeOnSave 設為 false 時存檔只寫回備註不關分頁，可連續存檔，關閉後才清暫存檔', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      await cfg.update('notes.closeOnSave', false, vscode.ConfigurationTarget.Workspace);
      try {
        await open(workspaceFile('app', 'views.py'), api);
        const indexNode = findNode(api.provider.currentSymbolNodes, 'index')!;
        await api.commands.setFavorite(indexNode, true);
        await api.commands.editNote(indexNode);
        const noteEditor = vscode.window.activeTextEditor!;
        assert.ok(api.notes.isNoteDocument(noteEditor.document.uri), '已開啟備註編輯分頁');

        // 第一次編輯並存檔
        await noteEditor.edit((eb) => eb.insert(new vscode.Position(0, 0), '第一版備註'));
        await noteEditor.document.save();
        await waitFor(() => api.store.get(workspaceFile('app', 'views.py'), indexNode.symbol)?.note, (v) => v === '第一版備註');
        assert.strictEqual(api.store.get(workspaceFile('app', 'views.py'), indexNode.symbol)?.note, '第一版備註');
        assert.strictEqual(api.notes.isNoteDocument(noteEditor.document.uri), true, '不應關閉分頁或結束 session');
        assert.strictEqual(noteEditor.document.isClosed, false);

        // 第二次編輯並存檔仍會寫回
        await noteEditor.edit((eb) => eb.insert(new vscode.Position(0, 5), '\n第二版補充'));
        await noteEditor.document.save();
        await waitFor(
          () => api.store.get(workspaceFile('app', 'views.py'), indexNode.symbol)?.note,
          (v) => v === '第一版備註\n第二版補充',
        );
        assert.strictEqual(api.store.get(workspaceFile('app', 'views.py'), indexNode.symbol)?.note, '第一版備註\n第二版補充');
        assert.strictEqual(api.notes.isNoteDocument(noteEditor.document.uri), true);

        // 手動關閉分頁後清掉 session 與暫存檔
        const noteUri = noteEditor.document.uri;
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await waitFor(() => api.notes.isNoteDocument(noteUri), (v) => !v);
        assert.strictEqual(api.notes.isNoteDocument(noteUri), false);
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await cfg.update('notes.closeOnSave', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });
  });

  describe('依編號導覽與匯出導讀文件', () => {
    it('tourNext／tourPrevious 依 1→9 循環跳轉（跨檔案），更新狀態列並處理無編號與有備註', async () => {
      const allCmds = await vscode.commands.getCommands(true);
      assert.ok(allCmds.includes('functionBookmarks.tourNext'));
      assert.ok(allCmds.includes('functionBookmarks.tourPrevious'));

      // 沒有編號書籤時回傳 undefined
      const none = await vscode.commands.executeCommand('functionBookmarks.tourNext');
      assert.strictEqual(none, undefined);

      // 建立 2 號（函式書籤，含備註，views.py）與 5 號（行號書籤，docs/guide.md）
      await api.store.update(folder(), (d) => {
        let next = setFavorite(d, { file: 'app/views.py', path: 'index', kind: 'function' }, true, 0);
        next = setNote(next, { file: 'app/views.py', path: 'index', kind: 'function' }, '導覽備註內容', 0);
        next = { ...next, symbols: next.symbols.map((m) => ({ ...m, number: 2 })) };
        next = addBookmark(next, { id: newBookmarkId(), file: 'docs/guide.md', line: 2, label: '第二站', number: 5 });
        return next;
      });
      await api.favorites.refresh();

      const step1 = await vscode.commands.executeCommand<{ number: number; index: number; total: number; hasNote: boolean; uri: vscode.Uri }>('functionBookmarks.tourNext');
      assert.strictEqual(step1?.number, 2);
      assert.strictEqual(step1?.index, 1);
      assert.strictEqual(step1?.total, 2);
      assert.strictEqual(step1?.hasNote, true);
      assert.ok(api.extras.lastTourStatus?.includes('1/2'));

      const step2 = await vscode.commands.executeCommand<{ number: number; index: number; total: number; hasNote: boolean; uri: vscode.Uri }>('functionBookmarks.tourNext');
      assert.strictEqual(step2?.number, 5);
      assert.strictEqual(step2?.index, 2);
      assert.strictEqual(step2?.hasNote, false);
      assert.ok(step2?.uri.path.endsWith('docs/guide.md'));
      assert.ok(api.extras.lastTourStatus?.includes('2/2'));

      // 循環回第一個
      const wrap = await vscode.commands.executeCommand<{ number: number; index: number }>('functionBookmarks.tourNext');
      assert.strictEqual(wrap?.number, 2);
      assert.strictEqual(wrap?.index, 1);

      // 往回跳到最後一個
      const prev = await vscode.commands.executeCommand<{ number: number; index: number }>('functionBookmarks.tourPrevious');
      assert.strictEqual(prev?.number, 5);
      assert.strictEqual(prev?.index, 2);
    });

    it('匯出導讀文件（Markdown）：編號在前、函式取本體（超 30 行截斷）、行號取前後 3 行、不含程式碼省略片段', async () => {
      const longFile = workspaceFile('tmp_long_guide.py');
      const longLines = ['def very_long_fn():', ...Array.from({ length: 35 }, (_, i) => `    v${i} = ${i}`), '    return v0', ''];
      await vscode.workspace.fs.writeFile(longFile, new TextEncoder().encode(longLines.join('\n')));
      try {
        await api.store.update(folder(), (d) => {
          let next = setFavorite(d, { file: 'tmp_long_guide.py', path: 'very_long_fn', kind: 'function' }, true, 0);
          next = setNote(next, { file: 'tmp_long_guide.py', path: 'very_long_fn', kind: 'function' }, '超長函式備註', 0);
          next = { ...next, symbols: next.symbols.map((m) => ({ ...m, number: 1 })) };
          next = addBookmark(next, {
            id: newBookmarkId(),
            file: 'app/views.py',
            line: 5,
            label: '重點行',
            note: '行號備註原文',
            number: 3,
          });
          next = addBookmark(next, {
            id: newBookmarkId(),
            file: 'app/views.py',
            line: 1,
            label: '未編號書籤',
          });
          return next;
        });
        await api.favorites.refresh();

        const outUri = workspaceFile('.tmp-guide-out.md');
        const withCode = await vscode.commands.executeCommand<{ count: number; text: string }>('functionBookmarks.exportBookmarks', {
          folder: folder(),
          scope: { kind: 'all' },
          format: 'guide',
          includeCode: true,
          target: outUri,
        });
        assert.strictEqual(withCode?.count, 3);
        const text = withCode!.text;
        assert.ok(text.indexOf('## 1. very_long_fn') < text.indexOf('## 3. 重點行'), '有編號的依 1→3 排最前');
        assert.ok(text.indexOf('## 3. 重點行') < text.indexOf('## 未編號書籤'), '無編號接在後面');
        assert.ok(text.includes('```python\ndef very_long_fn():'), '函式書籤取函式本體');
        assert.ok(text.includes('more line(s) omitted'), '超過 30 行截斷並註明');
        assert.ok(text.includes('超長函式備註'), '保留函式備註原文');
        assert.ok(text.includes('行號備註原文'), '保留行號備註原文');

        // 不含程式碼內容時省略程式碼區塊
        const noCode = await vscode.commands.executeCommand<{ count: number; text: string }>('functionBookmarks.exportBookmarks', {
          folder: folder(),
          scope: { kind: 'all' },
          format: 'guide',
          includeCode: false,
          target: outUri,
        });
        assert.strictEqual(noCode?.count, 3);
        assert.ok(!noCode!.text.includes('```'), '不含程式碼內容應省略程式碼片段');
        assert.ok(noCode!.text.includes('超長函式備註'), '仍保留備註原文');
        await vscode.workspace.fs.delete(outUri).then(undefined, () => undefined);
      } finally {
        await vscode.workspace.fs.delete(longFile).then(undefined, () => undefined);
      }
    });
  });

  describe('行號右鍵與各入口編輯備註（卡 d24b180b）', () => {
    const fsp = require('fs/promises') as typeof import('fs/promises');
    const fileL = () => workspaceFile('app', 'tmp_line_note.py');
    const relL = 'app/tmp_line_note.py';
    const LINES = [
      'def first_fn():',
      '    a = 1',
      '    return a',
      '',
      'top_val = 42',
      '',
      'def second_fn():',
      '    b = 2',
      '    return b',
      '',
    ];
    const firstKey = { file: relL, path: 'first_fn', kind: 'function' as const };
    const secondKey = { file: relL, path: 'second_fn', kind: 'function' as const };
    const foreignSource = (author: string) => ({ author, importId: 'i-ln', originalId: newBookmarkId(), importedAt: '2026-01-01T00:00:00.000Z' });

    async function openAt(line: number): Promise<vscode.TextEditor> {
      const editor = await open(fileL(), api);
      editor.selection = new vscode.Selection(line, 0, line, 0);
      await api.external.idle();
      return editor;
    }

    /** 在目前已開啟的備註編輯分頁填入文字、存檔，並等分頁與預覽關閉。 */
    async function writeAndSaveNote(text: string): Promise<string> {
      const noteEditor = await waitFor(
        () => vscode.window.activeTextEditor,
        (ed) => !!ed && api.notes.isNoteDocument(ed.document.uri),
      );
      assert.ok(noteEditor && api.notes.isNoteDocument(noteEditor.document.uri), '應開啟備註編輯分頁');
      const prevText = noteEditor.document.getText();
      const fullRange = new vscode.Range(0, 0, noteEditor.document.lineCount, 0);
      await noteEditor.edit((eb) => eb.replace(fullRange, text));
      const noteUri = noteEditor.document.uri;
      await noteEditor.document.save();
      await waitFor(() => api.notes.isNoteDocument(noteUri), (open) => !open);
      await waitFor(previewTabCount, (n) => n === 0);
      return prevText;
    }

    before(async () => {
      await fsp.writeFile(fileL().fsPath, LINES.join('\n'));
    });

    afterEach(async () => {
      api.store.setHiddenSources([]);
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.autoNumber', undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    after(async () => {
      api.store.setHiddenSources([]);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fsp.rm(fileL().fsPath, { force: true });
    });

    it('package.json：行號右鍵選單在既有四項之後加入「編輯備註」；側邊欄預覽備註不重複比對書籤', () => {
      const pkg = findExtension()!.packageJSON as {
        contributes: { menus: Record<string, { command: string; group?: string; when?: string }[]> };
      };
      const lineMenu = pkg.contributes.menus['editor/lineNumber/context'];
      assert.deepStrictEqual(
        lineMenu.map((m) => [m.command, m.group]),
        [
          ['functionBookmarks.toggleBookmark', 'functionBookmarks@1'],
          ['functionBookmarks.addLabeledBookmark', 'functionBookmarks@2'],
          ['functionBookmarks.setBookmarkNumber', 'functionBookmarks@3'],
          ['functionBookmarks.setBookmarkColor', 'functionBookmarks@4'],
          ['functionBookmarks.editNote', 'functionBookmarks@5'],
        ],
      );
      const previewRules = pkg.contributes.menus['view/item/context'].filter((m) => m.command === 'functionBookmarks.previewNote');
      const forBookmark = previewRules.filter((r) => r.when?.includes('fbBookmark'));
      const forSymbol = previewRules.filter((r) => !r.when?.includes('fbBookmark'));
      assert.strictEqual(forBookmark.length, 1);
      assert.strictEqual(forSymbol.length, 1);
      assert.ok(forSymbol[0].when?.includes('^fbSymbol'), `不應重複比對 fbBookmark：${forSymbol[0].when}`);
    });

    it('行號右鍵（已有行號書籤，且游標在不同行）：編輯右鍵那一行的書籤備註，不動游標行', async () => {
      await api.store.update(folder(), (d) =>
        addBookmark(d, { id: 'bm-line-7', file: relL, line: 7, label: '目標行', note: '原本備註', anchor: makeAnchor(LINES, 7, 'second_fn', 6) }),
      );
      await openAt(1); // 游標停在第 1 行（first_fn 裡面），右鍵第 8 行（1-based = line 7）
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 8, uri: fileL() });
      const prev = await writeAndSaveNote('修改後的行號備註');
      assert.strictEqual(prev, '原本備註');
      assert.strictEqual(api.store.bookmarksFor(fileL()).find((b) => b.id === 'bm-line-7')?.note, '修改後的行號備註');
      assert.strictEqual(api.store.bookmarksFor(fileL()).length, 1, '不應在游標行多建書籤');
      assert.strictEqual(api.store.get(fileL(), firstKey), undefined, '不應動到游標所在的函式');
    });

    it('行號右鍵（函式名稱行已有函式書籤，且游標在不同行）：編輯該函式書籤的備註', async () => {
      await api.store.update(folder(), (d) => setNote(setFavorite(d, secondKey, true, 6), secondKey, '舊函式備註', 6));
      await api.favorites.refresh();
      await openAt(4); // 游標在第 4 行，右鍵第 7 行（1-based = line 6，second_fn）
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 7, uri: fileL() });
      const prev = await writeAndSaveNote('新函式備註');
      assert.strictEqual(prev, '舊函式備註');
      assert.strictEqual(api.store.get(fileL(), secondKey)?.note, '新函式備註');
      assert.strictEqual(api.store.bookmarksFor(fileL()).length, 0, '不應另外建立行號書籤');
    });

    it('行號右鍵（沒書籤的一般行，游標在不同行）：先建行號書籤並套用 autoNumber，再開備註編輯', async () => {
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.autoNumber', true, vscode.ConfigurationTarget.Workspace);
      await openAt(0); // 游標在第 0 行，右鍵第 5 行（1-based = line 4，top_val = 42）
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 5, uri: fileL() });
      await writeAndSaveNote('新建行號書籤備註');
      const bms = api.store.bookmarksFor(fileL());
      assert.strictEqual(bms.length, 1);
      assert.strictEqual(bms[0].line, 4);
      assert.strictEqual(bms[0].number, 1, '應套用 autoNumber 自動配號');
      assert.strictEqual(bms[0].note, '新建行號書籤備註');
      assert.strictEqual(api.store.get(fileL(), firstKey), undefined);
    });

    it('行號右鍵（沒書籤的函式名稱行，游標在不同行）：先建函式書籤並套用 autoNumber，再開備註編輯', async () => {
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.autoNumber', true, vscode.ConfigurationTarget.Workspace);
      await openAt(4); // 游標在第 4 行，右鍵第 7 行（1-based = line 6，second_fn）
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 7, uri: fileL() });
      await writeAndSaveNote('新建函式書籤備註');
      const mark = api.store.get(fileL(), secondKey);
      assert.strictEqual(mark?.favorite, true, '函式名稱行應建立函式書籤');
      assert.strictEqual(mark?.number, 1, '應套用 autoNumber 自動配號');
      assert.strictEqual(mark?.note, '新建函式書籤備註');
      assert.strictEqual(api.store.bookmarksFor(fileL()).length, 0, '不應建行號書籤');
    });

    it('行號右鍵（同一行同時有行號書籤與函式書籤）：優先編輯行號書籤，不動函式書籤', async () => {
      await api.store.update(folder(), (d) => {
        let next = setNote(setFavorite(d, firstKey, true, 0), firstKey, '函式原備註', 0);
        return addBookmark(next, { id: 'bm-overlap', file: relL, line: 0, label: '同行行號書籤', anchor: makeAnchor(LINES, 0, 'first_fn', 0) });
      });
      await api.favorites.refresh();
      await openAt(4);
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 1, uri: fileL() });
      await writeAndSaveNote('同行行號新備註');
      assert.strictEqual(api.store.bookmarksFor(fileL()).find((b) => b.id === 'bm-overlap')?.note, '同行行號新備註');
      assert.strictEqual(api.store.get(fileL(), firstKey)?.note, '函式原備註');
    });

    it('行號右鍵：不在此分支與被來源篩選隱藏的書籤不算，不會被誤改', async () => {
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, {
          id: 'bm-away',
          file: relL,
          line: 4,
          note: '他分支原備註',
          status: 'notOnBranch',
          anchor: makeAnchor(['other_0', 'other_1', 'other_2', 'other_3', 'other_4'], 4),
        });
        next = addBookmark(next, {
          id: 'bm-bob',
          file: relL,
          line: 7,
          note: 'bob原備註',
          source: foreignSource('bob'),
          anchor: makeAnchor(LINES, 7, 'second_fn', 6),
        });
        return addBookmark(next, {
          id: 'bm-mine-hidden',
          file: relL,
          line: 1,
          note: '自己原備註',
          anchor: makeAnchor(LINES, 1, 'first_fn', 0),
        });
      });
      await openAt(0);

      // 1. 不在此分支的書籤（line 4）：改建新書籤並編輯新書籤的備註，原書籤不動
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 5, uri: fileL() });
      await writeAndSaveNote('本分支新備註');
      const at4 = api.store.bookmarksFor(fileL()).filter((b) => b.line === 4);
      assert.strictEqual(at4.length, 2);
      assert.strictEqual(at4.find((b) => b.id === 'bm-away')?.note, '他分支原備註', '不在此分支的書籤不應被改');
      assert.strictEqual(at4.find((b) => b.id !== 'bm-away')?.note, '本分支新備註');

      // 2. 被來源篩選隱藏的別人書籤（bob，line 7）：改建自己的書籤並編輯，bob 的不動
      api.store.setHiddenSources(['bob']);
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 8, uri: fileL() });
      await writeAndSaveNote('自己的新備註');
      const at7 = api.store.bookmarksFor(fileL()).filter((b) => b.line === 7);
      assert.strictEqual(at7.length, 2);
      assert.strictEqual(at7.find((b) => b.id === 'bm-bob')?.note, 'bob原備註', '被隱藏的 bob 書籤不應被改');
      assert.strictEqual(at7.find((b) => b.id !== 'bm-bob')?.note, '自己的新備註');

      // 3. 「我的」被來源篩選隱藏，且該行已有自己的書籤（line 1）：不開備註編輯、不重複新增、只提示
      api.store.setHiddenSources(['']);
      const noticesBefore = api.bookmarks.mineHiddenNotices;
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 2, uri: fileL() });
      assert.strictEqual(api.bookmarks.mineHiddenNotices, noticesBefore + 1, '應提示「我的」目前被隱藏');
      assert.strictEqual(api.notes.isNoteDocument(vscode.window.activeTextEditor!.document.uri), false, '不應開啟被隱藏書籤的備註分頁');
      const at1 = api.store.bookmarksFor(fileL()).filter((b) => b.line === 1);
      assert.strictEqual(at1.length, 1, '不應重複新增');
      assert.strictEqual(at1[0].note, '自己原備註', '被隱藏的書籤不應被改');
    });

    it('其他入口（編輯器內文右鍵、側邊欄右鍵、命令選擇區）：行號書籤的編輯備註與預覽都正常', async () => {
      await api.store.update(folder(), (d) =>
        addBookmark(d, { id: 'bm-entries', file: relL, line: 4, label: '頂層行號書籤', anchor: makeAnchor(LINES, 4) }),
      );
      await openAt(4);

      // 1. 編輯器內文右鍵（傳入檔案 Uri）
      await vscode.commands.executeCommand('functionBookmarks.editNote', fileL());
      await writeAndSaveNote('編輯器右鍵寫入');
      assert.strictEqual(api.store.bookmarksFor(fileL())[0]?.note, '編輯器右鍵寫入');

      // 2. 側邊欄書籤右鍵（傳入 BookmarkNode）
      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const group = groups.find((g) => g.rel === relL)!;
      const bmNode = (await api.provider.getChildren(group))[0] as BookmarkNode;
      await vscode.commands.executeCommand('functionBookmarks.editNote', bmNode);
      const fromSidebar = await writeAndSaveNote('側邊欄右鍵寫入');
      assert.strictEqual(fromSidebar, '編輯器右鍵寫入');
      assert.strictEqual(api.store.bookmarksFor(fileL())[0]?.note, '側邊欄右鍵寫入');

      // 3. 命令選擇區（無參數呼叫）：游標在頂層行號書籤上也能編輯與預覽
      await openAt(4);
      await vscode.commands.executeCommand('functionBookmarks.editNote');
      const fromPalette = await writeAndSaveNote('命令選擇區寫入');
      assert.strictEqual(fromPalette, '側邊欄右鍵寫入');
      assert.strictEqual(api.store.bookmarksFor(fileL())[0]?.note, '命令選擇區寫入');

      await openAt(4);
      await vscode.commands.executeCommand('functionBookmarks.previewNote');
      assert.strictEqual(await waitFor(previewTabCount, (n) => n === 1), 1, '命令選擇區預覽行號書籤備註應開啟預覽分頁');
    });
  });

});

export type { TreeNode };
