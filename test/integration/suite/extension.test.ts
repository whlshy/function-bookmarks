import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { emptyStore } from '../../../src/storage/marks';
import type { DirNode, FavGroupNode, FavoriteNode, FileNode, SymbolNode, TreeNode } from '../../../src/views/tree';

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

  describe('M2：收藏與自訂名稱', () => {
    it('加入收藏：寫入書籤檔，關閉所有檔案後收藏區仍看得到', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      const get = findNode(api.provider.currentSymbolNodes, 'ArticleView.get')!;
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', get);
      const text = await readStoreFile();
      assert.ok(text?.includes('"path": "ArticleView.get"'), text);
      assert.ok(api.provider.getTreeItem(get).description?.toString().startsWith('★'));

      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.refreshNow();
      await api.favorites.refresh();
      const groups = (await api.provider.getChildren(api.provider.sections.favorites)) as FavGroupNode[];
      assert.deepStrictEqual(groups.map((g) => g.rel), ['app/views.py']);
      const favs = (await api.provider.getChildren(groups[0])) as FavoriteNode[];
      assert.strictEqual(favs[0].fav.status, 'ok');
      assert.strictEqual(favs[0].fav.symbol?.nameLine, 11);
      assert.strictEqual(vscode.window.visibleTextEditors.length, 0, '背景讀取不應開啟分頁');
    });

    it('點擊收藏：開啟檔案並跳到函式', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', findNode(api.provider.currentSymbolNodes, 'index'));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.favorites.refresh();
      const fav = api.favorites.all[0];
      const item = api.provider.getTreeItem({ type: 'favorite', fav, parent: api.provider.sections.favorites });
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
      await api.commands.rename(get, '文章頁 GET');
      const item = api.provider.getTreeItem(get);
      assert.strictEqual(item.label, '文章頁 GET');
      assert.ok(item.description?.toString().startsWith('✎'));
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

    it('只顯示收藏／顯示全部；不分組時依名稱排序', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', findNode(api.provider.currentSymbolNodes, 'index'));
      await vscode.commands.executeCommand('functionBookmarks.addFavorite', findNode(api.provider.currentSymbolNodes, 'ArticleView.get'));
      await api.favorites.refresh();
      await vscode.commands.executeCommand('functionBookmarks.showFavoritesOnly');
      try {
        const roots = await api.provider.getChildren();
        assert.deepStrictEqual(roots.map((r) => (r.type === 'section' ? r.section : r.type)), ['favorites']);
        await vscode.commands.executeCommand('functionBookmarks.ungroup');
        const flat = (await api.provider.getChildren(api.provider.sections.favorites)) as FavoriteNode[];
        assert.deepStrictEqual(flat.map((f) => f.fav.mark.path), ['ArticleView.get', 'index']);
      } finally {
        await vscode.commands.executeCommand('functionBookmarks.groupByFile');
        await vscode.commands.executeCommand('functionBookmarks.showAll');
      }
      const roots = await api.provider.getChildren();
      assert.strictEqual(roots.length, 3);
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
      assert.deepStrictEqual(labels, ['app', 'static', 'templates']);
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
