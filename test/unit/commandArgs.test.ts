import * as assert from 'assert';
import {
  bookmarkNumberArg,
  booleanArg,
  nullableStringArg,
  oneOf,
  plainOptions,
  stringArg,
  stringArrayArg,
} from '../../src/util/commandArgs';

interface Opts {
  text?: string;
  confirmed?: boolean;
  uri?: unknown;
}
const KEYS = ['text', 'confirmed', 'uri'] as const;

describe('指令參數防呆：選單附帶的樹節點與額外物件不當成選項或輸入值', () => {
  it('只含允許欄位的一般物件照常接受（含空物件、無原型物件）', () => {
    const o = { text: '{}', confirmed: true };
    assert.strictEqual(plainOptions<Opts>(o, KEYS), o);
    assert.deepStrictEqual(plainOptions<Opts>({}, KEYS), {});
    const bare = Object.assign(Object.create(null) as object, { text: 'x' });
    assert.strictEqual(plainOptions<Opts>(bare, KEYS), bare);
  });

  it('樹節點（含 type 等其他欄位，即使也有 uri）一律拒絕', () => {
    const fileGroup = { type: 'bmGroup', by: 'file', key: 'app/views.py', rel: 'app/views.py', uri: { fsPath: '/w/app/views.py' }, items: [] };
    assert.strictEqual(plainOptions<Opts>(fileGroup, KEYS), undefined);
    const bookmark = { type: 'bookmark', entry: { bookmark: { line: 1 } } };
    assert.strictEqual(plainOptions<Opts>(bookmark, KEYS), undefined);
  });

  it('陣列（選取清單）、類別實例、字串、數字、null、undefined 都拒絕', () => {
    class Node {
      text = 'x';
    }
    for (const v of [[{ text: 'x' }], new Node(), 'text', 1, null, undefined]) {
      assert.strictEqual(plainOptions<Opts>(v, KEYS), undefined, String(v));
    }
  });

  it('oneOf 只接受允許的字串', () => {
    const allowed = ['file', 'workspaceState', 'setting'] as const;
    assert.strictEqual(oneOf('file', allowed), 'file');
    assert.strictEqual(oneOf('setting', allowed), 'setting');
    for (const v of ['other', '', { type: 'bmGroup' }, ['file'], undefined, null, 1]) {
      assert.strictEqual(oneOf(v, allowed), undefined, String(v));
    }
  });

  it('bookmarkNumberArg 只接受 1～9 整數、"next" 或 null；行號右鍵的 { preserveFocus: false } 等一律回傳 undefined', () => {
    for (let n = 1; n <= 9; n++) {
      assert.strictEqual(bookmarkNumberArg(n), n);
    }
    assert.strictEqual(bookmarkNumberArg('next'), 'next');
    assert.strictEqual(bookmarkNumberArg(null), null);

    const lineNumberExtra = { preserveFocus: false };
    const selectedItems = [{ type: 'bookmark' }];
    for (const bad of [lineNumberExtra, selectedItems, 0, 10, -1, 1.5, NaN, Infinity, '1', '', true, false, undefined]) {
      assert.strictEqual(bookmarkNumberArg(bad), undefined, String(bad));
    }
  });

  it('nullableStringArg 只接受字串或 null；stringArg 只接受字串', () => {
    assert.strictEqual(nullableStringArg('red'), 'red');
    assert.strictEqual(nullableStringArg(''), '');
    assert.strictEqual(nullableStringArg(null), null);
    assert.strictEqual(stringArg('新名稱'), '新名稱');
    assert.strictEqual(stringArg(''), '');
    assert.strictEqual(stringArg(null), undefined);

    const lineNumberExtra = { preserveFocus: false };
    const selectedItems = [{ type: 'bmGroup', by: 'tag', key: 'auth' }];
    for (const bad of [lineNumberExtra, selectedItems, 123, true, false, undefined]) {
      assert.strictEqual(nullableStringArg(bad), undefined, String(bad));
      assert.strictEqual(stringArg(bad), undefined, String(bad));
    }
  });

  it('booleanArg 與 stringArrayArg 過濾非預期型別', () => {
    assert.strictEqual(booleanArg(true), true);
    assert.strictEqual(booleanArg(false), false);
    for (const bad of [{ preserveFocus: false }, [], 'true', 1, 0, null, undefined]) {
      assert.strictEqual(booleanArg(bad), undefined, String(bad));
    }

    assert.deepStrictEqual(stringArrayArg(['main', 'feat']), ['main', 'feat']);
    assert.deepStrictEqual(stringArrayArg([]), []);
    for (const bad of [{ preserveFocus: false }, [{ type: 'bookmark' }], ['ok', 1], 'main', null, undefined]) {
      assert.strictEqual(stringArrayArg(bad), undefined, String(bad));
    }
  });
});
