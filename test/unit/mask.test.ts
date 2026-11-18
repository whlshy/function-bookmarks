import * as assert from 'assert';
import { maskText } from '../../src/detection/mask';

describe('maskText', () => {
  it('長度與換行位置不變', () => {
    const src = 'a // x\n"y"\n/* z\n */ b';
    for (const syntax of ['c', 'python', 'template'] as const) {
      const out = maskText(src, syntax);
      assert.strictEqual(out.length, src.length);
      assert.deepStrictEqual([...out].map((c, i) => (c === '\n') === (src[i] === '\n')).every(Boolean), true);
    }
  });

  it('C 系：遮蔽單行、多行註解與字串', () => {
    const out = maskText('f() // function a() {}\n/* {\n} */ "x{" \'y}\'', 'c');
    assert.ok(!out.includes('function'));
    assert.strictEqual((out.match(/[{}]/g) ?? []).length, 0);
  });

  it('C 系：樣板字串內的 ${} 仍視為程式碼', () => {
    const out = maskText('`a {b} ${ {c: 1} } d`', 'c');
    assert.ok(!out.includes('b'));
    assert.ok(out.includes('{c: 1}'));
    assert.ok(!out.includes('d'));
  });

  it('C 系：正規表示式字面值內的大括號被遮蔽', () => {
    const out = maskText('const r = /\\{[a-z}]+/g; const n = a / b / c;', 'c');
    assert.strictEqual((out.match(/[{}]/g) ?? []).length, 0);
    assert.ok(out.includes('a / b / c'));
  });

  it('Python：遮蔽 # 註解與三引號字串', () => {
    const out = maskText('x = 1  # def a():\n"""\ndef b():\n"""\ndef c(): pass', 'python');
    assert.ok(!out.includes('def a'));
    assert.ok(!out.includes('def b'));
    assert.ok(out.includes('def c'));
  });

  it('Template：遮蔽 {# #}、{% comment %} 與 HTML 註解，但保留字串', () => {
    const src = '{# {% block a %} #}{% comment %}{% block b %}{% endcomment %}<!-- {% block c %} -->{% include "x.html" %}';
    const out = maskText(src, 'template');
    assert.ok(!out.includes('block'));
    assert.ok(out.includes('"x.html"'));
  });
});
