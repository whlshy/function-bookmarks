import * as assert from 'assert';
import { circled, effectiveColor, gutterSvg, LOST_HEX, nextFreeNumber, paletteColor, PALETTE, svgDataUri } from '../../src/bookmarks/decor';
import { LineBookmark } from '../../src/bookmarks/model';
import {
  clearNumber,
  emptyStore,
  findMark,
  MarkKey,
  parseStore,
  serializeStore,
  setFavorite,
  setSymbolExtras,
  setTagColor,
} from '../../src/storage/marks';

const key: MarkKey = { file: 'app/views.py', path: 'ArticleView.get', kind: 'method' };

describe('M7：書籤外觀（顏色、號碼、圖示）', () => {
  it('實際顏色：書籤自己的 → 第一個有顏色的標籤 → 別人的為紫色 → 預設', () => {
    const tags = new Map([
      ['todo', 'red'],
      ['auth', 'blue'],
    ]);
    assert.strictEqual(effectiveColor({ color: 'green', tags: ['todo'] }, tags), 'green');
    assert.strictEqual(effectiveColor({ tags: ['x', 'auth', 'todo'] }, tags), 'blue');
    assert.strictEqual(effectiveColor({ tags: ['x'], source: { author: 'alex' } }, tags), 'purple');
    assert.strictEqual(effectiveColor({ tags: ['x'] }, tags), undefined);
    // 不認得的顏色 id 當成沒設定
    assert.strictEqual(effectiveColor({ color: 'nope', tags: ['todo'] }, { todo: 'red' }), 'red');
  });

  it('號碼：①～⑨、下一個空號', () => {
    assert.strictEqual(circled(1), '①');
    assert.strictEqual(circled(9), '⑨');
    assert.strictEqual(circled(undefined), '');
    assert.strictEqual(circled(10), '');
    assert.strictEqual(nextFreeNumber([1, 2, 4]), 3);
    assert.strictEqual(nextFreeNumber([]), 1);
    assert.strictEqual(nextFreeNumber([1, 2, 3, 4, 5, 6, 7, 8, 9]), undefined);
  });

  it('行號旁圖示：顏色、函式書籤的星星、號碼；淺色底用深色字', () => {
    const red = paletteColor('red')!.hex;
    const plain = gutterSvg('bookmark', red);
    assert.ok(plain.includes(`fill="${red}"`));
    assert.ok(!plain.includes('<text'));
    assert.ok(gutterSvg('favorite', red).includes('fill="#FFFFFF"'), '函式書籤有白色星星');
    const numbered = gutterSvg('favorite', red, 3);
    assert.ok(numbered.includes('>3</text>'), '有號碼時顯示號碼');
    assert.ok(gutterSvg('bookmark', paletteColor('yellow')!.hex, 1).includes('fill="#1F2328"'), '黃色底用深色字');
    const uri = svgDataUri(plain);
    assert.ok(uri.startsWith('data:image/svg+xml;base64,'));
    assert.strictEqual(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'), plain);
    assert.strictEqual(new Set(PALETTE.map((c) => c.id)).size, PALETTE.length);
  });

  it('行號旁圖示：需確認（lost）固定灰色與問號，有號碼時也顯示問號', () => {
    const red = paletteColor('red')!.hex;
    const yellow = paletteColor('yellow')!.hex;
    const lost = gutterSvg('lost', red);
    assert.ok(lost.includes(`fill="${LOST_HEX}"`), '固定填灰色');
    assert.ok(!lost.includes(`fill="${red}"`), '不受書籤或標籤顏色影響');
    assert.ok(lost.includes('fill="#FFFFFF">?</text>'), '顯示白色問號');

    const lostNumbered = gutterSvg('lost', yellow, 3);
    assert.ok(lostNumbered.includes(`fill="${LOST_HEX}"`), '淺色書籤的需確認圖示也是灰色');
    assert.ok(lostNumbered.includes('fill="#FFFFFF">?</text>'), '有號碼的需確認書籤仍顯示問號');
    assert.ok(!lostNumbered.includes('>3</text>'), '有號碼時不顯示號碼');
  });

  it('號碼、顏色、標籤顏色會存檔與讀回；不合法的值略過', () => {
    let d = setFavorite(emptyStore(), key, true, 3);
    d = setSymbolExtras(d, key, { number: 2, color: 'orange' });
    const bm: LineBookmark = { id: 'a', file: 'x.py', line: 1, number: 5, color: 'blue' };
    d = { ...d, bookmarks: [bm] };
    d = setTagColor(d, 'todo', 'red');
    const back = parseStore(serializeStore(d))!;
    assert.strictEqual(findMark(back, key)?.number, 2);
    assert.strictEqual(findMark(back, key)?.color, 'orange');
    assert.strictEqual(back.bookmarks[0].number, 5);
    assert.strictEqual(back.bookmarks[0].color, 'blue');
    assert.deepStrictEqual(back.tagColors, { todo: 'red' });
    const bad = parseStore(
      JSON.stringify({ version: 1, symbols: [], bookmarks: [{ id: 'b', file: 'x', line: 0, number: 12 }, { id: 'c', file: 'x', line: 1, number: 1.5 }], tagColors: { t: 3 } }),
    )!;
    assert.strictEqual(bad.bookmarks[0].number, undefined);
    assert.strictEqual(bad.bookmarks[1].number, undefined);
    assert.strictEqual(bad.tagColors, undefined);
  });

  it('同一個號碼只留一個；取消函式書籤時號碼與顏色一併拿掉', () => {
    let d = setSymbolExtras(setFavorite(emptyStore(), key, true), key, { number: 1 });
    d = { ...d, bookmarks: [{ id: 'a', file: 'x', line: 0, number: 1 }, { id: 'b', file: 'x', line: 1, number: 2 }] };
    const kept = clearNumber(d, 1, { bookmarkId: 'a' });
    assert.strictEqual(findMark(kept, key)?.number, undefined);
    assert.strictEqual(kept.bookmarks[0].number, 1);
    assert.strictEqual(kept.bookmarks[1].number, 2);
    const fnKept = clearNumber(d, 1, { key });
    assert.strictEqual(findMark(fnKept, key)?.number, 1);
    assert.strictEqual(fnKept.bookmarks[0].number, undefined);
    assert.strictEqual(clearNumber(d, 7), d, '沒有變化時回傳原物件');
    const off = setFavorite(setSymbolExtras(d, key, { color: 'red' }), key, false);
    assert.strictEqual(findMark(off, key), undefined);
  });

  it('標籤顏色：設定、清除，沒有變化時回傳原物件', () => {
    const d = setTagColor(emptyStore(), 'todo', 'red');
    assert.deepStrictEqual(d.tagColors, { todo: 'red' });
    assert.strictEqual(setTagColor(d, 'todo', 'red'), d);
    const cleared = setTagColor(d, 'todo', undefined);
    assert.strictEqual(cleared.tagColors, undefined);
    assert.ok(!serializeStore(cleared).includes('tagColors'));
  });
});
