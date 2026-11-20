import * as assert from 'assert';
import { emptyStore, findMark, setAlias, setFavorite, setNote, setTags, StoreData } from '../../src/storage/marks';
import { reconcileFile } from '../../src/storage/reconcile';
import { detect, lines } from './helpers';

const now = new Date('2026-11-20T00:00:00Z');
const F = 'app/views.py';

function marked(): StoreData {
  let d = setFavorite(emptyStore(), { file: F, path: 'ArticleView.get', kind: 'method' }, true, 1, now);
  d = setTags(d, { file: F, path: 'ArticleView.get', kind: 'method' }, ['api']);
  d = setAlias(d, { file: F, path: 'ArticleView.get', kind: 'method' }, '文章頁', 'get', 1);
  d = setNote(d, { file: F, path: 'ArticleView.get', kind: 'method' }, '說明', 1);
  return d;
}

const original = lines('class ArticleView:', '    def get(self):', '        pass', '    def post(self):', '        pass');

describe('函式改名後轉移書籤（reconcileFile）', () => {
  it('名稱沒變：只更新最後已知行號；沒有變化時回傳原物件', () => {
    const d = marked();
    assert.strictEqual(reconcileFile(d, F, detect(original, 'python').symbols), d);
    const moved = reconcileFile(d, F, detect(`\n\n${original}`, 'python').symbols);
    assert.strictEqual(findMark(moved, { file: F, path: 'ArticleView.get', kind: 'method' })?.line, 3);
  });

  it('同一行的函式改名：書籤、自訂名稱、備註、標籤全部轉到新名稱', () => {
    const renamed = original.replace('def get(', 'def get_list(');
    const d = reconcileFile(marked(), F, detect(renamed, 'python').symbols);
    assert.strictEqual(findMark(d, { file: F, path: 'ArticleView.get', kind: 'method' }), undefined);
    const m = findMark(d, { file: F, path: 'ArticleView.get_list', kind: 'method' });
    assert.deepStrictEqual(
      { favorite: m?.favorite, alias: m?.alias, note: m?.note, tags: m?.tags, line: m?.line, addedAt: m?.addedAt },
      { favorite: true, alias: '文章頁', note: '說明', tags: ['api'], line: 1, addedAt: now.toISOString() },
    );
  });

  it('類別改名：方法的路徑跟著變，依行號各自找回', () => {
    const renamed = original.replace('class ArticleView', 'class Article');
    const d = reconcileFile(marked(), F, detect(renamed, 'python').symbols);
    assert.ok(findMark(d, { file: F, path: 'Article.get', kind: 'method' })?.favorite);
  });

  it('改名同時位移 3 行內也找得回來；超過就不猜', () => {
    const near = reconcileFile(marked(), F, detect(`\n\n${original.replace('def get(', 'def fetch(')}`, 'python').symbols);
    assert.ok(findMark(near, { file: F, path: 'ArticleView.fetch', kind: 'method' }));
    const far = reconcileFile(marked(), F, detect(`\n\n\n\n\n${original.replace('def get(', 'def fetch(')}`, 'python').symbols);
    assert.ok(findMark(far, { file: F, path: 'ArticleView.get', kind: 'method' }), '維持原樣，顯示找不到函式');
  });

  it('不會搶走已經有標記的函式；附近有多個候選時不猜', () => {
    let d = marked();
    d = setFavorite(d, { file: F, path: 'ArticleView.post', kind: 'method' }, true, 3, now);
    // get 被刪掉：附近只剩 post，但 post 已經有自己的書籤
    const deleted = lines('class ArticleView:', '    def post(self):', '        pass');
    const r = reconcileFile(d, F, detect(deleted, 'python').symbols);
    assert.ok(findMark(r, { file: F, path: 'ArticleView.get', kind: 'method' }), 'get 的書籤留著，顯示找不到');
    assert.strictEqual(findMark(r, { file: F, path: 'ArticleView.post', kind: 'method' })?.alias, undefined);

    // 原本那一行沒有符號，上下 3 行內有兩個新函式：不猜
    const two = lines('class ArticleView:', '    x = 1', '    def a(self):', '        pass', '    def b(self):', '        pass');
    const r2 = reconcileFile(marked(), F, detect(two, 'python').symbols);
    assert.ok(findMark(r2, { file: F, path: 'ArticleView.get', kind: 'method' }));
  });

  it('種類不同不轉移（例如函式變成類別）', () => {
    const r = reconcileFile(marked(), F, detect(lines('class ArticleView:', '    class get_list:', '        pass'), 'python').symbols);
    assert.ok(findMark(r, { file: F, path: 'ArticleView.get', kind: 'method' }));
  });

  it('其他檔案的標記不受影響', () => {
    const d = setFavorite(marked(), { file: 'other.py', path: 'f', kind: 'function' }, true, 0, now);
    const r = reconcileFile(d, F, detect(original.replace('def get(', 'def g('), 'python').symbols);
    assert.ok(findMark(r, { file: 'other.py', path: 'f', kind: 'function' }));
  });
});
