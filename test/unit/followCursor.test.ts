import * as assert from 'assert';
import { findEnclosing } from '../../src/detection/engine';
import { DetectedSymbol, SymbolKindName } from '../../src/detection/types';
import { chooseCursorBookmarkTarget, chooseFollowSection } from '../../src/util/followCursor';

function sym(
  name: string,
  path: string,
  startLine: number,
  endLine: number,
  opts: { kind?: SymbolKindName; children?: DetectedSymbol[] } = {},
): DetectedSymbol {
  return {
    name,
    kind: opts.kind ?? 'function',
    ruleId: 'test',
    startLine,
    endLine,
    nameLine: startLine,
    nameStartCol: 0,
    nameEndCol: name.length,
    startOffset: 0,
    endOffset: 0,
    path,
    children: opts.children ?? [],
  };
}

describe('followCursor 純函式判斷', () => {
  describe('findEnclosing', () => {
    const inner = sym('helper', 'Outer.run.helper', 12, 15);
    const method = sym('run', 'Outer.run', 10, 20, { kind: 'method', children: [inner] });
    const cls = sym('Outer', 'Outer', 8, 25, { kind: 'class', children: [method] });
    const top = sym('index', 'index', 0, 5);
    const tree = [top, cls];

    it('依最內層往外層回傳包住該行的所有符號', () => {
      assert.deepStrictEqual(findEnclosing(tree, 13).map((s) => s.path), ['Outer.run.helper', 'Outer.run', 'Outer']);
      assert.deepStrictEqual(findEnclosing(tree, 18).map((s) => s.path), ['Outer.run', 'Outer']);
      assert.deepStrictEqual(findEnclosing(tree, 9).map((s) => s.path), ['Outer']);
      assert.deepStrictEqual(findEnclosing(tree, 0).map((s) => s.path), ['index']);
      assert.deepStrictEqual(findEnclosing(tree, 5).map((s) => s.path), ['index']);
    });

    it('不在任何符號內時回傳空陣列', () => {
      assert.deepStrictEqual(findEnclosing(tree, 6), []);
      assert.deepStrictEqual(findEnclosing(tree, 30), []);
    });
  });

  describe('chooseFollowSection', () => {
    it('顯示全部且目前檔案未收合時跟隨「目前檔案」', () => {
      assert.strictEqual(chooseFollowSection('all', undefined), 'currentFile');
      assert.strictEqual(chooseFollowSection('all', true), 'currentFile');
    });

    it('目前檔案被使用者收合，或只顯示書籤時，改跟隨「書籤」', () => {
      assert.strictEqual(chooseFollowSection('all', false), 'bookmarks');
      assert.strictEqual(chooseFollowSection('bookmarks', undefined), 'bookmarks');
      assert.strictEqual(chooseFollowSection('bookmarks', true), 'bookmarks');
      assert.strictEqual(chooseFollowSection('bookmarks', false), 'bookmarks');
    });
  });

  describe('chooseCursorBookmarkTarget', () => {
    const inner = sym('helper', 'Outer.run.helper', 12, 15);
    const method = sym('run', 'Outer.run', 10, 20, { kind: 'method', children: [inner] });
    const cls = sym('Outer', 'Outer', 8, 25, { kind: 'class', children: [method] });
    const ref = sym('base.html', 'base.html', 2, 2, { kind: 'reference' });
    const top = sym('index', 'index', 0, 5, { children: [ref] });
    const tree = [top, cls];

    it('游標這一行有可見行號書籤時優先選它（即使外層函式也有函式書籤）', () => {
      const target = chooseCursorBookmarkTarget({
        lineBookmarkId: 'bm-1',
        symbols: tree,
        line: 13,
        favoritesShown: true,
        isFavorite: () => true,
      });
      assert.deepStrictEqual(target, { kind: 'line', id: 'bm-1' });
    });

    it('沒有行號書籤時，選最內層有函式書籤的符號', () => {
      const favs = new Set(['Outer', 'Outer.run']);
      const target = chooseCursorBookmarkTarget({
        lineBookmarkId: undefined,
        symbols: tree,
        line: 13,
        favoritesShown: true,
        isFavorite: (s) => favs.has(s.path),
      });
      assert.deepStrictEqual(target, { kind: 'symbol', symbol: method });
    });

    it('最內層沒有函式書籤時往外層找到第一個有函式書籤的符號', () => {
      const favs = new Set(['Outer']);
      const target = chooseCursorBookmarkTarget({
        lineBookmarkId: undefined,
        symbols: tree,
        line: 13,
        favoritesShown: true,
        isFavorite: (s) => favs.has(s.path),
      });
      assert.deepStrictEqual(target, { kind: 'symbol', symbol: cls });
    });

    it('略過 kind 為 reference 的符號，繼續往外層找', () => {
      const favs = new Set(['base.html', 'index']);
      const target = chooseCursorBookmarkTarget({
        lineBookmarkId: undefined,
        symbols: tree,
        line: 2,
        favoritesShown: true,
        isFavorite: (s) => favs.has(s.path),
      });
      assert.deepStrictEqual(target, { kind: 'symbol', symbol: top });
    });

    it('游標在沒有外層函式書籤的函式內且該行沒有行號書籤時回傳 undefined（情況 3）', () => {
      const favs = new Set(['index']);
      const target = chooseCursorBookmarkTarget({
        lineBookmarkId: undefined,
        symbols: tree,
        line: 13,
        favoritesShown: true,
        isFavorite: (s) => favs.has(s.path),
      });
      assert.strictEqual(target, undefined);
    });

    it('函式書籤被來源篩選隱藏時不回傳函式書籤，但仍可回傳可見行號書籤', () => {
      assert.strictEqual(
        chooseCursorBookmarkTarget({
          lineBookmarkId: undefined,
          symbols: tree,
          line: 13,
          favoritesShown: false,
          isFavorite: () => true,
        }),
        undefined,
      );
      assert.deepStrictEqual(
        chooseCursorBookmarkTarget({
          lineBookmarkId: 'foreign-1',
          symbols: tree,
          line: 13,
          favoritesShown: false,
          isFavorite: () => true,
        }),
        { kind: 'line', id: 'foreign-1' },
      );
    });
  });
});
