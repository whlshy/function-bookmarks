import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { makeAnchor, newBookmarkId } from '../../../src/bookmarks/model';
import { EXPORT_FORMAT } from '../../../src/share/format';
import type { ImportResult, StoreImportResult } from '../../../src/share/importer';
import { addBookmark, emptyStore, serializeStore, setFavorite, setNote, setSymbolExtras, setTagColor } from '../../../src/storage/marks';
import type { BmGroupNode, BookmarkNode } from '../../../src/views/tree';
import {
  activateExtension,
  cleanBothStorages,
  cleanupWorkspaceStore,
  folder,
  openAt,
  resetWorkspace,
  runAndCancelQuickOpen,
  waitFor,
  workspaceFile,
} from './helpers';

describe('匯出、匯入書籤與來源管理', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await activateExtension();
  });

  beforeEach(async () => {
    await resetWorkspace(api, { closeEditors: true });
  });

  after(async () => {
    await cleanupWorkspaceStore(api);
  });

  describe('匯出、匯入（.fbookmarks.json／Markdown／CSV／導讀文件／alefragnani）與來源篩選', () => {
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
    type Exported = {
      bookmarks: { kind: string; line: number; label?: string; path?: string; anchor?: unknown; createdAt?: string }[];
      files?: Record<string, unknown>;
      includesCode: boolean;
    };

    const LINE_CREATED = '2026-11-26T01:02:00.000Z';
    const FN_CREATED = new Date('2026-11-26T03:04:00.000Z');

    async function setupMine(): Promise<void> {
      await api.external.idle();
      await fsp.writeFile(fileA().fsPath, text(BASE));
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, {
          id: newBookmarkId(),
          file: relA,
          line: 10,
          label: '改標題',
          tags: ['article'],
          note: '要檢查權限',
          anchor: makeAnchor(BASE, 10),
          createdAt: LINE_CREATED,
        });
        next = addBookmark(next, { id: newBookmarkId(), file: relA, line: 4, anchor: makeAnchor(BASE, 4) });
        return setFavorite(next, { file: relA, path: 'helper', kind: 'function' }, true, 3, FN_CREATED);
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
      vscode.commands.executeCommand<ImportResult>('functionBookmarks.importBookmarks', {
        text: t,
        folder: folder(),
        author,
        mode,
        confirmed: true,
      });

    const foreign = () => api.store.bookmarksFor(fileA()).filter((b) => b.source);

    after(async () => {
      await vscode.commands.executeCommand('functionBookmarks.filterBookmarkSources', []);
      await fsp.rm(fileA().fsPath, { force: true });
      await fsp.rm(workspaceFile('tmp_share_export.csv').fsPath, { force: true });
      await vscode.workspace.fs.delete(workspaceFile('.vscode', 'bookmarks.json')).then(undefined, () => undefined);
    });

    it('匯出 JSON：行號書籤＋函式書籤、行雜湊與剪貼簿；不含程式碼時省略雜湊與 anchor', async () => {
      await setupMine();
      const r = await exportJson(true);
      assert.strictEqual(r.count, 3);
      const data = JSON.parse(r.text) as Exported & { format: string; exportedBy: string };
      assert.strictEqual(data.format, 'function-bookmarks/v1');
      assert.ok(data.exportedBy);
      assert.deepStrictEqual(
        data.bookmarks.map((b) => [b.kind, b.line, b.label ?? b.path, b.createdAt]).sort(),
        [
          ['line', 10, '改標題', LINE_CREATED],
          ['line', 4, undefined, undefined],
          ['symbol', 3, 'helper', FN_CREATED.toISOString()],
        ].sort(),
      );
      assert.ok(data.files?.[relA], '附上行雜湊');
      assert.strictEqual(await vscode.env.clipboard.readText(), r.text);

      // 不含程式碼內容
      const noCodeText = (await exportJson(false)).text;
      const noCode = JSON.parse(noCodeText) as Exported;
      assert.strictEqual(noCode.includesCode, false);
      assert.strictEqual(noCode.files, undefined);
      assert.ok(noCode.bookmarks.every((b) => b.anchor === undefined));
      assert.ok(!noCodeText.includes('Article.objects'), '不含任何程式碼');
      await importText(noCodeText, 'amy.lin');
      assert.deepStrictEqual(
        api.store
          .bookmarksFor(fileA())
          .filter((b) => b.source?.author === 'amy.lin')
          .map((b) => b.line),
        [3, 4, 10],
      );
    });

    it('匯入：本機檔案改過後依行雜湊換算位置；函式書籤用名稱找；紫色圖示與懸停來源；取代與合併', async () => {
      await setupMine();
      const exported = (await exportJson()).text;
      await api.store.update(folder(), () => emptyStore());
      await api.favorites.refresh();

      const mine = ['import logging', 'import os', ...BASE.slice(0, 10), '    logger.info("saving")', ...BASE.slice(10)];
      await fsp.writeFile(fileA().fsPath, text(mine));
      const r = await importText(exported);
      assert.deepStrictEqual({ imported: r.imported, lost: r.lost }, { imported: 3, lost: 0 });
      assert.deepStrictEqual(
        foreign().map((b) => [b.line, mine[b.line].trim(), b.source?.author, b.symbol?.path]),
        [
          [5, 'def helper(payload):', 'alex.chen', 'helper'],
          [6, 'data = json.loads(payload)', 'alex.chen', undefined],
          [13, 'article.title = request.POST["title"]', 'alex.chen', undefined],
        ],
      );
      const labeled = foreign().find((b) => b.label === '改標題')!;
      assert.deepStrictEqual([labeled.tags, labeled.note, labeled.createdAt], [['article'], '要檢查權限', LINE_CREATED]);
      const importedFn = foreign().find((b) => b.symbol?.path === 'helper')!;
      assert.strictEqual(importedFn.createdAt, FN_CREATED.toISOString(), '匯入的函式書籤應保留原本的建立時間');

      await vscode.window.showTextDocument(fileA());
      api.gutter.schedule(0);
      const lines = await waitFor(() => api.gutter.linesFor(fileA(), 'foreign'), (v) => v.length === 3, '他人書籤紫色圖示出現');
      assert.deepStrictEqual(lines, [5, 6, 13]);
      const groups = await api.provider.getChildren(api.provider.sections.bookmarks);
      const g = groups.find((x) => (x as BmGroupNode).rel === relA)!;
      const node = (await api.provider.getChildren(g)).find((n) => (n as BookmarkNode).entry?.bookmark.label === '改標題') as BookmarkNode;
      const item = api.provider.getTreeItem(node);
      assert.ok(String(item.description).includes('@alex.chen'));
      assert.ok(String(item.contextValue).includes(':foreign'));
      assert.ok((item.tooltip as vscode.MarkdownString).value.replace(/\\/g, '').includes('From alex.chen'));
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

      // 同一來源再匯入：取代不重複、合併更新舊的加入新的，且自己的書籤不受影響
      await resetWorkspace(api, { closeEditors: true });
      await setupMine();
      const exp2 = (await exportJson()).text;
      await importText(exp2);
      await importText(exp2);
      assert.strictEqual(foreign().length, 3, '取代');
      const data = JSON.parse(exp2) as Exported;
      data.bookmarks.find((b) => b.label === '改標題')!.label = '改標題（新）';
      data.bookmarks.push({ ...data.bookmarks[0], kind: 'line', line: 12, label: '新的', anchor: undefined, path: undefined, id: 'new-one' } as never);
      await importText(JSON.stringify(data), 'alex.chen', 'merge');
      assert.deepStrictEqual(foreign().map((b) => b.label ?? '').sort(), ['', '', '改標題（新）', '新的'].sort());
      assert.strictEqual(api.store.bookmarksFor(fileA()).filter((b) => !b.source).length, 2, '自己的書籤仍在');
    });

    it('一般 .fbookmarks.json 匯入支援 symbolStart（函式內相對偏移）後備定位（CR-11）', async () => {
      const views = workspaceFile('app', 'views.py');
      const lines = (await fsp.readFile(views.fsPath, 'utf8')).split(/\r?\n/);
      const getIdx = lines.findIndex((l) => l.includes('def get('));
      assert.ok(getIdx >= 0);
      const exportPayload = JSON.stringify({
        format: EXPORT_FORMAT,
        exportedAt: new Date().toISOString(),
        exportedBy: 'teammate',
        includesCode: true,
        bookmarks: [
          {
            id: 'ext-sym-offset',
            file: 'app/views.py',
            kind: 'line',
            line: 0,
            label: '靠函式內偏移找回',
            anchor: {
              text: 'return "get_v1"',
              before: ['no_match_1', 'no_match_2'],
              after: ['no_match_3', 'no_match_4'],
              symbolPath: 'ArticleView.get',
              symbolOffset: 1,
            },
          },
        ],
      });
      const res = await vscode.commands.executeCommand<ImportResult>('functionBookmarks.importBookmarks', {
        text: exportPayload,
        author: 'teammate',
        confirmed: true,
      });
      assert.strictEqual(res?.imported, 1);
      assert.strictEqual(res?.lost, 0, '應透過 symbolStart + symbolOffset 定位成功');
      assert.strictEqual(api.store.bookmarksFor(views).find((b) => b.label === '靠函式內偏移找回')?.line, getIdx + 1);
    });

    it('側邊欄檔案列右鍵「匯出書籤…」（BmGroupNode）直接只匯出該檔（CR-04）', async () => {
      const views = workspaceFile('app', 'views.py');
      const guide = workspaceFile('docs', 'guide.md');
      await openAt(views, 1, api);
      await api.bookmarks.addLabeled('views 的書籤');
      await openAt(guide, 1, api);
      await api.bookmarks.addLabeled('guide 的書籤');
      await api.favorites.refresh();

      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const viewsGroup = groups.find((g) => g.by === 'file' && g.rel === 'app/views.py');
      assert.ok(viewsGroup);

      const res = await vscode.commands.executeCommand<{ count: number; text: string }>(
        'functionBookmarks.exportFileBookmarks',
        viewsGroup,
        { format: 'json', target: 'clipboard', includeCode: false },
      );
      assert.strictEqual(res?.count, 1, '應只匯出 app/views.py 的 1 個書籤');
      const parsed = JSON.parse(res.text) as { bookmarks: { file: string; label?: string }[] };
      assert.deepStrictEqual(parsed.bookmarks.map((b) => [b.file, b.label]), [['app/views.py', 'views 的書籤']]);
    });

    it('側邊欄標題列（…）的匯出、匯入、選擇存放位置收到選取中的樹節點時不當成參數，照常先詢問', async () => {
      // VS Code／Cursor 從標題列執行指令時，第一個參數是選取中的樹節點，第二個是選取清單
      const views = workspaceFile('app', 'views.py');
      await openAt(views, 1, api);
      await api.bookmarks.addLabeled('views 的書籤');
      await api.favorites.refresh();
      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const viewsGroup = groups.find((g) => g.by === 'file' && g.rel === 'app/views.py')!;
      assert.ok(viewsGroup);
      await vscode.env.clipboard.writeText('ORIGINAL_CLIPBOARD');

      // 匯出：不會直接只匯出選取的檔案，而是先問格式
      const exp = await runAndCancelQuickOpen(
        () => vscode.commands.executeCommand('functionBookmarks.exportBookmarks', viewsGroup, [viewsGroup]),
        '標題列匯出取消',
      );
      assert.strictEqual(exp, undefined);
      assert.strictEqual(await vscode.env.clipboard.readText(), 'ORIGINAL_CLIPBOARD');

      // 匯入：不會把檔案列的 uri（程式碼檔）當成要匯入的檔案，而是先問從檔案或剪貼簿
      const count = api.store.allBookmarks().length;
      const imp = await runAndCancelQuickOpen(
        () => vscode.commands.executeCommand('functionBookmarks.importBookmarks', viewsGroup, [viewsGroup]),
        '標題列匯入取消',
      );
      assert.strictEqual(imp, undefined);
      assert.strictEqual(api.store.allBookmarks().length, count);

      // 選擇存放位置：不會把樹節點存成存放設定
      const mode = api.store.effectiveStorageMode();
      const chosen = await runAndCancelQuickOpen(
        () => vscode.commands.executeCommand('functionBookmarks.chooseStorage', viewsGroup, [viewsGroup]),
        '標題列選擇存放位置取消',
      );
      assert.strictEqual(chosen, undefined);
      assert.strictEqual(api.store.effectiveStorageMode(), mode);
    });

    it('篩選來源、依來源分組、上下跳轉只在篩選結果內；改來源名、轉成我的、刪除來源', async () => {
      await setupMine();
      await importText((await exportJson()).text);
      await vscode.commands.executeCommand('functionBookmarks.groupBookmarksBySource');
      try {
        let groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
        assert.deepStrictEqual(groups.map((g) => [g.key, g.items.length]), [
          ['', 3],
          ['alex.chen', 3],
        ]);
        await vscode.commands.executeCommand('functionBookmarks.filterBookmarkSources', ['alex.chen']);
        groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
        assert.deepStrictEqual(groups.map((g) => g.key), ['']);
        assert.ok(String(api.treeView.description).includes('filtered'));
        const editor = await openAt(fileA(), 0, api);
        assert.strictEqual(editor.document.uri.toString(), fileA().toString());
        const visited = new Set<number>();
        const trace: string[] = [];
        for (let i = 0; i < 6; i++) {
          const curLine = vscode.window.activeTextEditor?.selection.active.line;
          const hit = (await api.bookmarks.go(1))!;
          const afterLine = vscode.window.activeTextEditor?.selection.active.line;
          trace.push(`${curLine}->${hit.line}(sel:${afterLine})`);
          visited.add(hit.line);
        }
        assert.deepStrictEqual(
          [...visited].sort((a, b) => a - b),
          [3, 4, 10],
          `只在自己的書籤間跳（trace=${trace.join(', ')}, bms=${JSON.stringify(api.store.shownBookmarksFor(fileA()).map((b) => b.line))}, favs=${JSON.stringify(api.favorites.all.map((f) => [f.mark.path, f.symbol?.nameLine, f.mark.line, f.status]))}）`,
        );
        await vscode.commands.executeCommand('functionBookmarks.filterBookmarkSources', []);

        assert.ok(await vscode.commands.executeCommand('functionBookmarks.renameBookmarkSource', 'alex.chen', 'alex'));
        assert.ok(foreign().every((b) => b.source?.author === 'alex'));
        const one = api.store.allBookmarks().find((e) => e.bookmark.source && e.bookmark.label === '改標題')!;
        await vscode.commands.executeCommand('functionBookmarks.makeBookmarkMine', { type: 'bookmark', entry: one });
        assert.strictEqual(foreign().length, 2);
        assert.strictEqual(await vscode.commands.executeCommand('functionBookmarks.deleteBookmarkSource', 'alex', true), 2);
        assert.strictEqual(foreign().length, 0);
        assert.deepStrictEqual(api.store.sources(), []);
      } finally {
        await vscode.commands.executeCommand('functionBookmarks.groupBookmarksByFile');
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
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
      assert.ok(csv.startsWith('\uFEFFFile,Line,Name,Kind,Tags,Note,Source'));
      assert.ok(csv.includes('app/tmp_share_a.py,4,helper,function,,,'));
      assert.strictEqual(csv.trim().split('\r\n').length, 4);
    });

    it('匯出導讀文件（Markdown）：編號在前、函式超 30 行截斷、行號取前後 3 行、不含程式碼省略片段', async () => {
      const longFile = workspaceFile('tmp_long_guide.py');
      const outUri = workspaceFile('.tmp-guide-out.md');
      const longLines = ['def very_long_fn():', ...Array.from({ length: 35 }, (_, i) => `    v${i} = ${i}`), '    return v0', ''];
      await vscode.workspace.fs.writeFile(longFile, new TextEncoder().encode(longLines.join('\n')));
      try {
        await api.store.update(folder(), (d) => {
          let next = setFavorite(d, { file: 'tmp_long_guide.py', path: 'very_long_fn', kind: 'function' }, true, 0);
          next = setNote(next, { file: 'tmp_long_guide.py', path: 'very_long_fn', kind: 'function' }, '超長函式備註', 0);
          next = { ...next, symbols: next.symbols.map((m) => ({ ...m, number: 1 })) };
          next = addBookmark(next, { id: newBookmarkId(), file: 'app/views.py', line: 5, label: '重點行', note: '行號備註原文', number: 3 });
          return addBookmark(next, { id: newBookmarkId(), file: 'app/views.py', line: 1, label: '未編號書籤' });
        });
        await api.favorites.refresh();

        const withCode = await vscode.commands.executeCommand<{ count: number; text: string }>('functionBookmarks.exportBookmarks', {
          folder: folder(),
          scope: { kind: 'all' },
          format: 'guide',
          includeCode: true,
          target: outUri,
        });
        assert.strictEqual(withCode?.count, 3);
        const guideText = withCode!.text;
        assert.ok(guideText.indexOf('## 1. very_long_fn') < guideText.indexOf('## 3. 重點行'));
        assert.ok(guideText.indexOf('## 3. 重點行') < guideText.indexOf('## 未編號書籤'));
        assert.ok(guideText.includes('```python\ndef very_long_fn():'));
        assert.ok(guideText.includes('more line(s) omitted'));
        assert.ok(guideText.includes('超長函式備註') && guideText.includes('行號備註原文'));

        const noCode = await vscode.commands.executeCommand<{ count: number; text: string }>('functionBookmarks.exportBookmarks', {
          folder: folder(),
          scope: { kind: 'all' },
          format: 'guide',
          includeCode: false,
          target: outUri,
        });
        assert.strictEqual(noCode?.count, 3);
        assert.ok(!noCode!.text.includes('```'));
        assert.ok(noCode!.text.includes('超長函式備註'));
      } finally {
        await vscode.workspace.fs.delete(outUri).then(undefined, () => undefined);
        await vscode.workspace.fs.delete(longFile).then(undefined, () => undefined);
      }
    });

    it('匯出導讀文件、Markdown 表格與 CSV：需確認、不在目前分支、找不到函式或檔案要標示，不照行號貼程式碼', async () => {
      await fsp.writeFile(fileA().fsPath, text(BASE));
      const remembered = { text: 'remembered_call()', before: [], after: [] };
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, { id: newBookmarkId(), file: relA, line: 4, label: '需確認的', status: 'lost', anchor: remembered });
        next = addBookmark(next, {
          id: newBookmarkId(),
          file: relA,
          line: 10,
          label: '別的分支的',
          status: 'notOnBranch',
          anchor: { text: 'other_branch_call()', before: [], after: [] },
        });
        next = setFavorite(next, { file: relA, path: 'vanished_function', kind: 'function' }, true, 100);
        return setFavorite(next, { file: 'app/tmp_share_gone.py', path: 'gone', kind: 'function' }, true, 0);
      });
      await api.favorites.refresh();
      await api.external.idle();

      const run = async (format: 'guide' | 'markdown' | 'csv') =>
        (await vscode.commands.executeCommand<{ count: number; text: string }>('functionBookmarks.exportBookmarks', {
          folder: folder(),
          scope: { kind: 'all' },
          includeImported: false,
          format,
          includeCode: true,
          target: 'clipboard',
        }))!;

      const guide = (await run('guide')).text;
      for (const warning of [
        '## 需確認的\n\n> ⚠ Needs checking: the original line could not be found. Below is the last remembered content.',
        '## 別的分支的\n\n> ⚠ Not on the current branch',
        '## vanished_function\n\n> ⚠ Function not found',
        '## gone\n\n> ⚠ File not found',
      ]) {
        assert.ok(guide.includes(warning), `${warning}\n---\n${guide}`);
      }
      assert.ok(guide.includes('```python\nremembered_call()\n```'));
      assert.strictEqual(guide.split('```').length, 3, '只有需確認的那一筆有程式碼');
      assert.ok(!guide.includes('json.loads') && !guide.includes('article.title') && !guide.includes('other_branch_call'));

      const md = (await run('markdown')).text;
      assert.ok(md.startsWith('| File | Line | Name | Tags | Note | Code | Status |'), md);
      assert.ok(md.includes('| 需確認的 |  |  | `remembered_call()` | needs checking |'), md);
      assert.ok(md.includes('| 別的分支的 |  |  |  | not on this branch |'), md);
      assert.ok(md.includes('| function not found |') && md.includes('| file not found |'), md);
      assert.ok(!md.includes('json.loads') && !md.includes('article.title'));

      const csv = (await run('csv')).text;
      assert.ok(csv.startsWith('﻿File,Line,Name,Kind,Tags,Note,Code,Source,Status\r\n'), csv);
      assert.ok(csv.includes(',需確認的,line,,,remembered_call(),,needs checking\r\n'), csv);
      assert.ok(csv.includes(',別的分支的,line,,,,,not on this branch\r\n'), csv);
      assert.ok(!csv.includes('json.loads') && !csv.includes('article.title'));
    });

    it('匯出 JSON：位置不可靠的書籤帶狀態、不用目前那一行當 anchor；匯入後只用記得的內容找，找不到標需確認', async () => {
      await fsp.writeFile(fileA().fsPath, text(BASE));
      await api.store.update(folder(), (d) => {
        // 找不到的函式：記得的行號 12 現在是 return JsonResponse(...)，不能拿來當 anchor
        // （離每個函式都超過 3 行，不會被當成改名接到別的函式）
        let next = setFavorite(d, { file: relA, path: 'vanished_function', kind: 'function' }, true, 12);
        // 需確認的行號書籤：記得的內容在本機另一行還找得到
        next = addBookmark(next, { id: newBookmarkId(), file: relA, line: 1, label: '找得回來', status: 'lost', anchor: makeAnchor(BASE, 4) });
        // 需確認且記得的內容已不存在
        return addBookmark(next, {
          id: newBookmarkId(),
          file: relA,
          line: 10,
          label: '找不回來',
          status: 'lost',
          anchor: { text: 'remembered_call()', before: [], after: [] },
        });
      });
      await api.favorites.refresh();
      await api.external.idle();

      const exported = (await exportJson()).text;
      const data = JSON.parse(exported) as { bookmarks: { label?: string; path?: string; status?: string; anchor?: { text: string } }[] };
      const fn = data.bookmarks.find((b) => b.path === 'vanished_function')!;
      assert.strictEqual(fn.status, 'missing');
      assert.strictEqual(fn.anchor, undefined, '找不到的函式不能用舊行號的內容當 anchor');
      const back = data.bookmarks.find((b) => b.label === '找得回來')!;
      assert.deepStrictEqual([back.status, back.anchor?.text], ['lost', 'data = json.loads(payload)'], '需確認的帶最後記得的內容');

      await api.store.update(folder(), () => emptyStore());
      await api.favorites.refresh();
      const r = await importText(exported);
      assert.strictEqual(r.imported, 3);
      const got = (pred: (b: ReturnType<typeof foreign>[number]) => boolean) => foreign().find(pred)!;
      const importedFn = got((b) => b.symbol?.path === 'vanished_function');
      assert.strictEqual(importedFn.status, 'lost', '本機也找不到這個函式：標需確認，不照行號放到 save_article');
      assert.deepStrictEqual([got((b) => b.label === '找得回來').line, got((b) => b.label === '找得回來').status], [4, undefined], '用記得的內容找回原本那一行');
      assert.strictEqual(got((b) => b.label === '找不回來').status, 'lost');
    });

    it('匯入 alefragnani Bookmarks 的 .vscode/bookmarks.json：匯入成自己的書籤，重複匯入不重複', async () => {
      await fsp.writeFile(fileA().fsPath, text(BASE));
      const json = {
        files: [
          {
            path: relA,
            bookmarks: [
              { line: 3, column: 0, label: '登入' },
              { line: 4, column: 3, label: '' },
              { line: 999, column: 0, label: '' },
            ],
          },
          { path: 'app/not_exists.py', bookmarks: [{ line: 1, column: 0, label: '' }] },
        ],
      };
      const oldUri = workspaceFile('.vscode', 'bookmarks.json');
      await vscode.workspace.fs.writeFile(oldUri, new TextEncoder().encode(JSON.stringify(json, null, '\t')));
      type R = { format: string; imported: number; skipped: number };
      const importOld = () => vscode.commands.executeCommand<R>('functionBookmarks.importBookmarks', { uri: oldUri, confirmed: true });

      const r = await importOld();
      assert.deepStrictEqual({ format: r.format, imported: r.imported, skipped: r.skipped }, { format: 'alefragnani', imported: 2, skipped: 2 });
      assert.deepStrictEqual(
        api.store.bookmarksFor(fileA()).map((b) => [b.line, b.label, b.anchor?.text, b.source]),
        [
          [3, '登入', BASE[3], undefined],
          [4, undefined, BASE[4].trim(), undefined],
        ],
      );
      const again = await importOld();
      assert.deepStrictEqual({ imported: again.imported, skipped: again.skipped }, { imported: 0, skipped: 4 });
      assert.strictEqual(api.store.bookmarksFor(fileA()).length, 2);
    });

    it('匯出、匯入、篩選來源與修改來源註記按 Esc 取消不改動狀態，再做一次正常完成（CR-19）', async () => {
      await setupMine();
      await importText((await exportJson()).text, 'alex.chen');
      await vscode.env.clipboard.writeText('ORIGINAL_CLIPBOARD');

      // 1. 匯出開 QuickPick 按 Esc 取消：回傳 undefined 且不改剪貼簿
      const expCanceled = await runAndCancelQuickOpen(
        () => vscode.commands.executeCommand('functionBookmarks.exportBookmarks'),
        'exportBookmarks 取消',
      );
      assert.strictEqual(expCanceled, undefined);
      assert.strictEqual(await vscode.env.clipboard.readText(), 'ORIGINAL_CLIPBOARD');

      // 2. 匯入開 QuickPick 按 Esc 取消：書籤數量不變
      const countBefore = api.store.allBookmarks().length;
      const impCanceled = await runAndCancelQuickOpen(
        () => vscode.commands.executeCommand('functionBookmarks.importBookmarks'),
        'importBookmarks 取消',
      );
      assert.strictEqual(impCanceled, undefined);
      assert.strictEqual(api.store.allBookmarks().length, countBefore);

      // 3. 篩選來源開 QuickPick 按 Esc 取消：隱藏來源清單不變
      api.store.setHiddenSources(['alex.chen']);
      await runAndCancelQuickOpen(
        () => vscode.commands.executeCommand('functionBookmarks.filterBookmarkSources'),
        'filterBookmarkSources 取消',
      );
      assert.deepStrictEqual(api.store.hiddenSourceList, ['alex.chen']);
      api.store.setHiddenSources([]);

      // 4. 修改來源註記開 InputBox 按 Esc 取消：來源名稱維持不變
      const renamed = await runAndCancelQuickOpen(
        () => vscode.commands.executeCommand<boolean>('functionBookmarks.renameBookmarkSource', 'alex.chen'),
        'renameBookmarkSource 取消',
      );
      assert.strictEqual(renamed, false);
      assert.deepStrictEqual(api.store.sources(), ['alex.chen']);

      // 取消後再做一次匯出：正常執行
      const expOk = await exportJson(false);
      assert.strictEqual(expOk.count, 3);
    });
  });

  describe('來源篩選隱藏行為（隱藏「我的」或他人來源的保護）', () => {
    const fileR = () => workspaceFile('app', 'tmp_source_hide.py');
    const relR = 'app/tmp_source_hide.py';
    const LINES = ['def alpha():', '    x = 1', '    return x', '', 'x_global = 1', 'y_global = 2', 'def beta():', '    return 2', ''];
    const alphaKey = { file: relR, path: 'alpha', kind: 'function' as const };
    const betaKey = { file: relR, path: 'beta', kind: 'function' as const };
    const source = (author: string) => ({ author, importId: 'i1', originalId: newBookmarkId(), importedAt: '2026-01-01T00:00:00.000Z' });
    const lineBms = () => api.store.bookmarksFor(fileR());
    const sectionDesc = () => String(api.provider.getTreeItem(api.provider.sections.bookmarks).description);
    const groupsOf = async () => (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];

    async function setupThree(): Promise<void> {
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, { id: newBookmarkId(), file: relR, line: 4, anchor: makeAnchor(LINES, 4) });
        next = addBookmark(next, { id: newBookmarkId(), file: relR, line: 5, anchor: makeAnchor(LINES, 5), source: source('bob') });
        return setFavorite(next, alphaKey, true, 0);
      });
      await api.favorites.refresh();
    }

    before(async () => {
      await fsp.writeFile(fileR().fsPath, LINES.join('\n'));
    });

    afterEach(async () => {
      api.store.setHiddenSources([]);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    after(async () => {
      await fsp.rm(fileR().fsPath, { force: true });
    });

    it('隱藏「我的」或他人來源：側邊欄、標題數字、行號圖示、上下跳轉與狀態列同步更新', async () => {
      await setupThree();
      await openAt(fileR(), 0, api);
      await api.gutter.update();
      api.statusBar.update();
      assert.strictEqual(sectionDesc(), '3');
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), [0]);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'bookmark'), [4]);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'foreign'), [5]);
      assert.strictEqual(api.statusBar.text, '$(bookmark) 3');

      // 隱藏「我的」
      api.store.setHiddenSources(['']);
      await api.gutter.update();
      api.statusBar.update();
      const groups = await groupsOf();
      assert.deepStrictEqual(groups.map((g) => g.items.length), [1]);
      const kids = await api.provider.getChildren(groups[0]);
      assert.strictEqual((kids[0] as BookmarkNode).entry.bookmark.source?.author, 'bob');
      assert.strictEqual(sectionDesc(), '1');
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), []);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'bookmark'), []);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'foreign'), [5]);
      assert.ok(api.statusBar.text?.startsWith('$(bookmark) 1 '), api.statusBar.text);
      for (let i = 0; i < 3; i++) {
        assert.strictEqual((await api.bookmarks.go(1))?.line, 5);
      }
      assert.strictEqual((await api.bookmarks.go(-1))?.line, 5);

      // 隱藏 bob：自己的照常顯示
      api.store.setHiddenSources(['bob']);
      await api.gutter.update();
      assert.strictEqual(sectionDesc(), '2');
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), [0]);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'foreign'), []);

      // 恢復顯示
      api.store.setHiddenSources([]);
      await api.gutter.update();
      assert.strictEqual(sectionDesc(), '3');
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), [0]);
    });

    it('隱藏「我的」：有備註的函式書籤不改顯示備註圖示；只有備註的函式照常顯示', async () => {
      await setupThree();
      await api.store.update(folder(), (d) => setNote(setNote(d, alphaKey, 'alpha 的備註', 0), betaKey, 'beta 的備註', 6));
      await api.favorites.refresh();
      await openAt(fileR(), 0, api);
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), [0]);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'note'), [6]);

      api.store.setHiddenSources(['']);
      await api.gutter.update();
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'favorite'), []);
      assert.deepStrictEqual(api.gutter.linesFor(fileR(), 'note'), [6]);
    });

    it('清除檔案／清除全部：只清除看得到的，保留不在此分支與被來源篩選隱藏的書籤', async () => {
      await setupThree();
      const awayId = newBookmarkId();
      await api.store.update(folder(), (d) =>
        addBookmark(d, {
          id: awayId,
          file: relR,
          line: 1,
          anchor: makeAnchor(['f0', 'f1', 'f2'], 1),
          status: 'notOnBranch',
        }),
      );
      await openAt(fileR(), 0, api);

      // 隱藏 bob 時清除檔案與全部：保留 notOnBranch 與 bob
      api.store.setHiddenSources(['bob']);
      await api.bookmarks.clearFile(fileR(), true);
      assert.strictEqual(lineBms().length, 2);
      assert.strictEqual(lineBms().find((b) => b.id === awayId)?.status, 'notOnBranch');
      assert.ok(lineBms().some((b) => b.source?.author === 'bob'));
      await api.favorites.refresh();
      assert.strictEqual(api.favorites.all.length, 0);

      await api.store.update(folder(), (d) =>
        setFavorite(addBookmark(d, { id: newBookmarkId(), file: relR, line: 5, anchor: makeAnchor(LINES, 5) }), betaKey, true, 6),
      );
      await api.favorites.refresh();
      await api.bookmarks.clearAll(true);
      await api.favorites.refresh();
      assert.strictEqual(lineBms().length, 2);
      assert.strictEqual(api.favorites.all.length, 0);

      // 隱藏「我的」時清除檔案與全部：只清 bob，保留自己的行號與函式書籤
      await resetWorkspace(api);
      await setupThree();
      await openAt(fileR(), 0, api);
      api.store.setHiddenSources(['']);
      await api.bookmarks.clearFile(fileR(), true);
      assert.deepStrictEqual(lineBms().map((b) => [b.line, b.source?.author]), [[4, undefined]]);
      assert.ok(api.store.get(fileR(), alphaKey)?.favorite);
      await api.bookmarks.clearAll(true);
      assert.strictEqual(lineBms().length, 1);
      api.store.setHiddenSources([]);
      await api.bookmarks.clearAll(true);
      await api.favorites.refresh();
      assert.strictEqual(lineBms().length, 0);
      assert.strictEqual(api.favorites.all.length, 0);
    });

    it('「我的」被隱藏時新增／切換／設號碼：不改篩選、提示顯示，不誤取消看不到的書籤', async () => {
      // 函式行新增
      await openAt(fileR(), 6, api);
      api.store.setHiddenSources(['']);
      let before = api.bookmarks.mineHiddenNotices;
      await api.bookmarks.toggle({ uri: fileR(), line: 6 });
      assert.ok(api.store.get(fileR(), betaKey)?.favorite);
      assert.ok(api.store.hiddenSourceList.includes(''));
      assert.strictEqual(api.bookmarks.mineHiddenNotices, before + 1);

      // 已有函式書籤看不到時按切換不取消
      await api.store.update(folder(), (d) => setFavorite(d, alphaKey, true, 0));
      await api.favorites.refresh();
      await openAt(fileR(), 0, api);
      before = api.bookmarks.mineHiddenNotices;
      await api.bookmarks.toggle({ uri: fileR(), line: 0 });
      await api.favorites.refresh();
      assert.ok(api.store.get(fileR(), alphaKey)?.favorite, '看不到的函式書籤不取消');
      assert.strictEqual(api.bookmarks.mineHiddenNotices, before + 1);
      api.store.setHiddenSources([]);
      await api.bookmarks.toggle({ uri: fileR(), line: 0 });
      assert.ok(!api.store.get(fileR(), alphaKey)?.favorite);

      // 一般行新增、再按不重複也不取消，並可設定號碼
      await openAt(fileR(), 5, api);
      api.store.setHiddenSources(['']);
      await api.bookmarks.toggle({ uri: fileR(), line: 5 });
      assert.deepStrictEqual(lineBms().map((b) => b.line), [5]);
      await api.bookmarks.toggle({ uri: fileR(), line: 5 });
      assert.deepStrictEqual(lineBms().map((b) => b.line), [5]);
      await api.extras.setNumber({ type: 'line', uri: fileR(), line: 5 }, 7, true);
      assert.strictEqual(lineBms().find((x) => x.line === 5)?.number, 7);
      assert.ok(api.store.hiddenSourceList.includes(''));
    });
  });

  describe('匯入套件書籤檔（.vscode/function-bookmarks.json）', () => {
    it('空白時匯入：視為自己的書籤、保留他方來源／函式書籤／標籤顏色並重新定位', async () => {
      const targetUri = workspaceFile('app', 'tmp_store_import.py');
      const importFileUri = workspaceFile('.tmp-import-store.json');
      try {
        const codeLines = ['# added 1', '# added 2', '# added 3', 'def greet():', '    target_value = 42', '    return target_value'];
        await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(codeLines.join('\n') + '\n'));

        let incoming = emptyStore();
        incoming = setFavorite(incoming, { file: 'app/tmp_store_import.py', path: 'greet', kind: 'function' }, true, 0);
        incoming = addBookmark(incoming, {
          id: 'moved-own',
          file: 'app/tmp_store_import.py',
          line: 1,
          label: '位移書籤',
          anchor: { text: 'target_value = 42', before: ['def greet():'], after: ['return target_value'] },
        });
        incoming = addBookmark(incoming, {
          id: 'gone-code',
          file: 'app/tmp_store_import.py',
          line: 2,
          label: '已刪除的程式碼',
          anchor: { text: 'deleted_statement_xyz()', before: [], after: [] },
        });
        incoming = addBookmark(incoming, { id: 'missing-file', file: 'app/no_such_file.py', line: 0, label: '不存在的檔案' });
        incoming = addBookmark(incoming, {
          id: 'colleague-bm',
          file: 'app/tmp_store_import.py',
          line: 2,
          label: '同事筆記',
          anchor: { text: 'return target_value', before: ['target_value = 42'], after: [] },
          source: { author: 'alex.chen', importId: 'imp1', originalId: 'orig1', importedAt: '2026-11-25T00:00:00Z' },
        });
        incoming = setTagColor(incoming, 'important', 'red');
        await vscode.workspace.fs.writeFile(importFileUri, new TextEncoder().encode(serializeStore(incoming)));

        api.store.suppressStoragePrompt = true;
        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
        const res = await vscode.commands.executeCommand<StoreImportResult>('functionBookmarks.importBookmarks', {
          uri: importFileUri,
          confirmed: true,
        });
        assert.deepStrictEqual(
          { format: res?.format, imported: res?.imported, lost: res?.lost, missingFiles: res?.missingFiles },
          { format: 'store', imported: 5, lost: 2, missingFiles: 1 },
        );

        const bms = api.store.allBookmarks({ includeHidden: true }).map((e) => e.bookmark);
        const moved = bms.find((b) => b.id === 'moved-own')!;
        assert.strictEqual(moved.line, 4);
        assert.strictEqual(moved.status, undefined);
        assert.strictEqual(moved.source, undefined);
        assert.strictEqual(bms.find((b) => b.id === 'gone-code')?.status, 'lost');
        assert.strictEqual(bms.find((b) => b.id === 'missing-file')?.status, 'lost');
        const colleague = bms.find((b) => b.id === 'colleague-bm')!;
        assert.strictEqual(colleague.line, 5);
        assert.strictEqual(colleague.source?.author, 'alex.chen');

        const fnMark = api.store.get(targetUri, { path: 'greet', kind: 'function' });
        assert.strictEqual(fnMark?.favorite, true);
        assert.strictEqual(fnMark?.line, 3);
        assert.strictEqual(api.store.tagColors().get('important'), 'red');
      } finally {
        await vscode.workspace.fs.delete(targetUri).then(undefined, () => undefined);
        await vscode.workspace.fs.delete(importFileUri).then(undefined, () => undefined);
        await cleanBothStorages(api);
      }
    });

    it('已有書籤時支援合併與取代；選到正在使用的書籤檔辨識為 alreadyActive 不改動', async () => {
      const importFileUri = workspaceFile('.tmp-merge-store.json');
      try {
        await api.store.update(folder(), (d) => {
          const next = addBookmark(d, { id: 'active-bm', file: 'app/views.py', line: 0, label: '目前使用中', number: 1 });
          return setTagColor(next, 'keep', 'blue');
        });
        await api.store.flush();

        const selfRes = await vscode.commands.executeCommand<StoreImportResult>('functionBookmarks.importBookmarks', {
          uri: workspaceFile('.vscode', 'function-bookmarks.json'),
          confirmed: true,
        });
        assert.strictEqual(selfRes?.format, 'store');
        assert.strictEqual(selfRes?.alreadyActive, true);
        assert.deepStrictEqual(api.store.allBookmarks().map((e) => e.bookmark.id), ['active-bm']);

        let other = emptyStore();
        other = addBookmark(other, { id: 'new-bm', file: 'app/views.py', line: 2, label: '匯入新書籤', number: 1 });
        other = setSymbolExtras(
          setFavorite(other, { file: 'app/views.py', path: 'index', kind: 'function' }, true, 0),
          { file: 'app/views.py', path: 'index', kind: 'function' },
          { number: 2 },
        );
        other = setTagColor(other, 'added', 'green');
        await vscode.workspace.fs.writeFile(importFileUri, new TextEncoder().encode(serializeStore(other)));

        const mergeRes = await vscode.commands.executeCommand<StoreImportResult>('functionBookmarks.importBookmarks', {
          uri: importFileUri,
          mode: 'merge',
          confirmed: true,
        });
        assert.strictEqual(mergeRes?.mode, 'merge');
        const mergedBms = api.store.allBookmarks().map((e) => e.bookmark);
        assert.deepStrictEqual(mergedBms.map((b) => b.id).sort(), ['active-bm', 'new-bm']);
        assert.strictEqual(mergedBms.find((b) => b.id === 'active-bm')?.number, 1);
        assert.strictEqual(mergedBms.find((b) => b.id === 'new-bm')?.number, undefined);
        assert.strictEqual(api.store.allFavorites().length, 1);
        assert.strictEqual(api.store.tagColors().get('keep'), 'blue');
        assert.strictEqual(api.store.tagColors().get('added'), 'green');

        const replaceRes = await vscode.commands.executeCommand<StoreImportResult>('functionBookmarks.importBookmarks', {
          uri: importFileUri,
          mode: 'replace',
          confirmed: true,
        });
        assert.strictEqual(replaceRes?.mode, 'replace');
        const replacedBms = api.store.allBookmarks().map((e) => e.bookmark);
        assert.deepStrictEqual(replacedBms.map((b) => b.id), ['new-bm']);
        assert.strictEqual(replacedBms[0].number, 1);
        assert.strictEqual(api.store.tagColors().get('keep'), undefined);
        assert.strictEqual(api.store.tagColors().get('added'), 'green');
      } finally {
        await vscode.workspace.fs.delete(importFileUri).then(undefined, () => undefined);
        await cleanBothStorages(api);
      }
    });

    it('僅含 tagColors、replace 內部重複號碼去重、homeBranch 隱藏與 positions 清理（CR-11）', async () => {
      const r1 = await vscode.commands.executeCommand<StoreImportResult>('functionBookmarks.importBookmarks', {
        text: JSON.stringify({ version: 1, symbols: [], bookmarks: [], tagColors: { urgent: 'red' } }),
        confirmed: true,
      });
      assert.deepStrictEqual({ format: r1?.format, imported: r1?.imported, tagColors: r1?.tagColors }, { format: 'store', imported: 0, tagColors: 1 });
      assert.strictEqual(api.store.tagColors().get('urgent'), 'red');

      const prevBranchOf = api.store.branchOf;
      api.store.branchOf = () => 'main';
      try {
        const dupAndBranch = serializeStore({
          version: 1,
          symbols: [],
          bookmarks: [
            { id: 'b-main-1', file: 'app/views.py', line: 1, label: '主分支一', number: 1, positions: { main: { line: 99 }, 'other-branch': { line: 5 } } },
            { id: 'b-main-2', file: 'app/views.py', line: 2, label: '主分支二', number: 1 },
            {
              id: 'b-hidden',
              file: 'app/nonexistent_other_branch.py',
              line: 10,
              label: '其他分支限定',
              scope: 'branch',
              homeBranch: 'other-branch',
              anchor: { text: 'only on other', before: ['', ''], after: ['', ''] },
            },
          ],
        });
        const r2 = await vscode.commands.executeCommand<StoreImportResult>('functionBookmarks.importBookmarks', {
          text: dupAndBranch,
          mode: 'replace',
          confirmed: true,
        });
        assert.strictEqual(r2?.hiddenOnBranch, 1);
        assert.strictEqual(r2?.lost, 0);

        const all = api.store.allBookmarks({ includeHidden: true }).map((e) => e.bookmark);
        const m1 = all.find((b) => b.id === 'b-main-1')!;
        const m2 = all.find((b) => b.id === 'b-main-2')!;
        const hid = all.find((b) => b.id === 'b-hidden')!;
        assert.strictEqual(m1.number, 1);
        assert.strictEqual(m2.number, undefined, 'replace 模式應去除檔案內重複號碼');
        assert.deepStrictEqual(m1.positions, { 'other-branch': { line: 5 } });
        assert.strictEqual(hid.status, undefined);
        assert.strictEqual(hid.line, 10);
      } finally {
        api.store.branchOf = prevBranchOf;
      }
    });

    it('workspaceState 搬移提示未處理時，匯入另一端書籤檔會記為已處理，重開不重複提示（CR-11）', async () => {
      api.store.suppressStoragePrompt = true;
      try {
        await api.store.update(folder(), (d) => addBookmark(d, { id: 'opp-1', file: 'app/views.py', line: 1, label: '另一端檔案書籤' }));
        await api.store.flush();

        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
        assert.ok(await api.store.checkOppositeStorage());

        const res = await vscode.commands.executeCommand<StoreImportResult>('functionBookmarks.importBookmarks', {
          uri: workspaceFile('.vscode', 'function-bookmarks.json'),
          confirmed: true,
        });
        assert.strictEqual(res?.format, 'store');
        assert.strictEqual(res?.imported, 1);
        assert.strictEqual(api.store.lastOppositeCheck, undefined);

        await api.store.update(folder(), () => emptyStore());
        const reopened = api.recreateStore();
        reopened.suppressStoragePrompt = true;
        try {
          await reopened.init();
          assert.strictEqual(await reopened.checkOppositeStorage(), undefined, '匯入處理過後不再重複提示');
        } finally {
          reopened.dispose();
        }
      } finally {
        await cleanBothStorages(api);
      }
    });
  });
});
