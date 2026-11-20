import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { emptyStore } from '../../../src/storage/marks';
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
        assert.deepStrictEqual(roots.map((r) => (r.type === 'section' ? r.section : r.type)), ['bookmarks']);
      } finally {
        await vscode.commands.executeCommand('functionBookmarks.showAll');
      }
      const roots = await api.provider.getChildren();
      assert.deepStrictEqual(roots.map((r) => (r.type === 'section' ? r.section : r.type)), ['bookmarks', 'currentFile', 'project']);
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
      assert.deepStrictEqual(labels, ['app', 'docs', 'static', 'templates']);
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

  describe('M2.1：老闆回饋', () => {
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
        assert.deepStrictEqual(roots.map((r) => (r.type === 'section' ? r.section : r.type)), ['bookmarks']);
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
});

export type { TreeNode };
