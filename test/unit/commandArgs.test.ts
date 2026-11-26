import * as assert from 'assert';
import { oneOf, plainOptions } from '../../src/util/commandArgs';

interface Opts {
  text?: string;
  confirmed?: boolean;
  uri?: unknown;
}
const KEYS = ['text', 'confirmed', 'uri'] as const;

describe('指令參數防呆：側邊欄標題列（…）傳入的樹節點不當成選項', () => {
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
});
