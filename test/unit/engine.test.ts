import * as assert from 'assert';
import { BUILTIN_RULES } from '../../src/detection/languages';
import { detectSymbols, findInnermost, mergeRules, renderNameTemplate } from '../../src/detection/engine';
import { DetectionRule } from '../../src/detection/types';
import { detect, lines, outline } from './helpers';

describe('detectSymbols 規則引擎', () => {
  it('brace：配對大括號，略過字串與註解裡的括號', () => {
    const r = detect(
      lines(
        'function a() {', // 0
        '  const s = "}";', // 1
        '  // }', // 2
        '  if (x) { y(); }', // 3
        '}', // 4
        'function b() {}', // 5
      ),
      'typescript',
    );
    assert.deepStrictEqual(outline(r.symbols), { 'function a@0-4': {}, 'function b@5-5': {} });
  });

  it('brace：參數跨多行、參數型別含大括號', () => {
    const r = detect(
      lines(
        'function a(', // 0
        '  opts: { x: number },', // 1
        '  b: string,', // 2
        '): void {', // 3
        '  return;', // 4
        '}', // 5
      ),
      'typescript',
    );
    assert.deepStrictEqual(outline(r.symbols), { 'function a@0-5': {} });
  });

  it('brace：箭頭函式只有運算式時，到該行結束', () => {
    const r = detect(lines('const f = (a) => a + 1', 'const g = (a) =>', '  a * 2;', 'const h = 1;'), 'javascript');
    assert.deepStrictEqual(outline(r.symbols), { 'function f@0-0': {}, 'function g@1-2': {} });
  });

  it('brace：宣告式（多載）以分號結束', () => {
    const r = detect(lines('export function a(x: string): void;', 'export function a(x: any) {', '}'), 'typescript');
    assert.deepStrictEqual(
      r.symbols.map((s) => `${s.name}@${s.startLine}-${s.endLine}`),
      ['a@0-0', 'a@1-2'],
    );
  });

  it('indent：縮排結束、空行與註解不影響、多行參數', () => {
    const r = detect(
      lines(
        'def a(', // 0
        '    x,', // 1
        '    y,', // 2
        '):', // 3
        '    z = 1', // 4
        '', // 5
        '    # comment', // 6
        '    return z', // 7
        '', // 8
        'def b(): return 1', // 9
      ),
      'python',
    );
    assert.deepStrictEqual(outline(r.symbols), { 'function a@0-7': {}, 'function b@9-9': {} });
  });

  it('pair：巢狀成對標籤', () => {
    const r = detect(
      lines(
        '{% block a %}', // 0
        '  {% block b %}x{% endblock %}', // 1
        '  {% block c %}', // 2
        '  {% endblock c %}', // 3
        '{% endblock %}', // 4
      ),
      'html',
    );
    assert.deepStrictEqual(outline(r.symbols), {
      'block a@0-4': { 'block b@1-1': {}, 'block c@2-3': {} },
    });
    assert.strictEqual(r.symbols[0].children[1].path, 'a.c');
  });

  it('pair：沒有結束標籤時只算一行', () => {
    const r = detect(lines('{% block a %}', 'x'), 'html');
    assert.deepStrictEqual(outline(r.symbols), { 'block a@0-0': {} });
  });

  it('embedded：<script> 內套用 JS 規則，行號以整份檔案計算', () => {
    const r = detect(
      lines(
        '{% block scripts %}', // 0
        '<script>', // 1
        '  function init() {', // 2
        '    // {% block nope %}', // 3
        '  }', // 4
        '</script>', // 5
        '<script src="x.js"></script>', // 6
        '{% endblock %}', // 7
      ),
      'html',
    );
    assert.deepStrictEqual(outline(r.symbols), { 'block scripts@0-7': { 'function init@2-4': {} } });
    const init = r.symbols[0].children[0];
    assert.strictEqual(init.nameLine, 2);
    assert.strictEqual(init.nameStartCol, 11);
  });

  it('within：不符合的節點移除，子節點往上接', () => {
    const r = detect(lines('def a():', '    def b():', '        pass', 'class C:', '    def m(self):', '        pass'), 'python');
    assert.deepStrictEqual(outline(r.symbols, false), {
      'function a': { 'function b': {} },
      'class C': { 'method m': {} },
    });
  });

  it('同一個名稱位置只保留一筆', () => {
    const r = detect(lines('class C:', '    def m(self):', '        pass'), 'python');
    assert.strictEqual(r.symbols[0].children.length, 1);
    assert.strictEqual(r.symbols[0].children[0].kind, 'method');
    assert.strictEqual(r.symbols[0].children[0].path, 'C.m');
  });

  it('名稱位置（跳轉用）正確', () => {
    const r = detect('  async def run_job(self):\n    pass', 'python');
    const s = r.symbols[0];
    assert.strictEqual(s.nameLine, 0);
    assert.strictEqual(s.nameStartCol, 12);
    assert.strictEqual(s.nameEndCol, 19);
  });

  it('規則錯誤：回報但不影響其他規則', () => {
    const rules: DetectionRule[] = [
      { id: 'bad-regex', languages: ['python'], pattern: '(?<name>[', kind: 'function', body: 'line' },
      { id: 'no-name', languages: ['python'], pattern: 'def (\\w+)', kind: 'function', body: 'line' },
      { id: 'no-end', languages: ['python'], pattern: 'x(?<name>\\w+)', kind: 'block', body: 'pair' },
      { id: 'ok', languages: ['python'], pattern: '^def (?<name>\\w+)', kind: 'function', body: 'line' },
    ];
    const r = detectSymbols('def a():\n  pass', 'python', rules);
    assert.deepStrictEqual(
      r.errors.map((e) => e.ruleId),
      ['bad-regex', 'no-name', 'no-end'],
    );
    assert.deepStrictEqual(outline(r.symbols, false), { 'function a': {} });
  });

  it('isApplicable 可排除規則（例如 include glob 不符）', () => {
    const src = '{% block a %}{% endblock %}';
    assert.strictEqual(detect(src, 'html').symbols.length, 1);
    const r = detectSymbols(src, 'html', BUILTIN_RULES, { isApplicable: (rule) => !rule.include });
    assert.strictEqual(r.symbols.length, 0);
  });

  it('停用的規則不比對', () => {
    const rules = mergeRules(BUILTIN_RULES, [], ['py-def', 'py-method']);
    assert.strictEqual(detectSymbols('def a():\n  pass', 'python', rules).symbols.length, 0);
  });

  it('findInnermost：找出最內層的符號', () => {
    const r = detect(lines('class C:', '    def m(self):', '        x = 1', '', 'y = 2'), 'python');
    assert.strictEqual(findInnermost(r.symbols, 2)?.path, 'C.m');
    assert.strictEqual(findInnermost(r.symbols, 0)?.path, 'C');
    assert.strictEqual(findInnermost(r.symbols, 4), undefined);
  });
});

describe('renderNameTemplate 名稱樣板', () => {
  it('群組、轉大寫、預設值，並整理空白', () => {
    assert.strictEqual(renderNameTemplate('${type:upper|AJAX} ${url}', { type: 'get', url: '/x' }), 'GET /x');
    assert.strictEqual(renderNameTemplate('${type:upper|AJAX} ${url}', { url: '/x' }), 'AJAX /x');
    assert.strictEqual(renderNameTemplate('${a}${b}  ${c}', { b: 'B' }), 'B');
    assert.strictEqual(renderNameTemplate('fixed', {}), 'fixed');
  });
});

describe('mergeRules 合併規則', () => {
  const base: DetectionRule[] = [
    { id: 'a', languages: ['python'], pattern: 'a(?<name>x)', kind: 'function', body: 'line' },
    { id: 'b', languages: ['python'], pattern: 'b(?<name>x)', kind: 'function', body: 'line' },
  ];

  it('同 id 覆蓋內建規則的欄位', () => {
    const r = mergeRules(base, [{ ...base[0], kind: 'class' }], []);
    assert.strictEqual(r.find((x) => x.id === 'a')?.kind, 'class');
  });

  it('使用者新增的規則加在後面', () => {
    const r = mergeRules(base, [{ id: 'c', languages: ['go'], pattern: '(?<name>x)', kind: 'function', body: 'line' }], []);
    assert.deepStrictEqual(r.map((x) => x.id), ['a', 'b', 'c']);
  });

  it('disabledRules 關閉規則', () => {
    const r = mergeRules(base, [], ['b']);
    assert.strictEqual(r.find((x) => x.id === 'b')?.enabled, false);
  });
});
