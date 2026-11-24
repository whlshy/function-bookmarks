import * as assert from 'assert';
import { compareByTitle, lineBookmarkTitle, SortableBookmark, symbolBookmarkTitle } from '../../src/bookmarks/sort';

const sortTitles = (items: SortableBookmark[]) => [...items].sort(compareByTitle).map((i) => i.title);

describe('書籤依標題排序（compareByTitle）', () => {
  it('自然排序：數字依大小排列（item2 在 item10 前）', () => {
    const items: SortableBookmark[] = [
      { kind: 'line', title: 'item10', line: 1 },
      { kind: 'line', title: 'item2', line: 2 },
      { kind: 'line', title: 'item1', line: 3 },
      { kind: 'line', title: 'item20', line: 4 },
      { kind: 'line', title: 'item3', line: 5 },
    ];
    assert.deepStrictEqual(sortTitles(items), ['item1', 'item2', 'item3', 'item10', 'item20']);

    const versioned: SortableBookmark[] = [
      { kind: 'line', title: 'v1.10', line: 0 },
      { kind: 'line', title: 'v1.2', line: 1 },
      { kind: 'line', title: 'v1.1', line: 2 },
    ];
    assert.deepStrictEqual(sortTitles(versioned), ['v1.1', 'v1.2', 'v1.10']);
  });

  it('不分大小寫排序，大小寫不同但名稱相同時依行號排', () => {
    const items: SortableBookmark[] = [
      { kind: 'line', title: 'charlie', line: 1 },
      { kind: 'line', title: 'Banana', line: 2 },
      { kind: 'line', title: 'apple', line: 3 },
    ];
    assert.deepStrictEqual(sortTitles(items), ['apple', 'Banana', 'charlie']);

    // 名稱僅大小寫不同：視為同名，改依行號
    const sameName: SortableBookmark[] = [
      { kind: 'line', title: 'alpha', line: 20 },
      { kind: 'line', title: 'Alpha', line: 5 },
      { kind: 'line', title: 'ALPHA', line: 12 },
    ];
    assert.deepStrictEqual(
      [...sameName].sort(compareByTitle).map((i) => [i.title, i.line]),
      [
        ['Alpha', 5],
        ['ALPHA', 12],
        ['alpha', 20],
      ],
    );
  });

  it('中英文皆可排序，中文內含數字同樣採自然排序', () => {
    const zhNum: SortableBookmark[] = [
      { kind: 'line', title: '步驟10', line: 1 },
      { kind: 'line', title: '步驟2', line: 2 },
      { kind: 'line', title: '步驟1', line: 3 },
    ];
    assert.deepStrictEqual(sortTitles(zhNum), ['步驟1', '步驟2', '步驟10']);

    // 中英文混排與 Intl.Collator 一致，跨 locale 皆穩定
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const mixed: SortableBookmark[] = [
      { kind: 'line', title: '結帳流程', line: 1 },
      { kind: 'line', title: 'auth', line: 2 },
      { kind: 'line', title: '登入驗證', line: 3 },
      { kind: 'line', title: 'Beta', line: 4 },
    ];
    const expected = [...mixed].map((i) => i.title).sort((a, b) => collator.compare(a, b));
    assert.deepStrictEqual(sortTitles(mixed), expected);
  });

  it('數字書籤取名稱時不含圈號前綴，依實際標題排序', () => {
    const numbered: SortableBookmark[] = [
      {
        kind: 'line',
        title: lineBookmarkTitle({ line: 1, label: 'zeta', anchor: { text: 'z()', before: [], after: [] } }),
        line: 1,
      },
      {
        kind: 'symbol',
        title: symbolBookmarkTitle({ path: 'Cls.alpha' }),
        line: 10,
      },
      {
        kind: 'line',
        title: lineBookmarkTitle({ line: 5, label: 'beta' }),
        line: 5,
      },
    ];
    // 即使 zeta 是 1 號（①）、alpha 是 9 號（⑨），排序名稱都不含圈號，應依 alpha → beta → zeta
    assert.deepStrictEqual(sortTitles(numbered), ['alpha', 'beta', 'zeta']);
  });

  it('自訂名稱：行號書籤用 label，函式書籤用 alias，沒設時回退到符號名／該行內容／#行號', () => {
    assert.strictEqual(
      lineBookmarkTitle({ line: 4, label: '自訂行名稱', anchor: { text: 'return 1', before: [], after: [] } }),
      '自訂行名稱',
    );
    assert.strictEqual(
      lineBookmarkTitle({ line: 4, symbol: { path: 'Order.save', kind: 'method' }, anchor: { text: 'def save():', before: [], after: [] } }),
      'save',
    );
    assert.strictEqual(lineBookmarkTitle({ line: 4, anchor: { text: 'return 1', before: [], after: [] } }), 'return 1');
    assert.strictEqual(lineBookmarkTitle({ line: 4 }), '#5');

    assert.strictEqual(symbolBookmarkTitle({ path: 'Order.save', alias: '存檔入口' }), '存檔入口');
    assert.strictEqual(symbolBookmarkTitle({ path: 'Order.save' }), 'save');

    // 以自訂名稱排序（不看原函式名或原行文字）
    const items: SortableBookmark[] = [
      { kind: 'symbol', title: symbolBookmarkTitle({ path: 'a_first', alias: 'z_custom' }), line: 0 },
      { kind: 'line', title: lineBookmarkTitle({ line: 10, label: 'a_custom', anchor: { text: 'zzz()', before: [], after: [] } }), line: 10 },
      { kind: 'symbol', title: symbolBookmarkTitle({ path: 'm_middle' }), line: 5 },
    ];
    assert.deepStrictEqual(sortTitles(items), ['a_custom', 'm_middle', 'z_custom']);
  });

  it('名稱相同時依行號排；找不到行號排最後；同行時函式書籤在行號書籤前（混排）', () => {
    const items: SortableBookmark[] = [
      { kind: 'line', title: 'dup', line: 30 },
      { kind: 'symbol', title: 'dup', line: undefined },
      { kind: 'line', title: 'dup', line: 10 },
      { kind: 'symbol', title: 'dup', line: 10 },
      { kind: 'symbol', title: 'dup', line: 2 },
    ];
    assert.deepStrictEqual(
      [...items].sort(compareByTitle).map((i) => `${i.kind}:${i.line ?? 'none'}`),
      ['symbol:2', 'symbol:10', 'line:10', 'line:30', 'symbol:none'],
    );
  });
});
