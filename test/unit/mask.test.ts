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

  it('Python：三引號字串內的跳脫引號不會提早結束遮罩，連續反斜線後的結尾正常結束（CR-13）', () => {
    const src = [
      's = """foo \\"\\"\\" def fake(): pass"""',
      'def real_a(): pass',
      'r = r"""raw \\"\\"\\" def fake_raw(): pass"""',
      't = """tail \\\\"""',
      'def real_b(): pass',
    ].join('\n');
    const out = maskText(src, 'python');
    assert.strictEqual(out.length, src.length);
    assert.ok(!out.includes('fake'), '跳脫三引號後的假函式必須被遮掉');
    assert.ok(out.includes('def real_a'), '正常結尾後的真函式應保留');
    assert.ok(out.includes('def real_b'), '雙反斜線後接三引號應正常結束字串');
  });

  it('Java／Kotlin／C#：三引號文字區塊依語言規則處理跳脫與多重引號（CR-13）', () => {
    // Java：支援 \""" 跳脫與 \\""" 正常結尾
    const javaSrc = 'String a = """\nhello \\""" void fake() {}\n""";\nvoid realA() {}\nString b = """tail \\\\""";\nvoid realB() {}';
    const javaOut = maskText(javaSrc, 'java');
    assert.ok(!javaOut.includes('fake'), 'Java text block 內 \\""" 不應提早結束');
    assert.ok(javaOut.includes('void realA'), 'Java text block 結尾後應保留');
    assert.ok(javaOut.includes('void realB'), 'Java \\\\""" 應正常結束');

    // Kotlin：raw string 不跳脫反斜線，"""foo\""" 會正常在結尾 """ 結束
    const ktSrc = 'val a = """foo\\"""\nfun realKt() {}';
    const ktOut = maskText(ktSrc, 'kotlin');
    assert.ok(ktOut.includes('fun realKt'), 'Kotlin raw string 不把 \\" 當跳脫');

    // C#：4 個雙引號的 raw string 內含 3 個雙引號不提早結束
    const csSrc = 'var s = """"\n""" void fakeCs() {}\n"""";\nvoid realCs() {}';
    const csOut = maskText(csSrc, 'csharp');
    assert.ok(!csOut.includes('fakeCs'), 'C# 4 引號 raw string 內的 """ 不應提早結束');
    assert.ok(csOut.includes('void realCs'), 'C# 4 引號結尾後的真函式應保留');
  });
});
