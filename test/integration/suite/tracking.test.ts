import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { makeAnchor, newBookmarkId } from '../../../src/bookmarks/model';
import { addBookmark } from '../../../src/storage/marks';
import type { BmGroupNode, BookmarkNode } from '../../../src/views/tree';
import {
  activateExtension,
  cleanupWorkspaceStore,
  folder,
  open,
  openAt,
  resetWorkspace,
  waitFor,
  workspaceFile,
} from './helpers';

describe('書籤追蹤：編輯平移、外部改檔、AI 重構、合併衝突與乾淨檔首次編輯', () => {
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

  describe('編輯器內平移與外部改檔基本行為', () => {
    const file = (n: string) => workspaceFile('app', `tmp_ext_${n}.py`);
    const made: vscode.Uri[] = [];
    const content = (n: number, p = 'v') => Array.from({ length: n }, (_, i) => `${p}_${i} = compute_${p}(${i})`);
    const write = (uri: vscode.Uri, ls: string[]) =>
      vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(ls.join('\n') + '\n'));
    const state = (uri: vscode.Uri) => api.store.bookmarksFor(uri).map((b) => `${b.line}${b.status === 'lost' ? '?' : ''}`);
    const settle = (uri: vscode.Uri, want: string[], label: string) =>
      waitFor(
        async () => {
          await api.external.idle();
          return state(uri);
        },
        (v) => JSON.stringify(v) === JSON.stringify(want),
        { timeoutMs: 8000, label },
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
    });

    it('編輯時平移：上方插入、行首 Enter、刪除整行（移到下一行），存檔時更新 anchor', async () => {
      const uri = file('shift');
      made.push(uri);
      const body = Array.from({ length: 20 }, (_, i) => `line_${i} = ${i}`);
      await write(uri, body);
      const editor = await openAt(uri, 10, api);
      await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
      const linesOf = () => api.store.bookmarksFor(uri).map((b) => b.line);

      await editor.edit((b) => b.insert(new vscode.Position(2, 0), 'a = 1\nb = 2\n'));
      await waitFor(linesOf, (v) => v[0] === 12, '上方插入 2 行後書籤移至 12');
      await editor.edit((b) => b.insert(new vscode.Position(12, 0), '\n'));
      await waitFor(linesOf, (v) => v[0] === 13, '行首 Enter 後書籤移至 13');
      await editor.edit((b) => b.delete(new vscode.Range(12, 0, 14, 0)));
      await waitFor(linesOf, (v) => v[0] === 12, '刪除書籤行後移到下一行 12');
      assert.strictEqual(editor.document.lineAt(12).text, 'line_11 = 11');
      await editor.document.save();
      await api.tracker.refreshAnchors(editor.document);
      assert.strictEqual(api.store.bookmarksFor(uri)[0].anchor?.text, 'line_11 = 11', '存檔時更新 anchor');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('沒開著的檔案被改（git pull）：上方插入、下方刪除，書籤依差異移動並保留 anchor', async () => {
      const uri = file('pull');
      const old = content(30);
      await plant(uri, old, [3, 20]);
      await write(uri, ['import os', 'import sys', ...old.slice(0, 15), ...old.slice(18)]);
      assert.deepStrictEqual(await settle(uri, ['5', '19'], '外部插刪後書籤移至 5 與 19'), ['5', '19']);
      assert.strictEqual(api.store.bookmarksFor(uri)[0].anchor?.text, old[3]);
    });

    it('書籤那一行被刪除：標成需確認並反灰；「移到游標所在的行」放回去', async () => {
      const uri = file('lost');
      const old = content(20);
      await plant(uri, old, [8]);
      await write(uri, [...old.slice(0, 8), ...old.slice(9)]);
      assert.deepStrictEqual(await settle(uri, ['8?'], '刪除書籤行標成 lost'), ['8?']);
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
      assert.deepStrictEqual(await settle(uri, ['6?', '19'], '合併衝突標成 lost'), ['6?', '19']);
      await write(uri, old);
      assert.deepStrictEqual(await settle(uri, ['5', '15'], '衝突解決後恢復'), ['5', '15']);
    });

    it('開著的檔案整份被取代（格式化工具等）：依差異換算；沒存檔就關閉：換算回磁碟內容', async () => {
      const uri = file('replace');
      const old = content(20);
      await plant(uri, old, [10]);
      const editor = await vscode.window.showTextDocument(uri);
      await api.external.idle();
      const next = ['import os', 'import re', 'import sys', ...old.slice(0, 5), ...old.slice(6)].join('\n') + '\n';
      await editor.edit((b) => b.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), next));
      assert.deepStrictEqual(await settle(uri, ['12'], '整份取代換算至 12'), ['12']);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      assert.deepStrictEqual(await settle(uri, ['10'], '還原關閉後換算回 10'), ['10']);
    });

    it('乾淨文件第一次編輯：上方插入 3 行後立刻存檔，書籤移到 N+3 且 anchor.text 保留原本內容（0.8.1 回歸）', async () => {
      const uri = file('first_edit_save');
      const old = content(20);
      await plant(uri, old, [8]);
      const editor = await open(uri, api);
      await api.external.idle();
      assert.strictEqual(editor.document.isDirty, false);
      assert.ok(await editor.edit((b) => b.insert(new vscode.Position(8, 0), 'ins_0 = 0\nins_1 = 1\nins_2 = 2\n')));
      assert.ok(await editor.document.save());
      await api.external.idle();
      const bm = await waitFor(
        async () => {
          await api.external.idle();
          return api.store.bookmarksFor(uri)[0];
        },
        (b) => b?.line === 11 && b.anchor?.text === old[8] && b.anchor?.before[1] === 'ins_2 = 2',
        { timeoutMs: 8000, label: '0.8.1 首次編輯立刻存檔後移至 11 並保留原 anchor' },
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
          await waitFor(() => editor.document.isDirty, (v) => v, `mode=${mode} 編輯器變為 dirty`);
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
            { timeoutMs: 8000, label: `首次編輯刪行 onLineDelete=${mode}` },
          );
          if (mode === 'moveToNext') {
            assert.strictEqual(editor.document.lineAt(list[0].line).text, old[7]);
          }
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
      } finally {
        await cfg.update('bookmarks.onLineDelete', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });
  });

  describe('乾淨檔案第一次編輯改寫書籤行文字（CR-03）', () => {
    const tmpFile = () => workspaceFile('app', 'tmp_cr03_edit.py');
    const baseLines = [
      'def compute():',
      '    alpha = 1',
      '    beta = 2',
      '    target_value = alpha + beta',
      '    gamma = 4',
      '    return target_value + gamma',
    ];

    afterEach(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.onLineDelete', undefined, vscode.ConfigurationTarget.Workspace);
      await fsp.rm(tmpFile().fsPath, { force: true });
    });

    for (const mode of ['remove', 'markLost', 'moveToNext'] as const) {
      it(`onLineDelete=${mode}：改寫書籤行文字（等待與立刻存檔），書籤都留在原行且不標需確認`, async () => {
        const cfg = vscode.workspace.getConfiguration('functionBookmarks');
        await cfg.update('bookmarks.onLineDelete', mode, vscode.ConfigurationTarget.Workspace);
        await fsp.writeFile(tmpFile().fsPath, baseLines.join('\n') + '\n', 'utf8');

        const editor = await openAt(tmpFile(), 3, api);
        await api.bookmarks.addLabeled('重要計算');
        await api.store.flush();
        await api.external.idle();
        assert.strictEqual(editor.document.isDirty, false);

        // 情境 A：改寫書籤行全部文字後等背景處理完
        await editor.edit((eb) => {
          const r = editor.document.lineAt(3).range;
          eb.replace(r, '    completely_rewritten_expression = 987654321');
        });
        await api.external.idle();
        let bms = api.store.bookmarksFor(tmpFile());
        assert.strictEqual(bms.length, 1, `mode=${mode}：改寫行內文字不應刪除書籤`);
        assert.strictEqual(bms[0].line, 3);
        assert.strictEqual(bms[0].status, undefined);

        // 情境 B：回到乾淨狀態後改寫文字並立刻存檔
        await editor.document.save();
        await api.external.idle();
        assert.strictEqual(editor.document.isDirty, false);

        await editor.edit((eb) => {
          const r = editor.document.lineAt(3).range;
          eb.replace(r, '    another_brand_new_statement_xyz = 12345');
        });
        await editor.document.save();
        await api.external.idle();

        bms = api.store.bookmarksFor(tmpFile());
        assert.strictEqual(bms.length, 1, `mode=${mode}：立刻存檔也不應刪除書籤`);
        assert.strictEqual(bms[0].line, 3);
        assert.strictEqual(bms[0].status, undefined);
        assert.strictEqual(bms[0].anchor?.text, 'another_brand_new_statement_xyz = 12345');
      });
    }
  });

  describe('不在此分支（notOnBranch）的書籤編輯保護', () => {
    const fileR = () => workspaceFile('app', 'tmp_away_protect.py');
    const relR = 'app/tmp_away_protect.py';
    const LINES = ['def alpha():', '    x = 1', '    return x', '', 'x_global = 1', 'y_global = 2', ''];

    before(async () => {
      await fsp.writeFile(fileR().fsPath, LINES.join('\n'));
    });

    afterEach(async () => {
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.onLineDelete', undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fsp.writeFile(fileR().fsPath, LINES.join('\n'));
    });

    after(async () => {
      await fsp.rm(fileR().fsPath, { force: true });
    });

    async function plantAway(line = 4): Promise<string> {
      const id = newBookmarkId();
      const other = ['feature_a()', 'feature_b()', 'feature_c()', 'feature_d()', 'feature_e()', 'feature_f()', 'feature_g()'];
      await api.store.update(folder(), (d) => addBookmark(d, { id, file: relR, line, anchor: makeAnchor(other, line), status: 'notOnBranch' }));
      return id;
    }

    it('在同一行切換書籤：只新增與移除自己的，不動不在此分支的書籤', async () => {
      const id = await plantAway(4);
      await openAt(fileR(), 4, api);
      await api.bookmarks.toggle({ uri: fileR(), line: 4 });
      const list = api.store.bookmarksFor(fileR());
      assert.strictEqual(list.length, 2);
      assert.strictEqual(list.find((b) => b.id === id)?.status, 'notOnBranch');
      assert.ok(list.some((b) => b.id !== id && b.line === 4 && b.status === undefined));

      await api.bookmarks.toggle({ uri: fileR(), line: 4 });
      assert.deepStrictEqual(api.store.bookmarksFor(fileR()).map((b) => b.id), [id]);
      assert.strictEqual(api.store.bookmarksFor(fileR())[0].status, 'notOnBranch');
    });

    for (const mode of ['remove', 'markLost'] as const) {
      it(`刪除該行（onLineDelete = ${mode}）：自己的書籤依設定處理，不在此分支的保留不動`, async () => {
        await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.onLineDelete', mode, vscode.ConfigurationTarget.Workspace);
        const awayId = await plantAway(4);
        const mineId = newBookmarkId();
        await api.store.update(folder(), (d) => addBookmark(d, { id: mineId, file: relR, line: 4, anchor: makeAnchor(LINES, 4) }));
        const editor = await openAt(fileR(), 4, api);
        await api.external.idle();
        assert.ok(await editor.edit((b) => b.delete(new vscode.Range(3, 0, 4, LINES[4].length))));
        await waitFor(
          () => api.store.bookmarksFor(fileR()).find((b) => b.id === mineId),
          (v) => (mode === 'remove' ? v === undefined : v?.status === 'lost'),
          `刪除行後自己的書籤套用 ${mode}`,
        );
        const kept = api.store.bookmarksFor(fileR()).find((b) => b.id === awayId);
        assert.strictEqual(kept?.status, 'notOnBranch');
      });
    }
  });

  describe('實際模擬 AI 改檔（真實的 Django views）', () => {
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
    const MARKS = [
      '    qs = Article.objects.filter(published=True).order_by("-created_at")',
      '        if not form.is_valid():',
      '    payload = json.loads(request.body or "{}")',
    ];
    const made: vscode.Uri[] = [];
    let seq = 0;

    const text = (ls: string[]) => ls.join('\n') + '\n';
    async function where(uri: vscode.Uri): Promise<string[]> {
      await api.external.idle();
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const lines = doc ? doc.getText().split(/\r?\n/) : (await fsp.readFile(uri.fsPath, 'utf8')).split(/\r?\n/);
      return api.store
        .bookmarksFor(uri)
        .map((b) => (b.status === 'lost' ? `?${b.anchor?.text}` : (lines[b.line] ?? '').trim()));
    }
    const expectMarks = (want = MARKS.map((m) => m.trim())) => want;
    const settle = (uri: vscode.Uri, want: string[], label: string) =>
      waitFor(() => where(uri), (v) => JSON.stringify(v) === JSON.stringify(want), { timeoutMs: 8000, label });

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

    function aiRefactor(ls: string[]): string[] {
      const out = [...ls];
      out.splice(out.indexOf('import json'), 1, 'import json', 'import logging');
      out.splice(
        out.indexOf('from .models import Article') + 1,
        0,
        '',
        'logger = logging.getLogger(__name__)',
        '',
        '',
        'def health(request):',
        '    return JsonResponse({"ok": True})',
      );
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
      assert.deepStrictEqual(await settle(uri, expectMarks(), 'AI 直接寫磁碟後書籤定位'), expectMarks());
    });

    it('檔案沒開著：分好幾次串流寫入（中間是寫到一半的內容）', async () => {
      const uri = await plant();
      const final = aiRefactor(VIEWS);
      for (const n of [5, 18, 30]) {
        await fsp.writeFile(uri.fsPath, text(final.slice(0, n)));
        api.external.checkAll();
        await api.external.idle();
      }
      await fsp.writeFile(uri.fsPath, text(final));
      assert.deepStrictEqual(await settle(uri, expectMarks(), 'AI 串流寫入完成後書籤定位'), expectMarks());
    });

    it('檔案沒開著：先寫暫存檔再改名覆蓋原檔（原子寫入）', async () => {
      const uri = await plant();
      const tmp = `${uri.fsPath}.tmp-${Date.now()}`;
      await fsp.writeFile(tmp, text(aiRefactor(VIEWS)));
      await fsp.rename(tmp, uri.fsPath);
      assert.deepStrictEqual(await settle(uri, expectMarks(), '原子寫入覆蓋後書籤定位'), expectMarks());
    });

    it('檔案開著（乾淨未修改）：外部改檔（AI 寫磁碟）編輯器重新載入，書籤走差異換算', async () => {
      const uri = await plant();
      const editor = await vscode.window.showTextDocument(uri);
      await api.external.idle();
      assert.strictEqual(editor.document.isDirty, false);
      await fsp.writeFile(uri.fsPath, text(aiRefactor(VIEWS)));
      await waitFor(
        () => editor.document.getText(),
        (t) => t.includes('def health'),
        { timeoutMs: 8000, label: '開著的編輯器自磁碟重新載入' },
      );
      assert.deepStrictEqual(await settle(uri, expectMarks(), '編輯器重載後書籤定位'), expectMarks());
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('檔案開著：在編輯器裡一段一段套用 AI 修改（多行換成多行），存檔', async () => {
      const uri = await plant();
      const editor = await vscode.window.showTextDocument(uri);
      await api.external.idle();
      const doc = editor.document;
      const find = (s: string) => doc.getText().split(/\r?\n/).indexOf(s);
      const s = find('    def post(self, request):');
      const e = find('        return JsonResponse({"id": article.pk})');
      const post = doc.getText().split(/\r?\n/).slice(s, e + 1);
      const wrapped = [post[0], '        try:', ...post.slice(1).map((l) => `    ${l}`), '        except Exception:', '            raise'];
      await editor.edit((b) => b.replace(new vscode.Range(s, 0, e + 1, 0), wrapped.join('\n') + '\n'));

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
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'import logging\n'));
      assert.deepStrictEqual(await settle(uri, expectMarks(), '分段套用 AI 修改後定位'), expectMarks());
      await doc.save();
      assert.deepStrictEqual(await settle(uri, expectMarks(), '存檔後定位維持不變'), expectMarks());
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('AI 把函式整個搬到檔案最後、刪掉另一個函式：搬走的找回來，刪掉的標成需確認', async () => {
      const uri = await plant();
      const out = [...VIEWS];
      const s = out.indexOf('def article_list(request):');
      const listFn = out.splice(s, 6);
      const a = out.indexOf('def article_api(request, pk):');
      out.splice(a, out.length - a);
      out.push(...listFn);
      await fsp.writeFile(uri.fsPath, text(out));
      const want = [MARKS[0].trim(), MARKS[1].trim(), `?${MARKS[2].trim()}`];
      const sorted = (v: string[]) => JSON.stringify([...v].sort());
      const got = await waitFor(
        () => where(uri),
        (v) => sorted(v) === sorted(want),
        { timeoutMs: 8000, label: '遠距搬移找回與刪除標 lost' },
      );
      assert.deepStrictEqual([...got].sort(), [...want].sort());
    });

    it('AI 同時改好幾個檔案：並發換算全部正確', async () => {
      const uris = [await plant(), await plant(), await plant()];
      await Promise.all(uris.map((u) => fsp.writeFile(u.fsPath, text(aiRefactor(VIEWS)))));
      for (const u of uris) {
        assert.deepStrictEqual(await settle(u, expectMarks(), `多檔並發改檔定位 ${path.basename(u.fsPath)}`), expectMarks());
      }
    });
  });
});
