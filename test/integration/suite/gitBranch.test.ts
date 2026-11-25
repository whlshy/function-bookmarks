import * as assert from 'assert';
import * as cp from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../src/extension';
import { makeAnchor, newBookmarkId } from '../../../src/bookmarks/model';
import { ensureBookmarksFileExcluded } from '../../../src/storage/gitExcludeFs';
import { addBookmark, emptyStore } from '../../../src/storage/marks';
import type { BmGroupNode, BookmarkNode } from '../../../src/views/tree';
import {
  activateExtension,
  cleanBothStorages,
  cleanupWorkspaceStore,
  fileExists,
  folder,
  waitFor,
  workspaceFile,
} from './helpers';

describe('Git 分支追蹤與 .git/info/exclude', () => {
  let api: ExtensionApi;

  before(async () => {
    api = await activateExtension();
  });

  after(async () => {
    await cleanupWorkspaceStore(api);
  });

  describe('切換分支（臨時 git 專案）', () => {
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
    const state = (uri: vscode.Uri) =>
      api.store.bookmarksFor(uri).map((b) => (b.status === 'notOnBranch' ? '~' : b.status === 'lost' ? `${b.line}?` : String(b.line)));

    async function settle(uri: vscode.Uri, want: string[], label: string): Promise<string[]> {
      return waitFor(
        async () => {
          await api.branches.refresh();
          await api.external.idle();
          return state(uri);
        },
        (v) => JSON.stringify(v) === JSON.stringify(want),
        { timeoutMs: 10000, label },
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

    it('檔案沒開著：切到 main，feature 才有的程式碼與檔案標成不在此分支，共同的換算位置；切回 feature 全部恢復', async () => {
      assert.strictEqual(api.treeView.description, 'feature', '標題旁顯示目前分支');
      await checkout('main');
      assert.deepStrictEqual(await settle(fileA(), ['~', '12'], '切到 main 後 fileA 換算'), ['~', '12']);
      assert.deepStrictEqual(await settle(fileB(), ['~'], '切到 main 後 fileB 標為不在此分支'), ['~']);
      assert.strictEqual(api.treeView.description, 'main');
      const groups = await api.provider.getChildren(api.provider.sections.bookmarks);
      const group = groups.find((g) => (g as BmGroupNode).rel === rel(fileA()))!;
      const node = (await api.provider.getChildren(group))[0] as BookmarkNode;
      const item = api.provider.getTreeItem(node);
      assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'git-branch');
      assert.ok(String(item.contextValue).includes(':away'));

      await checkout('feature');
      assert.deepStrictEqual(await settle(fileA(), ['6', '15'], '切回 feature 後 fileA 恢復'), ['6', '15']);
      assert.deepStrictEqual(await settle(fileB(), ['2'], '切回 feature 後 fileB 恢復'), ['2']);
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
        assert.deepStrictEqual(await settle(fileA(), ['~', '12'], `第 ${i + 1} 輪切到 main`), ['~', '12']);
        await checkout('feature');
        assert.deepStrictEqual(await settle(fileA(), ['6', '15'], `第 ${i + 1} 輪切回 feature`), ['6', '15']);
      }
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === fileA().toString())!;
      assert.strictEqual(doc.isDirty, false);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('隱藏不在此分支的書籤；只在這個分支顯示的書籤在其他分支隱藏且不換算', async () => {
      await checkout('main');
      await settle(fileA(), ['~', '12'], '切到 main');
      await vscode.commands.executeCommand('functionBookmarks.hideNotOnBranch');
      const groups = await api.provider.getChildren(api.provider.sections.bookmarks);
      assert.ok(!groups.some((g) => (g as BmGroupNode).rel === rel(fileB())), '整個檔案都不在此分支：不列出');
      await vscode.commands.executeCommand('functionBookmarks.showNotOnBranch');
      await checkout('feature');
      await settle(fileA(), ['6', '15'], '切回 feature');

      const entry = api.store.allBookmarks().find((e) => e.bookmark.file === rel(fileA()) && e.bookmark.line === 15)!;
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkBranchOnly', { type: 'bookmark', entry });
      assert.strictEqual(api.store.bookmarksFor(fileA()).find((b) => b.id === entry.bookmark.id)?.homeBranch, 'feature');
      await checkout('main');
      assert.deepStrictEqual(await settle(fileA(), ['~'], '只屬於 feature 的書籤在 main 看不到'), ['~']);
      const hidden = api.store.bookmarksFor(fileA(), { includeHidden: true }).find((b) => b.id === entry.bookmark.id)!;
      assert.strictEqual(hidden.line, 15, '隱藏期間不換算');
      await checkout('feature');
      assert.deepStrictEqual(await settle(fileA(), ['6', '15'], '切回 feature 恢復顯示'), ['6', '15']);
      const back = api.store.allBookmarks().find((e) => e.bookmark.id === entry.bookmark.id)!;
      await vscode.commands.executeCommand('functionBookmarks.setBookmarkAllBranches', { type: 'bookmark', entry: back });
      assert.strictEqual(api.store.bookmarksFor(fileA()).find((b) => b.id === entry.bookmark.id)?.scope, undefined);
    });

    it('檔案在分支間改名：書籤跟著改名後的檔案；切回去再跟回來', async () => {
      await plant(fileC(), cLines, [3]);
      git('checkout', '-b', 'renamed');
      git('mv', rel(fileC()), rel(fileC2()));
      git('commit', '-m', 'rename');
      assert.deepStrictEqual(await settle(fileC2(), ['3'], '分支改名後書籤移至新檔名'), ['3']);
      assert.deepStrictEqual(state(fileC()), []);
      await checkout('feature');
      assert.deepStrictEqual(await settle(fileC(), ['3'], '切回原分支後書籤跟回原檔名'), ['3']);
      git('branch', '-D', 'renamed');
    });

    it('清理已刪除分支的紀錄', async () => {
      git('checkout', '-b', 'temp');
      await fsp.writeFile(fileA().fsPath, text(['# temp', ...feature]));
      git('commit', '-am', 'temp');
      await settle(fileA(), ['7', '16'], 'temp 分支定位');
      await checkout('feature');
      await settle(fileA(), ['6', '15'], '切回 feature');
      assert.ok(api.store.bookmarksFor(fileA())[0].positions?.temp, '記下了 temp 分支的位置');
      git('branch', '-D', 'temp');
      const removed = await vscode.commands.executeCommand<string[]>('functionBookmarks.cleanBranchRecords', ['temp']);
      assert.deepStrictEqual(removed, ['temp']);
      assert.strictEqual(api.store.bookmarksFor(fileA())[0].positions?.temp, undefined);
      assert.ok(!api.external.snapshotBranches(fileA()).includes('temp'));
    });

    it('切換存放位置到空白端（不論是否馬上複製）保留分支快照；選保持空白或真正刪除書籤後才清理（CR-07）', async () => {
      api.store.suppressStoragePrompt = true;
      try {
        await checkout('main');
        await settle(fileA(), ['~', '12'], '累積 main 快照');
        await checkout('feature');
        await settle(fileA(), ['6', '15'], '累積 feature 快照');
        assert.ok(api.external.snapshotBranches(fileA()).includes('main'));
        assert.ok(api.external.snapshotBranches(fileA()).includes('feature'));
        await api.store.flush();

        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
        assert.strictEqual(api.store.allBookmarks().length, 0);
        await api.external.idle();
        assert.ok(api.external.snapshotBranches(fileA()).includes('main'), '切到空白端等待決定時不應清掉 main 快照');
        assert.ok(api.external.snapshotBranches(fileA()).includes('feature'), '切到空白端等待決定時不應清掉 feature 快照');

        const found = await api.store.checkOppositeStorage();
        assert.ok(found);
        await api.external.idle();
        await api.store.applyOppositeStorageChoice(found, 'copy');
        await api.external.idle();
        assert.strictEqual(api.store.bookmarksFor(fileA()).length, 2);
        assert.ok(api.external.snapshotBranches(fileA()).includes('main'));
        assert.ok(api.external.snapshotBranches(fileA()).includes('feature'));

        await api.store.update(folder(), () => emptyStore());
        await api.external.idle();
        assert.deepStrictEqual(api.external.snapshotBranches(fileA()), [], '真正刪掉書籤後快照應清理');

        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'file');
        // 等待 seed() 記下目前 feature 分支的檔案內容，再切分支重建 main 快照
        await api.external.idle();
        await checkout('main');
        await settle(fileA(), ['~', '12'], '重建 main 快照');
        await checkout('feature');
        await settle(fileA(), ['6', '15'], '重建 feature 快照');
        await api.store.flush();

        await vscode.commands.executeCommand('functionBookmarks.chooseStorage', 'workspaceState');
        const found2 = await api.store.checkOppositeStorage();
        assert.ok(found2);
        await api.store.applyOppositeStorageChoice(found2, 'keep');
        await api.external.idle();
        assert.deepStrictEqual(api.external.snapshotBranches(fileA()), [], '選保持空白後應清理不再需要的快照');
      } finally {
        await cleanBothStorages(api);
      }
    });
  });

  describe('gitExcludeFs 於 worktree 與 monorepo 子資料夾（CR-09）', () => {
    let tmpRoot: string | undefined;

    afterEach(async () => {
      if (tmpRoot) {
        await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
        tmpRoot = undefined;
      }
    });

    it('monorepo 子資料夾寫入相對 repo 根目錄的排除路徑，git worktree 寫入 commondir 的 info/exclude', async () => {
      tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-exclude-test-'));
      const mainRepo = path.join(tmpRoot, 'main-repo');
      const subPkg = path.join(mainRepo, 'packages', 'web');
      const wtDir = path.join(tmpRoot, 'wt-feature');
      const wtSub = path.join(wtDir, 'apps', 'admin');
      await fsp.mkdir(subPkg, { recursive: true });

      const runGit = (cwd: string, ...args: string[]) =>
        cp.execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], {
          cwd,
          stdio: 'pipe',
          encoding: 'utf8',
        });

      runGit(mainRepo, 'init');
      runGit(mainRepo, 'checkout', '-b', 'main');
      await fsp.writeFile(path.join(subPkg, 'index.ts'), 'export const x = 1;\n', 'utf8');
      runGit(mainRepo, 'add', '.');
      runGit(mainRepo, 'commit', '-m', 'init');
      runGit(mainRepo, 'worktree', 'add', '-b', 'feat-wt', wtDir);
      await fsp.mkdir(wtSub, { recursive: true });

      const commonExclude = path.join(mainRepo, '.git', 'info', 'exclude');
      const wtPrivateExclude = path.join(mainRepo, '.git', 'worktrees', 'wt-feature', 'info', 'exclude');

      // 1. monorepo 子資料夾
      assert.strictEqual(await ensureBookmarksFileExcluded(vscode.Uri.file(subPkg)), 'added');
      assert.strictEqual(await ensureBookmarksFileExcluded(vscode.Uri.file(subPkg)), 'already');
      assert.ok((await fsp.readFile(commonExclude, 'utf8')).includes('packages/web/.vscode/function-bookmarks.json'));
      runGit(mainRepo, 'check-ignore', 'packages/web/.vscode/function-bookmarks.json');

      // 2. git worktree 根目錄：寫入主 repo 的 commondir info/exclude
      assert.strictEqual(await ensureBookmarksFileExcluded(vscode.Uri.file(wtDir)), 'added');
      assert.strictEqual(await fileExists(vscode.Uri.file(wtPrivateExclude)), false, '不應寫進 worktree 私有的 info/exclude');
      assert.ok((await fsp.readFile(commonExclude, 'utf8')).includes('\n.vscode/function-bookmarks.json\n'));
      runGit(wtDir, 'check-ignore', '.vscode/function-bookmarks.json');

      // 3. git worktree 內的子資料夾
      assert.strictEqual(await ensureBookmarksFileExcluded(vscode.Uri.file(wtSub)), 'added');
      assert.ok((await fsp.readFile(commonExclude, 'utf8')).includes('apps/admin/.vscode/function-bookmarks.json'));
      runGit(wtDir, 'check-ignore', 'apps/admin/.vscode/function-bookmarks.json');
    });
  });
});
