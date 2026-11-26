import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import {
  activateExtension,
  cleanupWorkspaceStore,
  findNode,
  open,
  openAt,
  resetWorkspace,
  waitFor,
  workspaceFile,
} from './helpers';

/** 測試檔內容：每一行都不一樣；行號書籤放在第 10 行（以下行號皆從 1 起算）。 */
const LINES = [
  'const rate = 0.05;',
  'export function formatInvoice(customerName: string, invoiceNumber: number, issuedAt: Date): string {',
  '  return `${customerName} #${invoiceNumber} ${issuedAt.getFullYear()}`;',
  '} // formatInvoice 結束',
  'const subtotal = 100;',
  'const shipping = 15;',
  'const discount = 5;',
  'const handling = 2;',
  'const total = subtotal + shipping - discount + handling;',
  'const tax = total * rate;',
  'const grand = total + tax;',
  'const rounded = Math.round(grand);',
  "const label = 'invoice';",
  'const summary = `${label}:${rounded}`;',
  "const footer = 'thanks';",
  'export function printSummary(prefix: string): void {',
  '  console.log(prefix, summary, footer);',
  '} // printSummary 結束',
  "export const version = 'v1';",
];
const MARK_LINE = 10;
const MARK_TEXT = LINES[MARK_LINE - 1];

/** 模擬格式化工具：把第 2 行的長參數列拆成 5 行（多出 4 行）。 */
const FORMATTED = [
  LINES[0],
  'export function formatInvoice(',
  '  customerName: string,',
  '  invoiceNumber: number,',
  '  issuedAt: Date,',
  '): string {',
  ...LINES.slice(2),
];

const content = (lines: string[]) => lines.join('\n') + '\n';

/** 把第 from～to 行（含）搬到原本第 before 行之前。 */
function moved(lines: string[], from: number, to: number, before: number): string[] {
  const block = lines.slice(from - 1, to);
  const rest = [...lines.slice(0, from - 1), ...lines.slice(to)];
  const at = before > to ? before - 1 - block.length : before - 1;
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

describe('日常編輯後書籤不跑掉', () => {
  let api: ExtensionApi;
  const made: vscode.Uri[] = [];

  before(async () => {
    api = await activateExtension();
  });

  beforeEach(async () => {
    await resetWorkspace(api, { closeEditors: true });
  });

  afterEach(async () => {
    // 未存檔的內容先還原再關閉，避免跳出存檔詢問
    for (const uri of made) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (doc?.isDirty) {
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    }
    await resetWorkspace(api, { closeEditors: true });
    for (const uri of made.splice(0)) {
      await fsp.rm(uri.fsPath, { force: true });
    }
  });

  after(async () => {
    await cleanupWorkspaceStore(api);
  });

  /** 等套件的背景工作做完，且書籤資料連續一段時間（長於套件內部的延遲計時）沒有再變。 */
  async function settle(uri: vscode.Uri): Promise<void> {
    let last = '';
    let since = Date.now();
    await waitFor(
      async () => {
        await api.external.idle();
        const now = JSON.stringify(api.store.bookmarksFor(uri, { includeHidden: true }));
        if (now !== last) {
          last = now;
          since = Date.now();
        }
        return Date.now() - since;
      },
      (quietMs) => quietMs >= 800,
      { timeoutMs: 8000, label: '書籤資料穩定下來' },
    );
  }

  /** 目前的行號書籤：行號（從 1 起算）、狀態、該行現在的內容。 */
  const observe = (doc: vscode.TextDocument) =>
    api.store.bookmarksFor(doc.uri, { includeHidden: true }).map((b) => ({
      line: b.line + 1,
      status: b.status ?? 'ok',
      text: b.line < doc.lineCount ? doc.lineAt(b.line).text : '（超出檔案範圍）',
    }));

  const markAt = (line: number, text = MARK_TEXT) => [{ line, status: 'ok', text }];

  /** 建立測試檔（`name` 讓每個情境用自己的檔案），內容已存檔。 */
  async function createFile(name: string): Promise<vscode.Uri> {
    const uri = workspaceFile('app', `tmp_edit_${name}.ts`);
    made.push(uri);
    await fsp.writeFile(uri.fsPath, content(LINES));
    return uri;
  }

  /** 建立測試檔、開啟，並在第 10 行加行號書籤。 */
  async function setup(name: string): Promise<vscode.TextEditor> {
    const uri = await createFile(name);
    const editor = await openAt(uri, MARK_LINE - 1, api);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    await api.store.flush();
    await settle(uri);
    assert.strictEqual(editor.document.isDirty, false);
    assert.deepStrictEqual(observe(editor.document), markAt(MARK_LINE), '前置條件：書籤加在第 10 行');
    return editor;
  }

  /** 執行一個編輯動作，確認文件變成預期內容（動作本身有生效），再等套件處理完。 */
  async function act(
    doc: vscode.TextDocument,
    label: string,
    run: () => Thenable<unknown>,
    lines: string[],
    dirty = true,
  ): Promise<void> {
    await run();
    await waitFor(
      () => ({ text: doc.getText(), dirty: doc.isDirty }),
      (v) => v.text === content(lines) && v.dirty === dirty,
      { label: `${label}：文件內容與未存檔狀態符合預期` },
    );
    await settle(doc.uri);
  }

  const command = (id: string) => () => vscode.commands.executeCommand(id);

  /** 復原：先把焦點放回該編輯器（測試視窗不在前景時，undo 可能找不到要復原的編輯器）。 */
  const undo = (editor: vscode.TextEditor) => async () => {
    await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
    await vscode.commands.executeCommand('undo');
  };

  const cursor = (editor: vscode.TextEditor, line: number) => {
    editor.selection = new vscode.Selection(line - 1, 0, line - 1, 0);
  };

  it('情境 1：刪掉書籤行再復原，書籤回到第 10 行原本的內容', async () => {
    const editor = await setup('delete_undo');
    const doc = editor.document;
    const deleted = [...LINES.slice(0, MARK_LINE - 1), ...LINES.slice(MARK_LINE)];
    await act(doc, '刪除第 10 行', command('editor.action.deleteLines'), deleted);
    const afterDelete = observe(doc);
    await act(doc, '復原', undo(editor), LINES, false);
    assert.deepStrictEqual(observe(doc), markAt(MARK_LINE), `刪除後的書籤：${JSON.stringify(afterDelete)}`);
  });

  it('情境 1 變化：文件已有其他未存檔修改時刪掉書籤行再復原，書籤回到第 10 行', async () => {
    const editor = await setup('delete_undo_dirty');
    const doc = editor.document;
    const tail = 'const pending = true;';
    const base = [...LINES, tail];
    await act(
      doc,
      '先在檔尾加一行（不存檔）',
      () => editor.edit((b) => b.insert(new vscode.Position(LINES.length, 0), content([tail]))),
      base,
    );
    cursor(editor, MARK_LINE);
    const deleted = [...base.slice(0, MARK_LINE - 1), ...base.slice(MARK_LINE)];
    await act(doc, '刪除第 10 行', command('editor.action.deleteLines'), deleted);
    const afterDelete = observe(doc);
    await act(doc, '復原', undo(editor), base);
    assert.deepStrictEqual(observe(doc), markAt(MARK_LINE), `刪除後的書籤：${JSON.stringify(afterDelete)}`);
  });

  it('情境 1c：選取第 9～11 行一起刪掉再復原，書籤回到第 10 行', async () => {
    const editor = await setup('delete_block_undo');
    const doc = editor.document;
    editor.selection = new vscode.Selection(MARK_LINE - 2, 0, MARK_LINE + 1, 0);
    const deleted = [...LINES.slice(0, MARK_LINE - 2), ...LINES.slice(MARK_LINE + 1)];
    await act(doc, '刪除第 9～11 行', command('deleteLeft'), deleted);
    await act(doc, '復原', undo(editor), LINES, false);
    assert.deepStrictEqual(observe(doc), markAt(MARK_LINE));
  });

  it('情境 1d：刪掉書籤行、再到別處打字，連續復原兩次後書籤回到第 10 行', async () => {
    const editor = await setup('delete_type_undo');
    const doc = editor.document;
    const deleted = [...LINES.slice(0, MARK_LINE - 1), ...LINES.slice(MARK_LINE)];
    await act(doc, '刪除第 10 行', command('editor.action.deleteLines'), deleted);
    const typed = [...deleted];
    typed[1] = `${typed[1]} // note`;
    await act(doc, '在第 2 行行尾打字', () => editor.edit((b) => b.insert(new vscode.Position(1, deleted[1].length), ' // note')), typed);
    await act(doc, '復原打字', undo(editor), deleted);
    await act(doc, '復原刪行', undo(editor), LINES, false);
    assert.deepStrictEqual(observe(doc), markAt(MARK_LINE));
  });

  it('情境 1e：刪行時設定為「刪除書籤」，復原後書籤整筆回來', async () => {
    const config = vscode.workspace.getConfiguration('functionBookmarks');
    await config.update('bookmarks.onLineDelete', 'remove', vscode.ConfigurationTarget.Workspace);
    try {
      const editor = await setup('delete_remove_undo');
      const doc = editor.document;
      const id = api.store.bookmarksFor(doc.uri)[0].id;
      const deleted = [...LINES.slice(0, MARK_LINE - 1), ...LINES.slice(MARK_LINE)];
      await act(doc, '刪除第 10 行', command('editor.action.deleteLines'), deleted);
      assert.deepStrictEqual(observe(doc), [], '刪行後書籤被刪除');
      await act(doc, '復原', undo(editor), LINES, false);
      assert.deepStrictEqual(observe(doc), markAt(MARK_LINE));
      assert.strictEqual(api.store.bookmarksFor(doc.uri)[0].id, id, '放回的是同一筆書籤');
    } finally {
      await config.update('bookmarks.onLineDelete', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it('情境 1b：上方插入 20 行後書籤在第 30 行，復原後回到第 10 行', async () => {
    const editor = await setup('insert_undo');
    const doc = editor.document;
    const extra = Array.from({ length: 20 }, (_, i) => `const extra${i + 1} = ${i + 1};`);
    const inserted = [...LINES.slice(0, 4), ...extra, ...LINES.slice(4)];
    await act(
      doc,
      '第 5 行前插入 20 行',
      () => editor.edit((b) => b.insert(new vscode.Position(4, 0), content(extra))),
      inserted,
    );
    assert.deepStrictEqual(observe(doc), markAt(30), '插入後');
    await act(doc, '復原', undo(editor), LINES, false);
    assert.deepStrictEqual(observe(doc), markAt(MARK_LINE), '復原後');
  });

  it('情境 2：書籤行往下移兩次，書籤跟到第 12 行', async () => {
    const editor = await setup('move_down');
    const doc = editor.document;
    cursor(editor, MARK_LINE);
    const once = moved(LINES, 10, 10, 12);
    await act(doc, '第一次下移', command('editor.action.moveLinesDownAction'), once);
    const afterFirst = observe(doc);
    await act(doc, '第二次下移', command('editor.action.moveLinesDownAction'), moved(once, 11, 11, 13));
    assert.deepStrictEqual(observe(doc), markAt(12), `第一次下移後的書籤：${JSON.stringify(afterFirst)}`);
  });

  it('情境 2b：選取第 8～12 行整段上移一次，書籤跟到第 9 行', async () => {
    const editor = await setup('move_block_up');
    const doc = editor.document;
    editor.selection = new vscode.Selection(7, 0, 11, LINES[11].length);
    await act(doc, '整段上移', command('editor.action.moveLinesUpAction'), moved(LINES, 8, 12, 7));
    assert.deepStrictEqual(observe(doc), markAt(9));
  });

  it('情境 3：書籤行併到上一行，書籤在合併後的第 9 行', async () => {
    const editor = await setup('join_up');
    const doc = editor.document;
    cursor(editor, MARK_LINE);
    const merged = LINES[8] + LINES[9];
    await act(doc, '第 10 行開頭按退格', command('deleteLeft'), [...LINES.slice(0, 8), merged, ...LINES.slice(10)]);
    assert.deepStrictEqual(observe(doc), markAt(9, merged));
  });

  it('情境 3b：下一行併到書籤行，書籤留在第 10 行', async () => {
    const editor = await setup('join_next');
    const doc = editor.document;
    cursor(editor, MARK_LINE + 1);
    const merged = LINES[9] + LINES[10];
    await act(doc, '第 11 行開頭按退格', command('deleteLeft'), [...LINES.slice(0, 9), merged, ...LINES.slice(11)]);
    assert.deepStrictEqual(observe(doc), markAt(MARK_LINE, merged));
  });

  /** 模擬格式化工具：用一次 WorkspaceEdit 把整份文件換掉。 */
  async function replaceWithFormatted(doc: vscode.TextDocument): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    edit.replace(doc.uri, new vscode.Range(new vscode.Position(0, 0), end), content(FORMATTED));
    assert.ok(await vscode.workspace.applyEdit(edit));
  }

  it('情境 4a：整份格式化（未存檔），行號書籤移到第 14 行', async () => {
    const editor = await setup('format_unsaved');
    const doc = editor.document;
    await act(doc, '整份替換', () => replaceWithFormatted(doc), FORMATTED);
    assert.deepStrictEqual(observe(doc), markAt(14));
  });

  it('情境 4a 變化：整份格式化後立刻存檔，行號書籤移到第 14 行', async () => {
    const editor = await setup('format_saved');
    const doc = editor.document;
    await doc.save();
    await settle(doc.uri);
    await act(
      doc,
      '整份替換並存檔',
      async () => {
        await replaceWithFormatted(doc);
        assert.ok(await doc.save());
      },
      FORMATTED,
      false,
    );
    assert.deepStrictEqual(observe(doc), markAt(14));
    assert.strictEqual(api.store.bookmarksFor(doc.uri)[0].anchor?.text, MARK_TEXT);
  });

  /** 開啟測試檔並對指定函式加函式書籤。 */
  async function setupFavorite(name: string, symbolPath: string): Promise<vscode.TextDocument> {
    const uri = await createFile(name);
    const editor = await open(uri, api);
    const node = await waitFor(
      async () => {
        await api.refreshNow();
        return findNode(api.provider.currentSymbolNodes, symbolPath);
      },
      (n) => n !== undefined,
      { timeoutMs: 10000, label: `偵測到函式 ${symbolPath}` },
    );
    await vscode.commands.executeCommand('functionBookmarks.addFavorite', node);
    await api.favorites.refresh();
    await api.favorites.whenReady();
    assert.deepStrictEqual(api.favorites.all.map((f) => f.mark.path), [symbolPath]);
    return editor.document;
  }

  /** 等函式書籤依目前內容重新解析（結束行等於預期值），回傳它指到的位置（行號從 1 起算）。 */
  async function expectFavorite(doc: vscode.TextDocument, symbolPath: string, nameLine: number, endLine: number) {
    const want = { path: symbolPath, status: 'ok', nameLine, endLine, icons: [nameLine] };
    await settle(doc.uri);
    await waitFor(
      async () => {
        await api.favorites.refresh();
        await api.favorites.whenReady();
        await api.gutter.update();
        return api.favorites.all.map((f) => ({
          path: f.mark.path,
          status: f.status,
          nameLine: f.symbol && f.symbol.nameLine + 1,
          endLine: f.symbol && f.symbol.endLine + 1,
          icons: api.gutter.linesFor(doc.uri).map((l) => l + 1),
        }));
      },
      (v) => JSON.stringify(v) === JSON.stringify([want]),
      { timeoutMs: 8000, label: `函式書籤指向 ${JSON.stringify(want)}` },
    );
    assert.ok(doc.lineAt(nameLine - 1).text.includes(`function ${symbolPath}(`));
  }

  it('情境 4b：參數列被拆成多行，函式書籤仍指向函式名稱那一行（未存檔與存檔後）', async () => {
    const doc = await setupFavorite('format_favorite', 'formatInvoice');
    await expectFavorite(doc, 'formatInvoice', 2, 4);
    await replaceWithFormatted(doc);
    await waitFor(() => doc.isDirty, (v) => v, '整份替換後為未存檔');
    await expectFavorite(doc, 'formatInvoice', 2, 8);
    assert.ok(await doc.save());
    await expectFavorite(doc, 'formatInvoice', 2, 8);
  });

  it('情境 4b 變化：被拆行的函式下方的函式書籤，跟著函式名稱行往下 4 行', async () => {
    const doc = await setupFavorite('format_favorite_below', 'printSummary');
    await expectFavorite(doc, 'printSummary', 16, 18);
    await replaceWithFormatted(doc);
    await waitFor(() => doc.isDirty, (v) => v, '整份替換後為未存檔');
    await expectFavorite(doc, 'printSummary', 20, 22);
    assert.ok(await doc.save());
    await expectFavorite(doc, 'printSummary', 20, 22);
  });
});
