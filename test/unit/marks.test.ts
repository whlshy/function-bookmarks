import * as assert from 'assert';
import {
  addBookmark,
  dedupeStoreNumbers,
  emptyStore,
  favorites,
  findMark,
  hasStoreData,
  MarkKey,
  mergeStoreData,
  parseStore,
  renamePath,
  serializeStore,
  setAlias,
  setFavorite,
  setNote,
  setSymbolExtras,
  setTagColor,
  updateLine,
} from '../../src/storage/marks';

const key: MarkKey = { file: 'app/views.py', path: 'ArticleView.get', kind: 'method' };
const now = new Date('2026-11-19T00:00:00Z');

describe('收藏與自訂名稱資料', () => {
  it('加入、取消收藏；取消後沒有其他標記就移除', () => {
    let d = setFavorite(emptyStore(), key, true, 11, now);
    assert.deepStrictEqual(findMark(d, key), { ...key, favorite: true, addedAt: now.toISOString(), line: 11 });
    d = setFavorite(d, key, false);
    assert.strictEqual(d.symbols.length, 0);
  });

  it('自訂名稱：空白或與原名相同視為清除', () => {
    let d = setAlias(emptyStore(), key, '  文章頁 GET ', 'get');
    assert.strictEqual(findMark(d, key)?.alias, '文章頁 GET');
    d = setAlias(d, key, 'get', 'get');
    assert.strictEqual(findMark(d, key), undefined);
    d = setAlias(setAlias(d, key, 'x', 'get'), key, '', 'get');
    assert.strictEqual(findMark(d, key), undefined);
  });

  it('收藏與自訂名稱可同時存在，取消其中一個不影響另一個', () => {
    let d = setAlias(setFavorite(emptyStore(), key, true, 1, now), key, '文章', 'get');
    d = setFavorite(d, key, false);
    assert.deepStrictEqual(findMark(d, key), { ...key, alias: '文章', line: 1 });
  });

  it('備註：保留多行與內部縮排，去掉頭尾空行；清空即移除', () => {
    let d = setNote(emptyStore(), key, '\r\n\n第一行\r\n  - 縮排項目\n\n', 11);
    assert.strictEqual(findMark(d, key)?.note, '第一行\n  - 縮排項目');
    assert.strictEqual(findMark(d, key)?.line, 11);
    d = setNote(d, key, '   \n  ');
    assert.strictEqual(findMark(d, key), undefined);
  });

  it('備註可與收藏、自訂名稱並存，並能存檔再讀回', () => {
    let d = setFavorite(emptyStore(), key, true, 1, now);
    d = setNote(setAlias(d, key, '文章', 'get'), key, 'a\nb');
    const back = parseStore(serializeStore(d));
    assert.deepStrictEqual(findMark(back!, key), { ...key, favorite: true, alias: '文章', note: 'a\nb', line: 1, addedAt: now.toISOString() });
    assert.strictEqual(findMark(setFavorite(d, key, false), key)?.note, 'a\nb');
  });

  it('同名但種類不同視為不同項目', () => {
    const d = setFavorite(setFavorite(emptyStore(), key, true), { ...key, kind: 'function' }, true);
    assert.strictEqual(favorites(d).length, 2);
  });

  it('updateLine：沒有變化時回傳同一個物件', () => {
    const d = setFavorite(emptyStore(), key, true, 5);
    assert.strictEqual(updateLine(d, key, 5), d);
    assert.strictEqual(findMark(updateLine(d, key, 9), key)?.line, 9);
    assert.strictEqual(updateLine(d, { ...key, path: 'nope' }, 1), d);
  });

  it('檔案與資料夾改名', () => {
    let d = setFavorite(emptyStore(), key, true);
    d = setFavorite(d, { file: 'app/templates/a.html', path: 'content', kind: 'block' }, true);
    d = setFavorite(d, { file: 'application/x.py', path: 'f', kind: 'function' }, true);
    const r = renamePath(d, 'app', 'core');
    assert.deepStrictEqual(r.symbols.map((m) => m.file).sort(), ['application/x.py', 'core/templates/a.html', 'core/views.py']);
    assert.strictEqual(renamePath(d, 'nope', 'x'), d);
  });

  it('序列化後排序穩定，可再解析回來', () => {
    let d = setFavorite(emptyStore(), { file: 'b.py', path: 'z', kind: 'function' }, true, 1, now);
    d = setFavorite(d, { file: 'a.py', path: 'y', kind: 'function' }, true, 2, now);
    const text = serializeStore(d);
    assert.ok(text.indexOf('a.py') < text.indexOf('b.py'));
    assert.deepStrictEqual(parseStore(text)?.symbols.length, 2);
    assert.strictEqual(serializeStore(parseStore(text)!), text);
  });

  it('解析時略過格式錯誤的項目；JSON 壞掉回傳 undefined', () => {
    const d = parseStore(
      JSON.stringify({
        version: 1,
        symbols: [{ file: 'a.py', path: 'f', kind: 'function', favorite: true }, { file: 1 }, { file: 'a.py', path: 'g', kind: 'weird', favorite: true }, null],
      }),
    );
    assert.strictEqual(d?.symbols.length, 1);
    assert.strictEqual(parseStore('{oops'), undefined);
    assert.deepStrictEqual(parseStore('{}'), emptyStore());
  });

  it('mergeStoreData：合併書籤並以 target 為主，衝突號碼清掉來源端', () => {
    assert.strictEqual(hasStoreData(emptyStore()), false);
    let target = setFavorite(emptyStore(), key, true, 1, now);
    target = setSymbolExtras(target, key, { number: 1 });
    target = addBookmark(target, { id: 'b1', file: 'app/views.py', line: 5, label: 'target行', number: 2 });
    target = setTagColor(target, 'todo', 'blue');

    let source = setFavorite(emptyStore(), key, true, 9, now);
    source = setAlias(source, key, 'source別名', 'get');
    const key2: MarkKey = { file: 'app/views.py', path: 'index', kind: 'function' };
    source = setSymbolExtras(setFavorite(source, key2, true, 0, now), key2, { number: 1 }); // 與 target 1 號衝突
    source = addBookmark(source, { id: 'b2', file: 'app/views.py', line: 5, label: '同位置不重複' });
    source = addBookmark(source, { id: 'b3', file: 'app/views.py', line: 10, label: 'source行', number: 3 });
    source = setTagColor(setTagColor(source, 'todo', 'red'), 'auth', 'green');

    const merged = mergeStoreData(target, source);
    assert.strictEqual(hasStoreData(merged), true);
    assert.strictEqual(findMark(merged, key)?.alias, undefined, '已存在的函式標記以 target 為主');
    assert.strictEqual(findMark(merged, key)?.number, 1);
    assert.strictEqual(findMark(merged, key2)?.favorite, true, '補進 target 沒有的函式書籤');
    assert.strictEqual(findMark(merged, key2)?.number, undefined, '衝突號碼清掉來源端');
    assert.deepStrictEqual(merged.bookmarks.map((b) => b.id), ['b1', 'b3'], '同檔同行不重複、不同行補進');
    assert.strictEqual(merged.bookmarks.find((b) => b.id === 'b3')?.number, 3, '不衝突的號碼保留');
    assert.deepStrictEqual(merged.tagColors, { todo: 'blue', auth: 'green' });
  });

  it('dedupeStoreNumbers 與 mergeStoreData：去除內部重複與跨資料夾衝突號碼（CR-11）', () => {
    const key2: MarkKey = { file: 'app/views.py', path: 'index', kind: 'function' };
    let data = setSymbolExtras(setFavorite(emptyStore(), key, true, 1, now), key, { number: 1 });
    data = setSymbolExtras(setFavorite(data, key2, true, 0, now), key2, { number: 2 });
    data = addBookmark(data, { id: 'b1', file: 'app/views.py', line: 5, number: 1 }); // 內部與 key 重複
    data = addBookmark(data, { id: 'b2', file: 'app/views.py', line: 8, number: 3 }); // 與跨資料夾衝突
    data = addBookmark(data, { id: 'b3', file: 'app/views.py', line: 10, number: 4 }); // 不衝突

    const deduped = dedupeStoreNumbers(data, [3]);
    assert.strictEqual(findMark(deduped, key)?.number, 1);
    assert.strictEqual(findMark(deduped, key2)?.number, 2);
    assert.strictEqual(deduped.bookmarks.find((b) => b.id === 'b1')?.number, undefined, '檔案內部重複的 1 號應清掉');
    assert.strictEqual(deduped.bookmarks.find((b) => b.id === 'b2')?.number, undefined, '與其他資料夾衝突的 3 號應清掉');
    assert.strictEqual(deduped.bookmarks.find((b) => b.id === 'b3')?.number, 4, '不衝突的 4 號保留');

    const merged = mergeStoreData(emptyStore(), data, [1, 3]);
    assert.strictEqual(findMark(merged, key)?.number, undefined, 'merge 避開其他資料夾已佔用的 1 號');
    assert.strictEqual(findMark(merged, key2)?.number, 2);
    assert.strictEqual(merged.bookmarks.find((b) => b.id === 'b2')?.number, undefined, 'merge 避開其他資料夾已佔用的 3 號');
    assert.strictEqual(merged.bookmarks.find((b) => b.id === 'b3')?.number, 4);
  });
});
