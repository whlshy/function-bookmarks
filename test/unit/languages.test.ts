import * as assert from 'assert';
import { maskText, syntaxForLanguage } from '../../src/detection/mask';
import { detect, lines, outline } from './helpers';
import {
  C_SAMPLE,
  CPP_SAMPLE,
  CSHARP_SAMPLE,
  GO_SAMPLE,
  JAVA_SAMPLE,
  KOTLIN_SAMPLE,
  PHP_SAMPLE,
  RUBY_SAMPLE,
  REACT_SAMPLE,
  RUST_SAMPLE,
  SWIFT_SAMPLE,
} from './languageSamples';

/** 遮掉之後某段文字還在不在（在＝被當成程式碼）。 */
function kept(text: string, lang: string, piece: string): boolean {
  const masked = maskText(text, syntaxForLanguage(lang));
  const i = text.indexOf(piece);
  return masked.slice(i, i + piece.length) === piece;
}

describe('更多語言（C／C++、Rust、Go、Java、C#、Kotlin、Swift、PHP、Ruby）', () => {
  it('每種語言的規則都能編譯', () => {
    for (const lang of ['c', 'cpp', 'rust', 'go', 'java', 'csharp', 'kotlin', 'swift', 'php', 'ruby']) {
      assert.deepStrictEqual(detect('', lang).errors, [], lang);
    }
  });

  describe('語法遮罩', () => {
    it('C／C++：字串、字元、註解、raw string 遮掉；數字分隔 1\'000 不當成字元', () => {
      const t = lines('int a = 1\'000\'000; f(); // x { y', 'char c = \'{\'; s = "a { b"; /* } */ g();', 'auto r = R"x(a } b)x"; h();');
      assert.ok(kept(t, 'cpp', 'f();'));
      assert.ok(!kept(t, 'cpp', 'x { y'));
      assert.ok(!maskText(t, 'cpp').includes("'{'"), '字元 \'{\' 遮掉');
      assert.ok(kept(t, 'cpp', 'g();'));
      assert.ok(kept(t, 'cpp', 'h();'));
      assert.ok(!maskText(t, 'cpp').includes('a } b'));
      assert.ok(!maskText(t, 'cpp').includes('a { b'));
    });

    it('Rust：生命週期不是字元；巢狀註解；raw string', () => {
      const t = lines("fn f<'a>(x: &'a str) -> &'a str { x }", '/* a /* b */ still comment { */ fn g() {}', 'let s = r#"has "quote" and {"#; done();');
      assert.ok(kept(t, 'rust', '{ x }'), '生命週期之後的程式碼不能被遮掉');
      assert.ok(!kept(t, 'rust', 'still comment {'));
      assert.ok(kept(t, 'rust', 'fn g() {}'));
      assert.ok(!maskText(t, 'rust').includes('has "quote"'));
      assert.ok(kept(t, 'rust', 'done();'));
    });

    it('Go 反引號字串、C# 逐字字串、Java 文字區塊、PHP heredoc 與 HTML、Ruby heredoc', () => {
      assert.ok(!kept(lines('q := `a', 'func x() {`', 'y()'), 'go', 'func x() {'));
      assert.ok(kept(lines('q := `a', 'func x() {`', 'y()'), 'go', 'y()'));
      assert.ok(kept('var p = @"C:\\temp\\"; f();', 'csharp', 'f();'), '逐字字串的反斜線不是跳脫');
      assert.ok(!kept(lines('s = """', 'void x() {', '""";'), 'java', 'void x() {'));
      const php = lines("<p>Don't</p><?php $a = 1; # c {", 'function f() {} ?>', '<b>function h() {</b>');
      assert.ok(kept(php, 'php', 'function f() {}'));
      assert.ok(!kept(php, 'php', 'function h() {'), 'PHP 標記外的 HTML 遮掉');
      const rb = lines('x = <<~SQL', '  def fake', 'SQL', 'def real; end');
      assert.ok(!kept(rb, 'ruby', 'def fake'));
      assert.ok(kept(rb, 'ruby', 'def real'));
    });
  });

  it('C：函式定義（含回傳 struct 指標），不抓宣告、初始化、註解與字串裡的內容', () => {
    assert.deepStrictEqual(outline(detect(C_SAMPLE, 'c').symbols), {
      'class point@3-5': {},
      'function add@11-19': {},
      'function make_point@21-24': {},
      'class color@26-26': {},
      'function main@28-33': {},
    });
  });

  it('C++：namespace、template、類別內方法與建構子、類別外 Class::method、operator', () => {
    assert.deepStrictEqual(outline(detect(CPP_SAMPLE, 'cpp').symbols, false), {
      'block app': {
        'block detail': { 'function clamp': {} },
        'class Widget': { 'method Widget': {}, 'method ~Widget': {}, 'method size': {} },
        'function Widget::paint': {},
        'function Widget::create': {},
        'function Config::name': {},
        'method Config::Config': {},
        'function operator==': {},
        'class Mode': {},
      },
    });
  });

  it('Rust：impl（含 trait）、方法、trait 有預設實作的方法、mod、where 子句、macro_rules!', () => {
    assert.deepStrictEqual(outline(detect(RUST_SAMPLE, 'rust').symbols), {
      'class Point@3-6': {},
      'class Meters@8-8': {},
      'class Point@10-19': { 'method new@11-13': {}, 'method first@15-18': {} },
      'class fmt::Display for Point@21-25': { 'method fmt@22-24': {} },
      'class Shape@27-32': { 'method name@29-31': {} },
      'class Command@34-37': {},
      'block tests@39-45': { 'function it_works@42-44': {} },
      'function run@47-52': {},
      'macro square@54-56': {},
    });
  });

  it('Go：func、帶 receiver 的方法顯示成 Type.Method、struct／interface、泛型', () => {
    assert.deepStrictEqual(outline(detect(GO_SAMPLE, 'go').symbols), {
      'class Server@2-4': {},
      'class Handler@6-8': {},
      'function NewServer@10-12': {},
      'method Server.Start@14-18': {},
      'method Server.Addr@20-20': {},
      'function Map@22-25': {},
    });
  });

  it('Java：類別、建構子、註記、泛型與 throws、跨行參數；不抓抽象方法與文字區塊', () => {
    assert.deepStrictEqual(outline(detect(JAVA_SAMPLE, 'java').symbols, false), {
      'class UserService': {
        'method run': {},
        'method UserService': {},
        'method findAll': {},
        'method group': {},
        'method text': {},
        'class Status': {},
        'class Pair': {},
      },
    });
  });

  it('C#：namespace、[Attribute]、async、=> 運算式本體、泛型與 where；不抓屬性', () => {
    assert.deepStrictEqual(outline(detect(CSHARP_SAMPLE, 'csharp').symbols, false), {
      'block App.Services': {
        'class OrderService': { 'method OrderService': {}, 'method Index': {}, 'method Sum': {}, 'method Find': {} },
        'class Money': {},
        'class Point': {},
      },
    });
  });

  it('Kotlin：沒有本體的 data class、= 運算式本體、擴充函式', () => {
    assert.deepStrictEqual(outline(detect(KOTLIN_SAMPLE, 'kotlin').symbols), {
      'class User@0-0': {},
      'class Repo@2-12': { 'method load@3-5': {}, 'method second@7-7': {}, 'method create@10-10': {} },
      'function main@14-16': {},
    });
  });

  it('Swift：class／extension／struct、init、func', () => {
    // extension 與 class 同名時兩個都列出
    assert.deepStrictEqual(outline(detect(SWIFT_SAMPLE, 'swift').symbols), {
      'class ViewController@2-10': { 'method init@3-5': {}, 'method viewDidLoad@7-9': {} },
      'class ViewController@12-14': { 'method tableView@13-13': {} },
      'class Point@16-18': { 'method move@17-17': {} },
      'function helper@20-20': {},
    });
  });

  it('PHP：只看 <?php ?> 裡面；類別方法、函式；不抓抽象方法、heredoc 與 HTML 裡的文字', () => {
    assert.deepStrictEqual(outline(detect(PHP_SAMPLE, 'php').symbols), {
      'class Controller@6-20': { 'method __construct@8-8': {}, 'method index@10-17': {} },
      'function helper@22-24': {},
    });
  });

  it('Ruby：module／class、def self.、if／do 裡的 end 不會提早結束、endless method、一行寫完的 def', () => {
    assert.deepStrictEqual(outline(detect(RUBY_SAMPLE, 'ruby').symbols), {
      'class Billing@0-28': {
        'class Invoice@1-27': {
          'method self.create_for@3-5': {},
          'method total@7-15': {},
          'method paid?@17-17': {},
          'method notes@21-26': {},
        },
      },
      'function helper@30-30': {},
    });
  });

  it('極端長行（大量樣板參數、型別詞）不會讓偵測卡住', function () {
    this.timeout(10000);
    const evil = [
      'std::map<std::string, std::vector<std::pair<int, int>>> '.repeat(200) + 'x = y;',
      'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(40) + '(',
      'Foo<Bar<Baz<Q<R<S<T>>>>>> '.repeat(100) + 'name(',
      'impl<' + 'T: A<B<C>>, '.repeat(200) + '> X for Y {',
      'public static final ' + 'List<Map<String, Object>> '.repeat(150) + 'f(',
      '[' + 'Attr(1), '.repeat(300) + '] public void M(',
    ].join('\n');
    for (const lang of ['c', 'cpp', 'rust', 'go', 'java', 'csharp', 'kotlin', 'swift', 'php', 'ruby']) {
      const t = Date.now();
      detect(evil.repeat(10), lang);
      assert.ok(Date.now() - t < 2000, `${lang} 花了 ${Date.now() - t}ms`);
    }
  });

  it('PHP：很多 <?= ?> 區塊的大檔案也很快', () => {
    const t = Date.now();
    detect(Array(3000).fill('<div><?= $a ?></div><?php function f() { return 1; } ?>').join('\n'), 'php');
    assert.ok(Date.now() - t < 1000, `花了 ${Date.now() - t}ms`);
  });

  describe('React（JSX）', () => {
    it('元件、hook、memo／forwardRef／useCallback、class 元件（.jsx、.tsx、.js 都一樣）', () => {
      const want = {
        'function App@8-36': { 'function handleClick@18-21': {}, 'function renderItem@23-25': {} },
        'function Header@38-40': {},
        'function Footer@42-42': {},
        'function Card@44-46': {},
        'function Input@48-50': {},
        'class Legacy@52-66': { 'method handleInc@55-57': {}, 'method componentDidMount@59-61': {}, 'method render@63-65': {} },
        'function useCounter@68-72': { 'function inc@70-70': {} },
      };
      for (const lang of ['javascriptreact', 'typescriptreact', 'javascript']) {
        assert.deepStrictEqual(outline(detect(REACT_SAMPLE, lang).symbols), want, lang);
      }
    });

    it('JSX 標籤之間的文字與屬性值遮掉，{…} 裡照程式碼；註解裡的 { 不影響配對', () => {
      const t = lines(
        'const A = () => (',
        "  <div title=\"a { b\">Don't {/* x { */} <a href=\"/x\">go</a> / {items.map((i) => {",
        '    return <b key={i}>{i}</b>;',
        '  })}</div>',
        ');',
        'function after() {}',
      );
      const masked = maskText(t, syntaxForLanguage('javascriptreact'));
      assert.strictEqual((masked.match(/\{/g) ?? []).length, (masked.match(/\}/g) ?? []).length, masked);
      assert.ok(masked.includes('items.map((i) => {'));
      assert.ok(!masked.includes("Don't"));
      assert.deepStrictEqual(Object.keys(outline(detect(t, 'javascriptreact').symbols, false)), ['function A', 'function after']);
    });

    it('大檔案與上千層巢狀也不會卡住或出錯', function () {
      this.timeout(10000);
      let t = Date.now();
      detect(Array(300).fill(REACT_SAMPLE).join('\n'), 'javascriptreact');
      assert.ok(Date.now() - t < 2000, `大檔案花了 ${Date.now() - t}ms`);
      const nested = (k: number) => 'const A = () => (' + '<div>{`${'.repeat(k) + 'x' + '}`}</div>'.repeat(k) + ');\nfunction after() {}';
      // 3000 層：超過上限後遮罩不精準，但不能當掉或卡住
      t = Date.now();
      assert.doesNotThrow(() => detect(nested(3000), 'javascriptreact'));
      assert.ok(Date.now() - t < 2000, `深層巢狀花了 ${Date.now() - t}ms`);
      // 100 層：結果正確
      assert.ok(detect(nested(100), 'javascriptreact').symbols.some((s) => s.name === 'after'));
    });

    it('.ts 的 <型別>值、.tsx 的泛型箭頭函式 <T,>、比較運算 a < b 不會被當成 JSX', () => {
      const ts = lines('const n = <number>value;', 'function f() { return 1; }');
      assert.deepStrictEqual(Object.keys(outline(detect(ts, 'typescript').symbols, false)), ['function f']);
      const tsx = lines('const id = <T,>(x: T) => {', '  return x;', '};', 'const g = <T extends object>(x: T) => x;', 'if (a < b && c > d) { h(); }', 'function z() {}');
      assert.deepStrictEqual(Object.keys(outline(detect(tsx, 'typescriptreact').symbols, false)), ['function id', 'function g', 'function z']);
    });
  });

  describe('實際專案找到的寫法（改寫成最小範例）', () => {
    it('Python：多行字串的內容與結尾引號寫在第 0 欄，不會讓函式提早結束', () => {
      const t = lines(
        'class Repo:',
        '    def query(self):',
        '        js_body = """',
        'function(items) {',
        '    return items;',
        '}',
        '"""',
        '        return self.run(js_body)',
        '',
        '    def describe(self, d):',
        '        text = \\',
        'f"""# FW: {d["fw"]}',
        '# HOST: {d["host"]}"""',
        '        return text',
        '',
        '    def last(self):',
        '        pass',
      );
      assert.deepStrictEqual(outline(detect(t, 'python').symbols), {
        'class Repo@0-16': { 'method query@1-7': {}, 'method describe@9-13': {}, 'method last@15-16': {} },
      });
    });

    it('Python：本體只有 docstring 的 class 與 def，範圍包含整段 docstring', () => {
      const t = lines(
        'class Stub(object):',
        '    """Only a docstring."""',
        '',
        '    def __init__(self, channel):',
        '        """Constructor.',
        '',
        '        Args:',
        '            channel: A channel.',
        '        """',
        '',
        '',
        'class Servicer(object):',
        '    """Only a docstring."""',
      );
      assert.deepStrictEqual(outline(detect(t, 'python').symbols), {
        'class Stub@0-8': { 'method __init__@3-8': {} },
        'class Servicer@11-12': {},
      });
    });

    it('檔案開頭有 BOM：第一行的標題、def 也抓得到，位置不變', () => {
      const md = detect('﻿# Title\n\n## Sub', 'markdown');
      assert.deepStrictEqual(Object.keys(outline(md.symbols, false)), ['heading Title']);
      assert.strictEqual(md.symbols[0].nameStartCol, 3);
      assert.deepStrictEqual(Object.keys(outline(detect('﻿def first():\n    pass', 'python').symbols, false)), ['function first']);
    });

    it('JS：括號裡的 JSX、立即執行函式不是函式；預設參數有呼叫、useCallback 參數換行的是函式', () => {
      const t = lines(
        'export const Page = () => {',
        '  const tagEl = (',
        '    <Tag onClick={() => setOpen(true)}>x</Tag>',
        '  );',
        '  const stack = (() => {',
        '    return [];',
        '  })();',
        '  const invoke = (args, now = Date.now()) => {',
        '    return args;',
        '  };',
        '  const columns = useCallback(',
        '    (row) => {',
        '      return row;',
        '    },',
        '    [],',
        '  );',
        '  return tagEl;',
        '};',
      );
      for (const lang of ['javascriptreact', 'typescriptreact']) {
        assert.deepStrictEqual(Object.keys(outline(detect(t, lang).symbols[0].children, false)), ['function invoke', 'function columns'], lang);
      }
    });
  });

  it('既有語言不受影響：JS 物件裡的方法遇到 } 就結束', () => {
    const r = detect(lines('const o = {', '  a() {}', '};', 'function b() {}'), 'javascript');
    assert.deepStrictEqual(Object.keys(outline(r.symbols, false)), ['method a', 'function b']);
  });
});

describe('Windows 換行（CRLF）', () => {
  const crlf = (text: string) => text.replace(/\n/g, '\r\n');

  it('JS：行尾反斜線接續的多行字串（含跳脫的單引號），後面的函式照樣找得到', () => {
    const t = lines(
      "var notes = ' \\",
      '<b>v1</b><br>\\',
      "- it didn\\'t work<br>\\",
      "- the team\\'s path<br>';",
      '',
      'function first(a) {',
      '  return a;',
      '}',
      '',
      'function second() {',
      '  if (x) { y(); }',
      '}',
    );
    const want = { 'function first@5-7': {}, 'function second@9-11': {} };
    assert.deepStrictEqual(outline(detect(t, 'javascript').symbols), want, 'LF');
    assert.deepStrictEqual(outline(detect(crlf(t), 'javascript').symbols), want, 'CRLF');
  });

  it('C 與 Python：字串裡的行尾反斜線接續', () => {
    const c = lines('const char *s = "a \\', 'b\'s";', 'int f(void) {', '  return 0;', '}');
    assert.deepStrictEqual(outline(detect(crlf(c), 'c').symbols), outline(detect(c, 'c').symbols));
    assert.deepStrictEqual(Object.keys(outline(detect(crlf(c), 'c').symbols, false)), ['function f']);
    const py = lines("s = 'a \\", "b'", 'def f():', '    return 1');
    assert.deepStrictEqual(outline(detect(crlf(py), 'python').symbols), outline(detect(py, 'python').symbols));
    assert.deepStrictEqual(Object.keys(outline(detect(crlf(py), 'python').symbols, false)), ['function f']);
  });

  it('Markdown：標題範圍和 LF 相同（不多算下一個標題前的空白行）', () => {
    const md = lines('# A', '', '## B', 'text', '', '## C', 'more');
    assert.deepStrictEqual(outline(detect(crlf(md), 'markdown').symbols), outline(detect(md, 'markdown').symbols));
  });
});
