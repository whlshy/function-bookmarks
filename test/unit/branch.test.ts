import * as assert from 'assert';
import * as path from 'path';
import { parseGitFile, parseHead, parseHeadName } from '../../src/git/branch';
import { makeAnchor } from '../../src/bookmarks/model';
import { hashLine, relocateOnBranch } from '../../src/bookmarks/relocate';

describe('讀取 git 分支', () => {
  it('HEAD：分支名稱（含斜線）、detached commit、無法辨識', () => {
    assert.deepStrictEqual(parseHead('ref: refs/heads/main\n'), { name: 'main' });
    assert.deepStrictEqual(parseHead('ref: refs/heads/feature/login-page'), { name: 'feature/login-page' });
    assert.deepStrictEqual(parseHead('3F2a9c1d0e4b5a6978c0d1e2f3a4b5c6d7e8f901\n'), { commit: '3f2a9c1d0e4b5a6978c0d1e2f3a4b5c6d7e8f901' });
    assert.deepStrictEqual(parseHead('garbage'), {});
  });

  it('worktree／submodule 的 .git 檔案、rebase 進行中的 head-name', () => {
    const dir = path.resolve('/repo/wt');
    assert.strictEqual(parseGitFile('gitdir: ../main/.git/worktrees/wt\n', dir), path.resolve(dir, '../main/.git/worktrees/wt'));
    assert.strictEqual(parseGitFile('nothing', dir), undefined);
    assert.strictEqual(parseHeadName('refs/heads/feature/x\n'), 'feature/x');
    assert.strictEqual(parseHeadName('detached'), undefined);
  });
});

describe('切換分支時的書籤換算（relocateOnBranch）', () => {
  const main = Array.from({ length: 20 }, (_, i) => `common_${i} = shared(${i})`);
  // feature 分支：第 5 行前多了一段只有 feature 才有的程式碼
  const feature = [...main.slice(0, 5), 'def feature_only():', '    return build_feature_payload()', '', ...main.slice(5)];
  const H = (ls: string[]) => ls.map(hashLine);
  const onFeature = [
    { id: 'f', line: 6, anchor: makeAnchor(feature, 6) },
    { id: 'c', line: 15, anchor: makeAnchor(feature, 15) },
  ];

  it('feature → main（第一次去）：共同的程式碼換算位置，feature 才有的標成不在此分支；記下 feature 的位置', () => {
    const r = relocateOnBranch({ bookmarks: onFeature, oldHashes: H(feature), newLines: main, switched: true, prevBranch: 'feature', curBranch: 'main' });
    assert.strictEqual(r[0].status, 'notOnBranch');
    assert.deepStrictEqual(r[0].positions, { feature: { line: 6 } });
    assert.deepStrictEqual(r[1], { id: 'c', line: 12, positions: { feature: { line: 15 } } });
  });

  it('再切回 feature：用記住的 feature 內容換算，兩個都回到原位；記下 main 的位置', () => {
    const onMain = relocateOnBranch({ bookmarks: onFeature, oldHashes: H(feature), newLines: main, switched: true, prevBranch: 'feature', curBranch: 'main' });
    const back = relocateOnBranch({
      bookmarks: onFeature.map((b, i) => ({ ...b, line: onMain[i].line, status: onMain[i].status, positions: onMain[i].positions })),
      oldHashes: H(main),
      newLines: feature,
      switched: true,
      prevBranch: 'main',
      curBranch: 'feature',
      curSnapshot: H(feature),
    });
    assert.deepStrictEqual(back.map((b) => [b.id, b.line, b.status]), [
      ['f', 6, undefined],
      ['c', 15, undefined],
    ]);
    assert.strictEqual(back[0].positions?.main.status, 'notOnBranch');
    assert.deepStrictEqual(back[1].positions?.main, { line: 12 });
  });

  it('離開後 feature 又多了新 commit（例如別人 push 後 pull）：從記住的內容再換算', () => {
    const later = ['import os', ...feature];
    const r = relocateOnBranch({
      bookmarks: onFeature.map((b) => ({ ...b, line: 0, positions: { feature: { line: b.line } } })),
      oldHashes: H(main),
      newLines: later,
      switched: true,
      prevBranch: 'main',
      curBranch: 'feature',
      curSnapshot: H(feature),
    });
    assert.deepStrictEqual(r.map((b) => b.line), [7, 16]);
  });

  it('只屬於別的分支的書籤（隱藏）：不換算、狀態不變，只記下位置', () => {
    const r = relocateOnBranch({
      bookmarks: [{ ...onFeature[0], hidden: true }],
      oldHashes: H(feature),
      newLines: main,
      switched: true,
      prevBranch: 'feature',
      curBranch: 'main',
    });
    assert.deepStrictEqual(r, [{ id: 'f', line: 6, positions: { feature: { line: 6 } } }]);
  });

  it('沒有切換分支時找不到：需確認（lost）；detached HEAD 不記位置', () => {
    const del = [...feature.slice(0, 6), ...feature.slice(7)];
    const r = relocateOnBranch({ bookmarks: [onFeature[0]], oldHashes: H(feature), newLines: del, switched: false, curBranch: 'feature' });
    assert.deepStrictEqual(r, [{ id: 'f', line: 6, status: 'lost' }]);
    const d = relocateOnBranch({ bookmarks: [onFeature[0]], oldHashes: H(feature), newLines: main, switched: true, prevBranch: undefined, curBranch: undefined });
    assert.strictEqual(d[0].positions, undefined);
    assert.strictEqual(d[0].status, 'notOnBranch');
  });
});
