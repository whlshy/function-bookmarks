import * as assert from 'assert';
import { BOOKMARKS_FILE, isCovered, parseGitDirFile, withExcludeEntry } from '../../src/storage/gitExclude';

describe('書籤檔排除於 git', () => {
  it('常見寫法都視為已涵蓋', () => {
    for (const line of [BOOKMARKS_FILE, `/${BOOKMARKS_FILE}`, '.vscode/', '.vscode', '/.vscode/', '.vscode/*']) {
      assert.ok(isCovered(`node_modules/\n${line}\n`), line);
    }
  });

  it('沒有涵蓋、空內容、只有註解時視為未涵蓋', () => {
    assert.ok(!isCovered(undefined));
    assert.ok(!isCovered(''));
    assert.ok(!isCovered(`# ${BOOKMARKS_FILE}\nnode_modules/`));
    assert.ok(!isCovered('.vscode/settings.json'));
  });

  it('後面的例外規則會把書籤檔加回來', () => {
    assert.ok(!isCovered(`.vscode/*\n!${BOOKMARKS_FILE}`));
  });

  it('加入時保留原內容並補換行；已涵蓋時不修改', () => {
    assert.strictEqual(withExcludeEntry('*.log'), `*.log\n# Function Bookmarks：個人書籤，不提交\n${BOOKMARKS_FILE}\n`);
    assert.strictEqual(withExcludeEntry(undefined), `# Function Bookmarks：個人書籤，不提交\n${BOOKMARKS_FILE}\n`);
    assert.strictEqual(withExcludeEntry(`${BOOKMARKS_FILE}\n`), undefined);
  });

  it('解析 worktree 的 .git 檔案', () => {
    assert.strictEqual(parseGitDirFile('gitdir: ../.git/worktrees/feature\n'), '../.git/worktrees/feature');
    assert.strictEqual(parseGitDirFile('nonsense'), undefined);
  });

  it('子資料夾路徑（monorepo）：正確判斷涵蓋規則並寫入相對 repo 根目錄的項目（CR-09）', () => {
    const sub = `packages/web/${BOOKMARKS_FILE}`;
    // 任一深度皆生效的規則或精確指向子資料夾的規則才算涵蓋
    for (const line of [sub, `/${sub}`, 'packages/web/.vscode/', 'packages/web/.vscode/*', '.vscode/', `**/${BOOKMARKS_FILE}`]) {
      assert.ok(isCovered(`${line}\n`, sub), `預期 ${line} 涵蓋 ${sub}`);
    }
    // 含斜線且錨定在 repo 根目錄的規則不會涵蓋子資料夾
    for (const line of [BOOKMARKS_FILE, `/${BOOKMARKS_FILE}`, '/.vscode/', '.vscode/*', '.vscode/**']) {
      assert.ok(!isCovered(`${line}\n`, sub), `預期 ${line} 不涵蓋 ${sub}`);
    }
    // 後面出現例外規則會取消涵蓋
    assert.ok(!isCovered(`packages/web/.vscode/*\n!${sub}\n`, sub));
    // 寫入時使用相對 repo 根目錄的路徑
    assert.strictEqual(
      withExcludeEntry('*.log', sub),
      `*.log\n# Function Bookmarks：個人書籤，不提交\n${sub}\n`,
    );
    assert.strictEqual(withExcludeEntry(`${sub}\n`, sub), undefined);
  });
});
