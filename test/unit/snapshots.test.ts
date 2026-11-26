import * as assert from 'assert';
import type * as vscode from 'vscode';
import { FileSnapshots } from '../../src/bookmarks/snapshots';

/** 記在記憶體的 workspaceState。 */
function memento(initial: Record<string, unknown> = {}): vscode.Memento & { data: Map<string, unknown> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    keys: () => [...data.keys()],
    get: <T>(key: string, def?: T) => (data.has(key) ? (data.get(key) as T) : def),
    update: async (key: string, value: unknown) => {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
  } as vscode.Memento & { data: Map<string, unknown> };
}

describe('外部改檔換算用的檔案快照（FileSnapshots）', () => {
  it('記住內容與分支，寫入後重新載入一樣', async () => {
    const state = memento();
    const s = new FileSnapshots(state);
    s.remember('a', [1, 2, 3], 'main');
    s.saveBranch('a', 'feature', [9]);
    await s.flush();
    const again = new FileSnapshots(state);
    assert.deepStrictEqual(again.content('a'), [1, 2, 3]);
    assert.strictEqual(again.branchOf('a'), 'main');
    assert.deepStrictEqual(again.branchSnapshot('a', 'feature'), [9]);
    again.dispose();
    s.dispose();
  });

  it('remember 沒給分支時保留原本的分支；setBranch 只改分支', () => {
    const s = new FileSnapshots(memento());
    s.remember('a', [1], 'main');
    s.remember('a', [2], undefined);
    assert.strictEqual(s.branchOf('a'), 'main');
    s.setBranch('a', 'dev');
    assert.deepStrictEqual([s.content('a'), s.branchOf('a')], [[2], 'dev']);
    s.dispose();
  });

  it('每個檔案最多記住 10 個分支，丟掉最舊的；重新記下的分支排到最新', () => {
    const s = new FileSnapshots(memento());
    for (let i = 0; i < 10; i++) {
      s.saveBranch('a', `b${i}`, [i]);
    }
    s.saveBranch('a', 'b0', [100]);
    s.saveBranch('a', 'b10', [10]);
    assert.deepStrictEqual(s.branches('a'), ['b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b0', 'b10']);
    assert.deepStrictEqual(s.branchSnapshot('a', 'b0'), [100]);
    s.dispose();
  });

  it('改名時內容、分支與分支快照都搬到新的鍵', () => {
    const s = new FileSnapshots(memento());
    s.remember('old', [1], 'main');
    s.saveBranch('old', 'dev', [2]);
    s.move('old', 'new');
    assert.strictEqual(s.has('old'), false);
    assert.deepStrictEqual([s.content('new'), s.branchOf('new'), s.branches('new')], [[1], 'main', ['dev']]);
    assert.deepStrictEqual([...s.keys()], ['new']);
    s.dispose();
  });

  it('forgetBranches／rememberedBranches 可限定範圍；forget 清掉整個檔案', () => {
    const s = new FileSnapshots(memento());
    s.saveBranch('x/a', 'dev', [1]);
    s.saveBranch('y/b', 'dev', [2]);
    s.saveBranch('y/b', 'old', [3]);
    const inY = (k: string) => k.startsWith('y/');
    assert.deepStrictEqual(s.rememberedBranches(inY).sort(), ['dev', 'old']);
    s.forgetBranches(['dev'], inY);
    assert.deepStrictEqual([s.branches('x/a'), s.branches('y/b')], [['dev'], ['old']]);
    s.forget('y/b');
    assert.deepStrictEqual([...s.keys()], ['x/a']);
    s.dispose();
  });

  it('讀得懂舊版只存內容的 snapshots:v1，壞掉的值略過', () => {
    const s = new FileSnapshots(memento({ 'snapshots:v1': { a: [1, 2], bad: 'x' } }));
    assert.deepStrictEqual(s.content('a'), [1, 2]);
    assert.strictEqual(s.has('bad'), false);
    s.dispose();
  });

  it('dispose 時把延後中的變更寫入', async () => {
    const state = memento();
    const s = new FileSnapshots(state);
    s.remember('a', [7], 'main');
    assert.strictEqual(state.data.has('snapshots:v2'), false, '還在延後中');
    s.dispose();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual((state.data.get('snapshots:v2') as { known: Record<string, number[]> }).known, { a: [7] });
  });
});
