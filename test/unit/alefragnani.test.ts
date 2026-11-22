import * as assert from 'assert';
import { parseAlefragnani } from '../../src/bookmarks/alefragnani';

describe('讀取 alefragnani Bookmarks 的 bookmarks.json', () => {
  it('目前版本：{ files: [...] }，空白名稱不保留', () => {
    const json = {
      files: [
        { path: 'src/a.ts', bookmarks: [{ line: 3, column: 2, label: '' }, { line: 10, column: 0, label: ' 登入 ' }] },
        { path: 'b.py', bookmarks: [{ line: 0, column: 0, label: 'x' }] },
      ],
    };
    assert.deepStrictEqual(parseAlefragnani(json), [
      { file: 'src/a.ts', line: 3 },
      { file: 'src/a.ts', line: 10, label: '登入' },
      { file: 'b.py', line: 0, label: 'x' },
    ]);
  });

  it('舊版：最上層是陣列；更舊版：bookmarks 欄位、$ROOTPATH$、反斜線、純數字行號', () => {
    assert.deepStrictEqual(parseAlefragnani([{ path: 'a.ts', bookmarks: [{ line: 1 }] }]), [{ file: 'a.ts', line: 1 }]);
    assert.deepStrictEqual(
      parseAlefragnani({
        bookmarks: [
          { path: '$ROOTPATH$\\src\\x.ts', bookmarks: [{ line: 5, label: 'l' }] },
          { fsPath: '$ROOTPATH$/y.ts', bookmarks: [41, 112] },
        ],
      }),
      [
        { file: 'src/x.ts', line: 5, label: 'l' },
        { file: 'y.ts', line: 41 },
        { file: 'y.ts', line: 112 },
      ],
    );
  });

  it('略過工作區外、未命名、絕對路徑、無效行號與重複', () => {
    const json = {
      files: [
        { path: '../other/a.ts', bookmarks: [{ line: 1 }] },
        { path: 'Untitled-1', bookmarks: [{ line: 1 }] },
        { path: 'C:/abs/a.ts', bookmarks: [{ line: 1 }] },
        { path: 'ok.ts', bookmarks: [{ line: -1 }, { line: 1.5 }, { line: 'x' }, { line: 2 }, { line: 2 }, null] },
      ],
    };
    assert.deepStrictEqual(parseAlefragnani(json), [{ file: 'ok.ts', line: 2 }]);
  });

  it('格式不符回傳空陣列', () => {
    assert.deepStrictEqual(parseAlefragnani(null), []);
    assert.deepStrictEqual(parseAlefragnani({ foo: 1 }), []);
    assert.deepStrictEqual(parseAlefragnani('x'), []);
  });
});
