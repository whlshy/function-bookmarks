import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { LSP_KIND } from '../../../src/symbols/symbolService';
import { collectProjectSymbols } from '../../../src/views/search';
import type { DirNode, FileNode, SymbolNode } from '../../../src/views/tree';
import { uriKey } from '../../../src/util/uris';
import {
  activateExtension,
  cleanupWorkspaceStore,
  findNode,
  folder,
  names,
  open,
  resetWorkspace,
  runAndCancelQuickOpen,
  waitFor,
  workspaceFile,
} from './helpers';

describe('函式偵測、多語言、整個專案與規則測試器', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await activateExtension();
  });

  beforeEach(async () => {
    await resetWorkspace(api);
  });

  after(async () => {
    api.ruleTester.stop();
    await cleanupWorkspaceStore(api);
  });

  describe('目前檔案的函式偵測與設定', () => {
    it('Python：列出 view 函式與類別方法，並以 nodeAt 找出游標最內層節點', async () => {
      const editor = await open(workspaceFile('app', 'views.py'), api);
      assert.deepStrictEqual(names(api.provider.currentSymbolNodes), ['index', { ArticleView: ['get', 'post'] }]);
      assert.strictEqual(api.provider.currentFile?.source, 'rules');
      const line = editor.document.getText().split('\n').findIndex((l) => l.includes('return "get"'));
      assert.strictEqual(api.provider.nodeAt(line)?.symbol.path, 'ArticleView.get');
    });

    it('Django template：只套用到 templates/ 下的 html，不套用到 static/plain.html', async () => {
      await open(workspaceFile('app', 'templates', 'app', 'login.html'), api);
      assert.deepStrictEqual(names(api.provider.currentSymbolNodes), [
        'base.html',
        { content: ['partials/nav.html', 'form'] },
        { scripts: ['submit'] },
      ]);
      await open(workspaceFile('static', 'plain.html'), api);
      assert.deepStrictEqual(api.provider.currentSymbolNodes, []);
    });

    it('Markdown：標題依層級列成目錄，程式碼區塊裡的 # 不算', async () => {
      await open(workspaceFile('docs', 'guide.md'), api);
      assert.deepStrictEqual(names(api.provider.currentSymbolNodes), [{ 使用手冊: ['安裝', { 設定: ['進階設定'] }] }]);
    });

    it('點擊函式：跳到名稱位置並選取', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      const post = findNode(api.provider.currentSymbolNodes, 'ArticleView.post')!;
      const item = api.provider.getTreeItem(post);
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      const editor = vscode.window.activeTextEditor!;
      assert.strictEqual(editor.document.getText(editor.selection), 'post');
    });

    it('編輯後重新整理，新函式出現', async () => {
      const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'function a() {}\n' });
      const editor = await vscode.window.showTextDocument(doc);
      await api.refreshNow();
      await editor.edit((b) => b.insert(new vscode.Position(1, 0), 'const b = () => {};\n'));
      await api.refreshNow();
      assert.deepStrictEqual(names(api.provider.currentSymbolNodes), ['a', 'b']);
    });

    it('detection.source = languageServer：改用語言伺服器（TypeScript 內建）且 LSP 種類映射完整', async () => {
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Interface], 'class');
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Struct], 'class');
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Enum], 'class');
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Module], 'block');
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Namespace], 'block');
      assert.strictEqual(LSP_KIND[vscode.SymbolKind.Package], 'block');

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
          { timeoutMs: 15000, label: 'TypeScript 語言伺服器回傳符號' },
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

  describe('Django template 連結與繼承', () => {
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

  describe('多語言與整個專案、搜尋函式', () => {
    after(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('多語言開檔（含無對應語言擴充時依副檔名回退）與整個專案清單都能正確偵測', async () => {
      // 驗證代表性內建語言與無擴充時走副檔名回退的語言（細部語法由單元測試完整涵蓋）
      const samples: [string, unknown[]][] = [
        ['Panel.tsx', [{ App: ['handleClick', 'renderItem'] }, 'Header', 'Footer', 'Card', 'Input', { Legacy: ['handleInc', 'componentDidMount', 'render'] }, { useCounter: ['inc'] }]],
        ['server.go', ['Server', 'Handler', 'NewServer', 'Server.Start', 'Server.Addr', 'Map']],
        ['Repo.kt', ['User', { Repo: ['load', 'second', 'create'] }, 'main']],
        ['greeter.proto', [{ Greeter: ['SayHello', 'Watch', 'WithOptions'] }, { HelloRequest: ['Inner', 'Mood', 'choice'] }, 'HelloReply', 'google.protobuf.MessageOptions']],
        ['Counter.vue', ['save', 'reset']],
        ['Widget.svelte', ['preload', 'increment']],
        ['deploy.sh', ['log', 'deploy', 'cleanup']],
        ['schema.sql', ['public.add_one', 'active_users', 'trg_audit']],
      ];
      for (const [file, want] of samples) {
        await open(workspaceFile('langs', file), api);
        assert.deepStrictEqual(names(api.provider.currentSymbolNodes), want, file);
      }

      // 整個專案與搜尋清單（不必開檔，且不含 extends／include reference）
      const entries = await api.collectProjectSymbols();
      const keys = entries.map((e) => `${e.rel}:${e.symbol.path}`);
      for (const k of [
        'app/views.py:ArticleView.get',
        'app/templates/app/login.html:content.form',
        'templates/base.html:title',
        'templates/partials/nav.html:links',
        'langs/point.rs:Point.new',
        'langs/server.go:Server.Start',
        'langs/invoice.rb:Billing.Invoice.total',
        'langs/Repo.kt:Repo.load',
        'langs/ViewController.swift:ViewController.viewDidLoad',
        'langs/greeter.proto:Greeter.SayHello',
        'langs/Counter.vue:save',
        'langs/Widget.svelte:increment',
        'langs/deploy.sh:deploy',
        'langs/schema.sql:public.add_one',
      ]) {
        assert.ok(keys.includes(k), `${k} 不在整個專案清單中`);
      }
      assert.ok(!entries.some((e) => e.symbol.kind === 'reference'));
    });

    it('整個專案：依資料夾列出檔案、展開才讀函式；沒有函式的檔案無展開鈕並直接開檔', async () => {
      const top = await api.provider.getChildren(api.provider.sections.project);
      const labels = top.map((n) => api.provider.getTreeItem(n).label);
      assert.deepStrictEqual(labels, ['app', 'docs', 'langs', 'static', 'templates']);

      const app = top[0] as DirNode;
      const views = ((await api.provider.getChildren(app)) as FileNode[]).find((n) => n.rel === 'app/views.py')!;
      const symbols = (await api.provider.getChildren(views)) as SymbolNode[];
      assert.deepStrictEqual(names(symbols), ['index', { ArticleView: ['get', 'post'] }]);

      const staticDir = top.find((n) => api.provider.getTreeItem(n).label === 'static') as DirNode;
      const files = (await api.provider.getChildren(staticDir)) as FileNode[];
      await api.provider.whenCounted();
      const plain = api.provider.getTreeItem(files[0]);
      assert.strictEqual(plain.collapsibleState, vscode.TreeItemCollapsibleState.None);
      assert.strictEqual(plain.command?.command, 'vscode.open');
      assert.strictEqual(api.provider.getTreeItem(views).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    });

    it('空專案時不必先點擊展開，「整個專案」自動變成無展開箭頭並顯示 No matching files', async () => {
      const cfg = vscode.workspace.getConfiguration('functionBookmarks');
      try {
        await cfg.update('project.include', '**/*.nonexistent_ext_xyz', vscode.ConfigurationTarget.Workspace);
        await api.provider.scheduleProjectEmptyCheck();
        await api.provider.whenProjectChecked();
        const item = api.provider.getTreeItem(api.provider.sections.project);
        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None, '空專案不應顯示展開箭頭');
        assert.strictEqual(item.description, 'No matching files');
      } finally {
        await cfg.update('project.include', undefined, vscode.ConfigurationTarget.Workspace);
        await api.provider.scheduleProjectEmptyCheck();
        await api.provider.whenProjectChecked();
      }
      const restored = api.provider.getTreeItem(api.provider.sections.project);
      assert.strictEqual(restored.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, '恢復後應重新顯示展開箭頭');
    });

    it('searchFunctions 掃描途中按 Esc 取消不報錯，且取消後不再觸發 onBatch（CR-08）', async () => {
      await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.searchFunctions'), 'searchFunctions 取消');
      // 取消後再執行一次並取消仍正常
      await runAndCancelQuickOpen(() => vscode.commands.executeCommand('functionBookmarks.searchFunctions'), 'searchFunctions 再次取消');

      const cts = new vscode.CancellationTokenSource();
      cts.cancel();
      let batches = 0;
      const project = { all: async () => [{ folder: folder(), rels: ['app/views.py'] }] } as unknown as Parameters<
        typeof collectProjectSymbols
      >[0];
      const service = { getForUri: async () => ({ symbols: [] }) } as unknown as Parameters<typeof collectProjectSymbols>[1];
      try {
        await collectProjectSymbols(
          project,
          service,
          api.store,
          () => {
            batches++;
          },
          cts.token,
        );
        assert.strictEqual(batches, 0, '取消後不應再呼叫 onBatch');
      } finally {
        cts.dispose();
      }
    });
  });

  describe('測試偵測規則（RuleTester）', () => {
    afterEach(async () => {
      api.ruleTester.stop();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('在目前檔案標示每條規則抓到的函式、編輯時自動更新，再執行一次關閉', async () => {
      await open(workspaceFile('app', 'views.py'), api);
      const hits = await vscode.commands.executeCommand<{ ruleId: string; name: string; nameLine: number }[]>(
        'functionBookmarks.testDetectionRules',
      );
      assert.ok(hits, '應有結果');
      const got = hits.map((h) => `${h.ruleId}:${h.name}:${h.nameLine}`);
      assert.ok(got.includes('py-def:index:4'), got.join(', '));
      assert.ok(got.some((g) => g.startsWith('py-class:ArticleView:')), got.join(', '));
      assert.ok(got.some((g) => g.endsWith(':get:11')), got.join(', '));
      assert.ok(api.ruleTester.testing);

      const editor = vscode.window.activeTextEditor!;
      await editor.edit((e) => e.insert(new vscode.Position(0, 0), 'def added():\n    pass\n'));
      const after = await waitFor(
        () => api.ruleTester.results,
        (r) => r.some((h) => h.name === 'added'),
        'RuleTester 編輯後自動更新結果',
      );
      assert.ok(after.some((h) => h.name === 'added' && h.nameLine === 0));
      await vscode.commands.executeCommand('undo');
      await vscode.commands.executeCommand('functionBookmarks.testDetectionRules');
      assert.strictEqual(api.ruleTester.testing, undefined, '再執行一次關閉');
      assert.deepStrictEqual(api.ruleTester.results, []);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    });

    it('分割視窗切換測試檔案時清除舊編輯器裝飾；update() 進行中呼叫 stop() 不會重畫裝飾（CR-12）', async () => {
      const fileA = workspaceFile('app', 'views.py');
      const fileB = workspaceFile('langs', 'server.go');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileA), { viewColumn: vscode.ViewColumn.One });
      await waitFor(
        () => vscode.window.activeTextEditor?.document.uri.toString(),
        (u) => u === fileA.toString(),
        '切換作用中編輯器到檔案 A',
      );

      const hitsA = await api.ruleTester.toggle(true);
      assert.ok(hitsA && hitsA.length > 0);
      assert.strictEqual(api.ruleTester.testing?.toString(), fileA.toString());
      assert.deepStrictEqual(api.ruleTester.decoratedUris(), [uriKey(fileA)]);

      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileB), { viewColumn: vscode.ViewColumn.Two });
      await waitFor(
        () => vscode.window.activeTextEditor?.document.uri.toString(),
        (u) => u === fileB.toString(),
        '切換作用中編輯器到檔案 B',
      );
      assert.ok(vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === fileA.toString()));
      const hitsB = await api.ruleTester.toggle(true);
      assert.ok(hitsB && hitsB.length > 0);
      assert.strictEqual(api.ruleTester.testing?.toString(), fileB.toString());
      assert.deepStrictEqual(api.ruleTester.decoratedUris(), [uriKey(fileB)], '切換檔案後應清空舊編輯器裝飾，只保留目前檔案');

      const pending = api.ruleTester.update();
      api.ruleTester.stop();
      const raceRes = await pending;
      assert.deepStrictEqual(raceRes, [], 'stop() 後進行中的 update() 應作廢');
      assert.deepStrictEqual(api.ruleTester.results, []);
      assert.deepStrictEqual(api.ruleTester.decoratedUris(), [], 'stop() 後不應重畫裝飾');
      assert.strictEqual(api.ruleTester.testing, undefined);
    });
  });
});
