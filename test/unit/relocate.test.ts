import * as assert from 'assert';
import { makeAnchor } from '../../src/bookmarks/model';
import { conflictRegions, diffLines, hashLine, mapLine, relocate, relocateBookmarks, similarity, splitLines } from '../../src/bookmarks/relocate';

const H = (s: string) => splitLines(s).map(hashLine);
const L = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix}_${i} = ${i}`);

/** 依差異把舊陣列轉成新陣列，驗證差異區塊正確。 */
function apply(a: string[], b: string[]): string[] {
  const hunks = diffLines(a.map(hashLine), b.map(hashLine));
  const out: string[] = [];
  let i = 0;
  for (const h of hunks) {
    out.push(...a.slice(i, h.oldStart));
    out.push(...b.slice(h.newStart, h.newEnd));
    i = h.oldEnd;
  }
  out.push(...a.slice(i));
  return out;
}

describe('行差異比對（diffLines）', () => {
  it('相同內容沒有差異', () => {
    assert.deepStrictEqual(diffLines(H('a\nb'), H('a\nb')), []);
  });

  it('插入、刪除、修改、多處同時變動，套用後都等於新內容', () => {
    const a = L(30);
    const cases: string[][] = [
      ['x', 'y', ...a],
      [...a.slice(0, 10), 'inserted', ...a.slice(10)],
      [...a.slice(0, 5), ...a.slice(9)],
      [...a.slice(0, 7), 'changed', ...a.slice(8)],
      ['top', ...a.slice(0, 12), ...a.slice(14, 20), 'mid1', 'mid2', ...a.slice(20), 'end'],
      [],
      ['completely', 'different'],
    ];
    for (const b of cases) {
      assert.deepStrictEqual(apply(a, b), b);
    }
  });

  it('差異區塊依舊檔位置排序', () => {
    const a = L(10);
    const b = ['new', ...a.slice(0, 5), 'mid', ...a.slice(5)];
    assert.deepStrictEqual(diffLines(a.map(hashLine), b.map(hashLine)), [
      { oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 1 },
      { oldStart: 5, oldEnd: 5, newStart: 6, newEnd: 7 },
    ]);
  });

  it('插入、刪除、替換混合：差異區塊與位置固定（回歸）', () => {
    const a = L(20);
    const b = [
      ...a.slice(0, 2),
      'ins1',
      'ins2', // 第 2 行前插入 2 行
      ...a.slice(2, 6),
      'repl', // 第 6 行替換
      ...a.slice(7, 10),
      // 第 10、11 行刪除
      ...a.slice(12, 15),
      'rA',
      'rB', // 第 15 行替換成 2 行
      ...a.slice(16),
    ];
    assert.deepStrictEqual(diffLines(a.map(hashLine), b.map(hashLine)), [
      { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 4 },
      { oldStart: 6, oldEnd: 7, newStart: 8, newEnd: 9 },
      { oldStart: 10, oldEnd: 12, newStart: 12, newEnd: 12 },
      { oldStart: 15, oldEnd: 16, newStart: 15, newEnd: 17 },
    ]);
    assert.deepStrictEqual(apply(a, b), b);
  });

  describe('大檔大改', () => {
    const N = 20000;
    const a = L(N);
    const ha = a.map(hashLine);

    it('2 萬行、每 12 行改一行（編輯距離約 3300，接近上限）：3 秒內完成，結果正確', () => {
      const changed = new Set<number>();
      const b = a.map((s, i) => {
        if (i % 12 === 6) {
          changed.add(i);
          return `${s} // edited`;
        }
        return s;
      });
      const t0 = Date.now();
      const hunks = diffLines(ha, b.map(hashLine));
      const ms = Date.now() - t0;
      assert.ok(ms < 3000, `diffLines 花了 ${ms}ms`);
      assert.strictEqual(hunks.length, changed.size, '每個被改的行各一個差異區塊');
      assert.deepStrictEqual(apply(a, b), b);
      for (const i of [0, 5, 7, 11, 13, 5999, 6001, 19999]) {
        assert.deepStrictEqual(mapLine(i, hunks), { line: i, changed: changed.has(i) }, `第 ${i} 行`);
      }
    });

    it('2 萬行、多處插入與刪除讓行號大幅位移：未改動的行換算正確', () => {
      const out: string[] = [];
      const newIndex = new Map<number, number>();
      for (let i = 0; i < N; i++) {
        if (i % 15 === 3) {
          continue; // 刪除
        }
        if (i % 15 === 9) {
          out.push(`inserted_before_${i}`); // 插入
        }
        newIndex.set(i, out.length);
        out.push(a[i]);
      }
      const t0 = Date.now();
      const hunks = diffLines(ha, out.map(hashLine));
      const ms = Date.now() - t0;
      assert.ok(ms < 3000, `diffLines 花了 ${ms}ms`);
      assert.deepStrictEqual(apply(a, out), out);
      for (const i of [0, 2, 4, 8, 9, 10, 14, 15, 18, 9999, 10001, 19998]) {
        const expected = newIndex.get(i);
        if (expected !== undefined) {
          assert.deepStrictEqual(mapLine(i, hunks), { line: expected, changed: false }, `第 ${i} 行`);
        }
      }
    });

    it('改動超過編輯距離上限（每 5 行改一行）：不卡住，整段視為被取代，套用後仍等於新內容', () => {
      const b = a.map((s, i) => (i % 5 === 2 ? `${s} // edited` : s));
      const t0 = Date.now();
      const hunks = diffLines(ha, b.map(hashLine));
      const ms = Date.now() - t0;
      assert.ok(ms < 3000, `diffLines 花了 ${ms}ms`);
      assert.deepStrictEqual(apply(a, b), b);
      assert.ok(hunks.length >= 1);
    });
  });

  it('行尾空白與 \\r 不影響比對', () => {
    assert.strictEqual(hashLine('abc  '), hashLine('abc'));
    assert.deepStrictEqual(diffLines(H('a\r\nb'), H('a\nb')), []);
  });
});

describe('行號換算（mapLine）', () => {
  const hunks = [
    { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 5 }, // 第 2 行前插入 3 行
    { oldStart: 10, oldEnd: 12, newStart: 13, newEnd: 13 }, // 刪除第 10、11 行
  ];

  it('差異之前不變、之後依增減平移', () => {
    assert.deepStrictEqual(mapLine(1, hunks), { line: 1, changed: false });
    assert.deepStrictEqual(mapLine(2, hunks), { line: 5, changed: false });
    assert.deepStrictEqual(mapLine(12, hunks), { line: 13, changed: false });
  });

  it('落在被刪除或修改的範圍內：changed', () => {
    assert.deepStrictEqual(mapLine(10, hunks), { line: 13, changed: true });
  });
});

describe('後備定位（relocate）', () => {
  const base = ['def a():', '    x = load()', '    return x', '', 'def b():', '    y = load()', '    return y'];

  it('內容相同的行有多個時，依前後文挑對的那一個', () => {
    const anchor = makeAnchor(base, 6); // b 裡的 return y
    const moved = ['# new', ...base];
    assert.strictEqual(relocate(moved, anchor, 0), 7);
  });

  it('太短的內容（例如 pass、}）需要前後文佐證', () => {
    const lines = ['def a():', '    pass', 'def b():', '    pass'];
    const anchor = makeAnchor(lines, 3);
    assert.strictEqual(relocate(['x', ...lines], anchor, 0), 4);
    assert.strictEqual(relocate(['def z():', '    pass'], anchor, 1), undefined, '前後文不符就不猜');
  });

  it('該行被小幅修改：在附近找相似的行', () => {
    const anchor = makeAnchor(base, 5);
    const edited = [...base.slice(0, 5), '    y = load(force=True)', ...base.slice(6)];
    assert.strictEqual(relocate(edited, anchor, 5), 5);
  });

  it('函式相對定位：同一個函式內相同偏移', () => {
    const anchor = makeAnchor(base, 5, 'b', 4);
    const changed = ['x', 'x', 'x', 'def b():', '    y = load_v2()', '    return y'];
    assert.strictEqual(relocate(changed, anchor, 0, 3), 4);
  });

  it('真的找不到回傳 undefined', () => {
    assert.strictEqual(relocate(['totally', 'different'], makeAnchor(base, 1), 0), undefined);
  });

  it('相似度', () => {
    assert.strictEqual(similarity('abc', 'abc'), 1);
    assert.ok(similarity('return render(request)', 'return render(req)') > 0.7);
    assert.ok(similarity('abc', 'xyz') < 0.1);
  });
});

describe('一個檔案的行號書籤重新定位（relocateBookmarks）', () => {
  const old = L(20);
  const bm = (id: string, line: number) => ({ id, line, anchor: makeAnchor(old, line) });

  it('git pull：上方插入、下方刪除，書籤依差異移動', () => {
    const next = ['import a', 'import b', ...old.slice(0, 15), ...old.slice(18)];
    const r = relocateBookmarks([bm('a', 3), bm('b', 19)], old.map(hashLine), next);
    assert.deepStrictEqual(r, [
      { id: 'a', line: 5 },
      { id: 'b', line: 18 },
    ]);
  });

  it('本機有未提交的修改：記住的就是磁碟上的內容，一樣換算正確', () => {
    const local = [...old.slice(0, 2), 'local edit', ...old.slice(2)]; // 本機多一行
    const mark = { id: 'a', line: 10, anchor: makeAnchor(local, 10) };
    const pulled = ['from remote', ...local];
    assert.deepStrictEqual(relocateBookmarks([mark], local.map(hashLine), pulled), [{ id: 'a', line: 11 }]);
  });

  it('書籤那一行被刪除：後備定位找不到時標成需確認', () => {
    const next = [...old.slice(0, 7), ...old.slice(8)];
    assert.deepStrictEqual(relocateBookmarks([bm('a', 7)], old.map(hashLine), next), [{ id: 'a', line: 7, status: 'lost' }]);
  });

  it('書籤那一行被搬到很遠的地方：後備定位找回來', () => {
    const next = [old[12], ...old.slice(0, 12), ...old.slice(13)];
    assert.deepStrictEqual(relocateBookmarks([bm('a', 12)], old.map(hashLine), next), [{ id: 'a', line: 0 }]);
  });

  it('沒有記住的內容時：用 anchor 檢查並後備定位', () => {
    const next = ['x', 'y', ...old];
    assert.deepStrictEqual(relocateBookmarks([bm('a', 4)], undefined, next), [{ id: 'a', line: 6 }]);
  });

  it('合併衝突範圍內的書籤標成需確認；衝突解完後再定位就恢復', () => {
    const conflict = [...old.slice(0, 5), '<<<<<<< HEAD', old[5], '=======', 'theirs', '>>>>>>> branch', ...old.slice(6)];
    assert.deepStrictEqual(conflictRegions(conflict), [[5, 9]]);
    const r = relocateBookmarks([bm('a', 5)], old.map(hashLine), conflict);
    assert.strictEqual(r[0].status, 'lost');
    const resolved = relocateBookmarks([{ ...bm('a', 5), line: r[0].line, status: 'lost' }], conflict.map(hashLine), old);
    assert.deepStrictEqual(resolved, [{ id: 'a', line: 5 }]);
  });
});
