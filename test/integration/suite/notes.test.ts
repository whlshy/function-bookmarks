import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { makeAnchor, newBookmarkId } from '../../../src/bookmarks/model';
import { addBookmark, setFavorite, setNote } from '../../../src/storage/marks';
import { NoteEditor, saveShortcut } from '../../../src/views/noteEditor';
import type { BmGroupNode, BookmarkNode } from '../../../src/views/tree';
import {
  activateExtension,
  cleanupWorkspaceStore,
  fileExists,
  findNode,
  folder,
  isCursor,
  open,
  openAt,
  previewTabCount,
  resetWorkspace,
  waitFor,
  workspaceFile,
} from './helpers';

describe('備註編輯、並排預覽、Mermaid 與各入口行為', () => {
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

  it('備註編輯存檔後自動關閉分頁與預覽、側邊欄圖示換色、提示含全文與預覽連結；內建 Mermaid 渲染正常', async () => {
    assert.strictEqual(saveShortcut('darwin'), 'Cmd+S');
    assert.strictEqual(saveShortcut('win32'), 'Ctrl+S');
    assert.strictEqual(saveShortcut('linux'), 'Ctrl+S');

    const editor = await open(workspaceFile('app', 'views.py'), api);
    const viewsUri = editor.document.uri;
    const post = findNode(api.provider.currentSymbolNodes, 'ArticleView.post')!;
    await vscode.commands.executeCommand('functionBookmarks.addFavorite', post);
    await vscode.commands.executeCommand('functionBookmarks.editNote', post);
    const noteEditor = vscode.window.activeTextEditor!;
    assert.ok(api.notes.isNoteDocument(noteEditor.document.uri), '應開啟備註分頁');
    assert.strictEqual(noteEditor.document.languageId, 'markdown');
    await waitFor(previewTabCount, (n) => n === 1, '開啟右側並排 Markdown 預覽');
    await noteEditor.edit((b) => b.insert(new vscode.Position(0, 0), '送出文章\n\n- 需要登入\n- 會寄通知信'));
    if (isCursor) {
      assert.ok(noteEditor.document.uri.path.endsWith('.markdown'), 'Cursor 編輯檔使用 .markdown');
    }
    await noteEditor.document.save();
    await waitFor(() => api.store.get(viewsUri, post.symbol)?.note, (v) => v === '送出文章\n\n- 需要登入\n- 會寄通知信', '備註寫回 store');
    await waitFor(
      () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.label.includes('post')),
      (stillOpen) => !stillOpen,
      '存檔後備註編輯分頁自動關閉',
    );
    await waitFor(previewTabCount, (n) => n === 0, '存檔後預覽分頁一起關閉');

    const item = api.provider.getTreeItem(post);
    assert.strictEqual(((item.iconPath as vscode.ThemeIcon).color as unknown as { id: string }).id, 'charts.blue');
    assert.strictEqual(item.label, 'post');
    assert.ok((item.tooltip as vscode.MarkdownString).value.includes('- 會寄通知信'));
    assert.ok((item.tooltip as vscode.MarkdownString).value.includes('command:functionBookmarks.previewNote?'));

    await vscode.commands.executeCommand('functionBookmarks.previewNote', post);
    await waitFor(previewTabCount, (n) => n === 1, '預覽備註開啟預覽分頁');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    await vscode.window.showTextDocument(viewsUri);
    await api.gutter.update();
    assert.deepStrictEqual(api.gutter.linesFor(viewsUri, 'favorite'), [post.symbol.nameLine]);

    await api.commands.editNote(post, '');
    assert.strictEqual(api.store.get(viewsUri, post.symbol)?.note, undefined);
    assert.strictEqual((api.provider.getTreeItem(post).iconPath as vscode.ThemeIcon).color, undefined);

    // 內建 Markdown 預覽：mermaid 區塊交給本套件繪製並保留同步捲動行號
    const html = await vscode.commands.executeCommand<string>(
      'markdown.api.render',
      '# t\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n```js\nx()\n```\n',
    );
    assert.ok(/<pre class="code-line fb-mermaid" data-line="2">flowchart TD/.test(html), html);
    assert.ok(html.includes('A --&gt; B'));
    assert.ok(!html.includes('fb-mermaid" data-line="7"'));
  });

  it('備註取消（不存檔關閉）後不變更原內容，且立刻重開並存檔正常、暫存檔不被舊收尾刪掉（CR-01）', async () => {
    const views = workspaceFile('app', 'views.py');
    await openAt(views, 1, api);
    await api.bookmarks.addLabeled('備註測試書籤');
    const bm = api.store.bookmarksFor(views)[0];
    await api.bookmarks.editNote({ type: 'bookmark', entry: { folder: folder(), uri: views, bookmark: bm } }, '原本備註內容');
    assert.strictEqual(api.store.bookmarksFor(views)[0].note, '原本備註內容');

    // 開啟備註編輯、輸入草稿但不存檔關閉
    const node = () => ({ type: 'bookmark' as const, entry: { folder: folder(), uri: views, bookmark: api.store.bookmarksFor(views)[0] } });
    await api.bookmarks.editNote(node());
    const firstEditor = vscode.window.activeTextEditor!;
    assert.ok(api.notes.isNoteDocument(firstEditor.document.uri));
    assert.strictEqual(firstEditor.document.getText(), '原本備註內容');
    await firstEditor.edit((eb) => eb.insert(new vscode.Position(0, 0), '未存的草稿\n'));
    assert.strictEqual(firstEditor.document.isDirty, true);

    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    assert.strictEqual(api.store.bookmarksFor(views)[0].note, '原本備註內容', '不存檔關閉不應更動原本備註');

    // 立刻重開同一個書籤的備註
    await api.bookmarks.editNote(node());
    const reopened = vscode.window.activeTextEditor!;
    assert.ok(api.notes.isNoteDocument(reopened.document.uri), '重開後應為有效備註分頁');
    assert.strictEqual(reopened.document.isDirty, false, '重開後不應殘留髒狀態');
    assert.strictEqual(reopened.document.getText(), '原本備註內容', '應顯示已存備註而非草稿');
    // 稍等確認非同步舊 finish 不會刪掉新開的暫存檔
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(await fileExists(reopened.document.uri), true, '磁碟暫存檔必須存在');

    const fullRange = new vscode.Range(0, 0, reopened.document.lineCount, 0);
    await reopened.edit((eb) => eb.replace(fullRange, '重開後存檔的新備註'));
    await reopened.document.save();
    await waitFor(() => api.store.bookmarksFor(views)[0]?.note, (v) => v === '重開後存檔的新備註', '重開後存檔寫回備註');
  });

  it('備註存檔自動關閉後立刻重開再存檔：不被舊收尾關閉或刪檔（CR-01）', async () => {
    const views = workspaceFile('app', 'views.py');
    await openAt(views, 1, api);
    await api.bookmarks.addLabeled('連續存檔重開');
    const node = () => ({ type: 'bookmark' as const, entry: { folder: folder(), uri: views, bookmark: api.store.bookmarksFor(views)[0] } });

    await api.bookmarks.editNote(node());
    const ed1 = vscode.window.activeTextEditor!;
    const uri1 = ed1.document.uri;
    await ed1.edit((eb) => eb.insert(new vscode.Position(0, 0), '第一版備註'));
    await ed1.document.save();
    await waitFor(() => api.store.bookmarksFor(views)[0]?.note, (v) => v === '第一版備註', '第一版備註存檔');

    await api.bookmarks.editNote(node());
    const ed2 = vscode.window.activeTextEditor!;
    assert.ok(api.notes.isNoteDocument(ed2.document.uri));
    assert.strictEqual(ed2.document.getText(), '第一版備註');
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(await fileExists(ed2.document.uri), true);
    assert.strictEqual(ed2.document.uri.toString(), uri1.toString());

    const fullRange = new vscode.Range(0, 0, ed2.document.lineCount, 0);
    await ed2.edit((eb) => eb.replace(fullRange, '第二版備註'));
    await ed2.document.save();
    await waitFor(() => api.store.bookmarksFor(views)[0]?.note, (v) => v === '第二版備註', '第二版備註存檔');
  });

  it('notes.closeOnSave = false：存檔只寫回不關分頁，可連續存檔，關閉後才清 session', async () => {
    const cfg = vscode.workspace.getConfiguration('functionBookmarks');
    await cfg.update('notes.closeOnSave', false, vscode.ConfigurationTarget.Workspace);
    try {
      const views = workspaceFile('app', 'views.py');
      await open(views, api);
      const indexNode = findNode(api.provider.currentSymbolNodes, 'index')!;
      await api.commands.setFavorite(indexNode, true);
      await api.commands.editNote(indexNode);
      const noteEditor = vscode.window.activeTextEditor!;
      assert.ok(api.notes.isNoteDocument(noteEditor.document.uri));

      await noteEditor.edit((eb) => eb.insert(new vscode.Position(0, 0), '第一版備註'));
      await noteEditor.document.save();
      await waitFor(() => api.store.get(views, indexNode.symbol)?.note, (v) => v === '第一版備註', 'closeOnSave=false 第一次存檔');
      assert.strictEqual(api.notes.isNoteDocument(noteEditor.document.uri), true);
      assert.strictEqual(noteEditor.document.isClosed, false);

      await noteEditor.edit((eb) => eb.insert(new vscode.Position(0, 5), '\n第二版補充'));
      await noteEditor.document.save();
      await waitFor(
        () => api.store.get(views, indexNode.symbol)?.note,
        (v) => v === '第一版備註\n第二版補充',
        'closeOnSave=false 第二次存檔',
      );
      assert.strictEqual(api.notes.isNoteDocument(noteEditor.document.uri), true);

      const noteUri = noteEditor.document.uri;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await waitFor(() => api.notes.isNoteDocument(noteUri), (v) => !v, '手動關閉分頁後清除 session');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await cfg.update('notes.closeOnSave', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it('編輯備註分頁作用中時，「目前檔案」保留上一個程式碼檔案而不是變成「沒有開啟的檔案」', async () => {
    const views = workspaceFile('app', 'views.py');
    await openAt(views, 1, api);
    const origCount = api.provider.currentSymbolNodes.length;
    assert.ok(origCount > 0);

    await api.bookmarks.addLabeled('備註保留目前檔案');
    const bm = api.store.bookmarksFor(views)[0];
    await api.bookmarks.editNote({ type: 'bookmark', entry: { folder: folder(), uri: views, bookmark: bm } });
    assert.ok(api.notes.isNoteDocument(vscode.window.activeTextEditor!.document.uri));

    await api.refreshNow();
    assert.strictEqual(api.provider.currentFile?.uri.toString(), views.toString());
    assert.strictEqual(api.provider.currentSymbolNodes.length, origCount);
    const sec = api.provider.getTreeItem(api.provider.sections.currentFile);
    assert.ok(String(sec.label).includes('views.py'));
    assert.notStrictEqual(sec.description, 'No file open');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

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
        assert.strictEqual(await fileExists(staleNote), false);
        assert.strictEqual(await fileExists(stalePreview), false);
      } finally {
        editor.dispose();
      }
    } finally {
      await vscode.workspace.fs.delete(base, { recursive: true }).then(undefined, () => undefined);
    }
  });

  describe('行號右鍵與各入口編輯備註', () => {
    const fileL = () => workspaceFile('app', 'tmp_line_note.py');
    const relL = 'app/tmp_line_note.py';
    const LINES = ['def first_fn():', '    a = 1', '    return a', '', 'top_val = 42', '', 'def second_fn():', '    b = 2', '    return b', ''];
    const firstKey = { file: relL, path: 'first_fn', kind: 'function' as const };
    const secondKey = { file: relL, path: 'second_fn', kind: 'function' as const };
    const foreignSource = (author: string) => ({ author, importId: 'i-ln', originalId: newBookmarkId(), importedAt: '2026-01-01T00:00:00.000Z' });

    async function writeAndSaveNote(text: string): Promise<string> {
      const noteEditor = await waitFor(
        () => vscode.window.activeTextEditor,
        (ed) => !!ed && api.notes.isNoteDocument(ed.document.uri),
        '備註編輯分頁成為作用中編輯器',
      );
      const prevText = noteEditor!.document.getText();
      const fullRange = new vscode.Range(0, 0, noteEditor!.document.lineCount, 0);
      await noteEditor!.edit((eb) => eb.replace(fullRange, text));
      const noteUri = noteEditor!.document.uri;
      await noteEditor!.document.save();
      await waitFor(() => api.notes.isNoteDocument(noteUri), (stillOpen) => !stillOpen, '備註編輯分頁關閉');
      await waitFor(previewTabCount, (n) => n === 0, '備註預覽分頁關閉');
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
      await fsp.rm(fileL().fsPath, { force: true });
    });

    it('行號右鍵（已有行號書籤或函式書籤，游標在不同行）：編輯右鍵那一行，不動游標行', async () => {
      // 1. 已有行號書籤
      await api.store.update(folder(), (d) =>
        addBookmark(d, { id: 'bm-line-7', file: relL, line: 7, label: '目標行', note: '原本備註', anchor: makeAnchor(LINES, 7, 'second_fn', 6) }),
      );
      await openAt(fileL(), 1, api);
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 8, uri: fileL() });
      assert.strictEqual(await writeAndSaveNote('修改後的行號備註'), '原本備註');
      assert.strictEqual(api.store.bookmarksFor(fileL()).find((b) => b.id === 'bm-line-7')?.note, '修改後的行號備註');
      assert.strictEqual(api.store.bookmarksFor(fileL()).length, 1);
      assert.strictEqual(api.store.get(fileL(), firstKey), undefined);

      // 2. 已有函式書籤
      await resetWorkspace(api, { closeEditors: true });
      await api.store.update(folder(), (d) => setNote(setFavorite(d, secondKey, true, 6), secondKey, '舊函式備註', 6));
      await api.favorites.refresh();
      await openAt(fileL(), 4, api);
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 7, uri: fileL() });
      assert.strictEqual(await writeAndSaveNote('新函式備註'), '舊函式備註');
      assert.strictEqual(api.store.get(fileL(), secondKey)?.note, '新函式備註');
      assert.strictEqual(api.store.bookmarksFor(fileL()).length, 0);
    });

    it('行號右鍵（無書籤的一般行與函式名稱行，游標在不同行）：先建書籤並套用 autoNumber 再開備註', async () => {
      await vscode.workspace.getConfiguration('functionBookmarks').update('bookmarks.autoNumber', true, vscode.ConfigurationTarget.Workspace);
      await openAt(fileL(), 0, api);
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 5, uri: fileL() });
      await writeAndSaveNote('新建行號書籤備註');
      const bms = api.store.bookmarksFor(fileL());
      assert.strictEqual(bms.length, 1);
      assert.deepStrictEqual([bms[0].line, bms[0].number, bms[0].note], [4, 1, '新建行號書籤備註']);
      assert.strictEqual(api.store.get(fileL(), firstKey), undefined);

      await openAt(fileL(), 4, api);
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 7, uri: fileL() });
      await writeAndSaveNote('新建函式書籤備註');
      const mark = api.store.get(fileL(), secondKey);
      assert.deepStrictEqual([mark?.favorite, mark?.number, mark?.note], [true, 2, '新建函式書籤備註']);
      assert.strictEqual(api.store.bookmarksFor(fileL()).length, 1);
    });

    it('行號右鍵：同行並存時優先行號書籤；不在此分支與被隱藏的書籤不會被誤改', async () => {
      // 同行並存
      await api.store.update(folder(), (d) => {
        const next = setNote(setFavorite(d, firstKey, true, 0), firstKey, '函式原備註', 0);
        return addBookmark(next, { id: 'bm-overlap', file: relL, line: 0, label: '同行行號書籤', anchor: makeAnchor(LINES, 0, 'first_fn', 0) });
      });
      await api.favorites.refresh();
      await openAt(fileL(), 4, api);
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 1, uri: fileL() });
      await writeAndSaveNote('同行行號新備註');
      assert.strictEqual(api.store.bookmarksFor(fileL()).find((b) => b.id === 'bm-overlap')?.note, '同行行號新備註');
      assert.strictEqual(api.store.get(fileL(), firstKey)?.note, '函式原備註');

      // notOnBranch 與被來源篩選隱藏的保護
      await resetWorkspace(api, { closeEditors: true });
      await api.store.update(folder(), (d) => {
        let next = addBookmark(d, {
          id: 'bm-away',
          file: relL,
          line: 4,
          note: '他分支原備註',
          status: 'notOnBranch',
          anchor: makeAnchor(['o0', 'o1', 'o2', 'o3', 'o4'], 4),
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
      await openAt(fileL(), 0, api);

      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 5, uri: fileL() });
      await writeAndSaveNote('本分支新備註');
      const at4 = api.store.bookmarksFor(fileL()).filter((b) => b.line === 4);
      assert.strictEqual(at4.length, 2);
      assert.strictEqual(at4.find((b) => b.id === 'bm-away')?.note, '他分支原備註');
      assert.strictEqual(at4.find((b) => b.id !== 'bm-away')?.note, '本分支新備註');

      api.store.setHiddenSources(['bob']);
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 8, uri: fileL() });
      await writeAndSaveNote('自己的新備註');
      const at7 = api.store.bookmarksFor(fileL()).filter((b) => b.line === 7);
      assert.strictEqual(at7.length, 2);
      assert.strictEqual(at7.find((b) => b.id === 'bm-bob')?.note, 'bob原備註');
      assert.strictEqual(at7.find((b) => b.id !== 'bm-bob')?.note, '自己的新備註');

      api.store.setHiddenSources(['']);
      const noticesBefore = api.bookmarks.mineHiddenNotices;
      await vscode.commands.executeCommand('functionBookmarks.editNote', { lineNumber: 2, uri: fileL() });
      assert.strictEqual(api.bookmarks.mineHiddenNotices, noticesBefore + 1);
      assert.strictEqual(api.notes.isNoteDocument(vscode.window.activeTextEditor!.document.uri), false);
      const at1 = api.store.bookmarksFor(fileL()).filter((b) => b.line === 1);
      assert.strictEqual(at1.length, 1);
      assert.strictEqual(at1[0].note, '自己原備註');
    });

    it('編輯器內文右鍵、側邊欄右鍵、命令選擇區：行號書籤的編輯備註與預覽都正常', async () => {
      await api.store.update(folder(), (d) =>
        addBookmark(d, { id: 'bm-entries', file: relL, line: 4, label: '頂層行號書籤', anchor: makeAnchor(LINES, 4) }),
      );
      await openAt(fileL(), 4, api);

      await vscode.commands.executeCommand('functionBookmarks.editNote', fileL());
      await writeAndSaveNote('編輯器右鍵寫入');
      assert.strictEqual(api.store.bookmarksFor(fileL())[0]?.note, '編輯器右鍵寫入');

      const groups = (await api.provider.getChildren(api.provider.sections.bookmarks)) as BmGroupNode[];
      const bmNode = (await api.provider.getChildren(groups.find((g) => g.rel === relL)!))[0] as BookmarkNode;
      await vscode.commands.executeCommand('functionBookmarks.editNote', bmNode);
      assert.strictEqual(await writeAndSaveNote('側邊欄右鍵寫入'), '編輯器右鍵寫入');
      assert.strictEqual(api.store.bookmarksFor(fileL())[0]?.note, '側邊欄右鍵寫入');

      await openAt(fileL(), 4, api);
      await vscode.commands.executeCommand('functionBookmarks.editNote');
      assert.strictEqual(await writeAndSaveNote('命令選擇區寫入'), '側邊欄右鍵寫入');
      assert.strictEqual(api.store.bookmarksFor(fileL())[0]?.note, '命令選擇區寫入');

      await openAt(fileL(), 4, api);
      await vscode.commands.executeCommand('functionBookmarks.previewNote');
      await waitFor(previewTabCount, (n) => n === 1, '命令選擇區預覽行號書籤備註開啟預覽分頁');
    });
  });
});
