import * as assert from 'assert';
import * as cp from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { activateExtension, cleanupWorkspaceStore, fileExists, folder, resetWorkspace, waitFor, workspaceFile } from './helpers';

/** 用編輯器本身（Electron 以 Node 模式）執行專案裡的 CLI，模擬 AI 助理在終端機執行。 */
function runCli(script: string, args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

describe('設定 AI 助理 Skill＋CLI', () => {
  let api: ExtensionApi;
  const skillDir = () => workspaceFile('.cursor', 'skills', 'function-bookmarks');

  before(async () => {
    api = await activateExtension();
  });

  beforeEach(async () => {
    await resetWorkspace(api, { closeEditors: true });
  });

  after(async () => {
    await vscode.workspace.fs.delete(workspaceFile('.cursor'), { recursive: true }).then(undefined, () => undefined);
    await cleanupWorkspaceStore(api);
  });

  it('寫入 SKILL.md 與 CLI；AI 用 CLI 加的書籤會出現在編輯器，編輯器加的 CLI 也看得到', async () => {
    const r = await vscode.commands.executeCommand<{ dir: string } | undefined>('functionBookmarks.setUpAiSkill', { folder: folder(), target: 'cursor' });
    assert.strictEqual(r?.dir, '.cursor/skills/function-bookmarks');
    const skill = await fsp.readFile(vscode.Uri.joinPath(skillDir(), 'SKILL.md').fsPath, 'utf8');
    assert.ok(skill.startsWith('---\nname: function-bookmarks\n'), skill.slice(0, 80));
    assert.ok(skill.includes('node .cursor/skills/function-bookmarks/scripts/fb.js <command>'));
    assert.ok(!skill.includes('{{'), '範本的佔位字都已替換');
    const script = vscode.Uri.joinPath(skillDir(), 'scripts', 'fb.js').fsPath;
    const ext = vscode.extensions.getExtension('whlshy.function-bookmarks')!;
    assert.deepStrictEqual(await fsp.readFile(script), await fsp.readFile(path.join(ext.extensionPath, 'dist', 'cli.js')), 'CLI 與套件內的相同');

    // AI 在任何資料夾執行都改到這個專案（由 CLI 自己的位置得知），新增的函式書籤編輯器立刻看到
    const added = await runCli(script, ['add', 'app/views.py#ArticleView.get', '--label', 'AI 加的', '--json'], path.join(folder().uri.fsPath, 'app'));
    assert.strictEqual(added.code, 0, added.err);
    assert.strictEqual(JSON.parse(added.out).line, 12);
    await waitFor(
      () => api.favorites.all.map((f) => [f.mark.path, f.mark.alias]),
      (v) => v.some(([p, a]) => p === 'ArticleView.get' && a === 'AI 加的'),
      '編輯器讀到 CLI 新增的函式書籤',
    );

    // 編輯器新增的行號書籤，CLI 也列得出來
    const doc = await vscode.workspace.openTextDocument(workspaceFile('app', 'views.py'));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(15, 8, 15, 8);
    await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
    await api.store.flush();
    const listed = await runCli(script, ['list', '--json'], folder().uri.fsPath);
    assert.strictEqual(listed.code, 0, listed.err);
    const rows = JSON.parse(listed.out) as { kind: string; line: number; name?: string; function?: string }[];
    assert.deepStrictEqual(
      rows.map((x) => [x.kind, x.line, x.name ?? x.function]),
      [
        ['function', 12, 'AI 加的'],
        ['line', 16, undefined],
      ],
    );
  });

  it('再設定一次內容相同就不寫入；已設定的 Skill 會隨套件更新（舊的 CLI 被換成新版）', async () => {
    await vscode.commands.executeCommand('functionBookmarks.setUpAiSkill', { folder: folder(), target: 'cursor' });
    const script = vscode.Uri.joinPath(skillDir(), 'scripts', 'fb.js');
    await fsp.writeFile(script.fsPath, '// old version\n');
    assert.ok(await fileExists(script));
    const updated = await api.skillSetup.refreshInstalled();
    assert.strictEqual(updated, 1);
    assert.ok((await fsp.readFile(script.fsPath, 'utf8')).length > 1000, '換成套件內的 CLI');
    assert.strictEqual(await api.skillSetup.refreshInstalled(), 0, '已是最新時不寫入');
  });

  it('側邊欄 … 選單傳入的樹節點不當成選項：照常詢問 AI 助理（按 Esc 取消不寫入）', async () => {
    await vscode.workspace.fs.delete(workspaceFile('.cursor'), { recursive: true }).then(undefined, () => undefined);
    const run = vscode.commands.executeCommand('functionBookmarks.setUpAiSkill', { type: 'section', key: 'bookmarks' });
    await new Promise((r) => setTimeout(r, 300));
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    assert.strictEqual(await run, undefined);
    assert.ok(!(await fileExists(workspaceFile('.cursor'))));
  });
});
