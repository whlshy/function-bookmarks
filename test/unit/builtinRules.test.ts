import * as assert from 'assert';
import { BUILTIN_RULES } from '../../src/detection/builtinRules';
import { detect, lines, outline } from './helpers';

describe('內建規則', () => {
  it('每條規則都能編譯，沒有錯誤', () => {
    for (const lang of ['typescript', 'python', 'html']) {
      assert.deepStrictEqual(detect('', lang).errors, [], lang);
    }
  });

  it('規則 id 不重複', () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  describe('TypeScript / JavaScript', () => {
    it('ts-function：各種 function 宣告', () => {
      const r = detect(
        lines(
          'function a() {}',
          'export function b<T>(x: T) {}',
          'export default async function c() {}',
          'function* d() {}',
          'async function* e() {}',
          'declare function f(): void;',
        ),
        'typescript',
      );
      assert.deepStrictEqual(Object.keys(outline(r.symbols, false)), [
        'function a',
        'function b',
        'function c',
        'function d',
        'function e',
        'function f',
      ]);
    });

    it('ts-arrow：箭頭函式', () => {
      const r = detect(
        lines(
          'const a = () => {};',
          'export const b = async (x: number): Promise<void> => {',
          '};',
          'let c = x => x * 2;',
          'const d: Handler = (e) => {};',
          'const e = <T,>(x: T) => x;',
          'const f = useCallback(() => {}, []);',
          'const g = 1;',
        ),
        'typescript',
      );
      assert.deepStrictEqual(Object.keys(outline(r.symbols, false)), [
        'function a',
        'function b',
        'function c',
        'function d',
        'function e',
      ]);
    });

    it('ts-function-expr：function 運算式', () => {
      const r = detect(lines('const a = function () {', '};', 'var b = async function named() {};'), 'javascript');
      assert.deepStrictEqual(outline(r.symbols), { 'function a@0-1': {}, 'function b@2-2': {} });
    });

    it('ts-class 與類別成員：方法、constructor、getter、箭頭屬性、私有方法', () => {
      const r = detect(
        lines(
          'export abstract class UserService extends Base<T> implements I {', // 0
          '  private repo = new Repo();', // 1
          '  constructor(private readonly db: Db) {', // 2
          '    super();', // 3
          '  }', // 4
          '  async login(user: string, opts: { remember: boolean }): Promise<void> {', // 5
          '    if (!user) {', // 6
          '      throw new Error();', // 7
          '    }', // 8
          '    this.repo.save(user);', // 9
          '  }', // 10
          '  get name(): string { return this.n; }', // 11
          '  static create() {}', // 12
          '  #secret() {}', // 13
          '  handle = (e: Event) => {', // 14
          '  };', // 15
          '}', // 16
        ),
        'typescript',
      );
      assert.deepStrictEqual(outline(r.symbols), {
        'class UserService@0-16': {
          'method constructor@2-4': {},
          'method login@5-10': {},
          'method name@11-11': {},
          'method create@12-12': {},
          'method #secret@13-13': {},
          'method handle@14-15': {},
        },
      });
      assert.strictEqual(r.symbols[0].children[1].path, 'UserService.login');
    });

    it('ts-method：物件字面值的簡寫方法（例如 Vue options API）', () => {
      const r = detect(
        lines('export default {', '  data() {', '    return {};', '  },', '  methods: {', '    save() {', '    },', '  },', '};'),
        'javascript',
      );
      assert.deepStrictEqual(Object.keys(outline(r.symbols, false)), ['method data', 'method save']);
    });

    it('ts-object-fn：物件屬性是函式', () => {
      const r = detect(
        lines(
          'const api = {',
          '  fetch: async (id) => {',
          '  },',
          '  remove: function () {',
          '  },',
          '  value: () => 1,',
          '};',
        ),
        'javascript',
      );
      assert.deepStrictEqual(Object.keys(outline(r.symbols, false)), ['function fetch', 'function remove']);
    });

    it('不會把控制流程、函式呼叫、註解、字串誤判成函式', () => {
      const r = detect(
        lines(
          'if (a) {',
          '}',
          'for (const x of y) {',
          '}',
          'while (true) {',
          '}',
          'switch (x) {',
          '}',
          'describe("x", () => {',
          '});',
          'promise.then(() => {',
          '});',
          'foo(bar);',
          '// function nope() {}',
          'const s = "function nope2() {}";',
          'type Props = { onClick: (e: Event) => void };',
        ),
        'typescript',
      );
      assert.deepStrictEqual(outline(r.symbols), {});
    });
  });

  describe('Python', () => {
    it('py-class、py-method、py-def：Django view 與 class-based view', () => {
      const r = detect(
        lines(
          'from django.views import View', // 0
          '', // 1
          '@login_required', // 2
          'def index(request):', // 3
          '    return render(request, "index.html")', // 4
          '', // 5
          'class ArticleView(LoginRequiredMixin, View):', // 6
          '    template_name = "a.html"', // 7
          '', // 8
          '    def get(self, request, *args, **kwargs):', // 9
          '        def helper():', // 10
          '            pass', // 11
          '        return helper()', // 12
          '', // 13
          '    async def post(self, request):', // 14
          '        """def fake():"""', // 15
          '        pass', // 16
          '', // 17
          'def generic[T](x: T) -> T:', // 18
          '    return x', // 19
        ),
        'python',
      );
      assert.deepStrictEqual(outline(r.symbols), {
        'function index@3-4': {},
        'class ArticleView@6-16': {
          'method get@9-12': { 'function helper@10-11': {} },
          'method post@14-16': {},
        },
        'function generic@18-19': {},
      });
    });
  });

  describe('Django template', () => {
    const tpl = lines(
      '{% extends "base.html" %}', // 0
      '{% load static %}', // 1
      '{# {% block commented %}{% endblock %} #}', // 2
      '{% block title %}登入{% endblock %}', // 3
      '{% block content %}', // 4
      '  {% include "partials/nav.html" %}', // 5
      '  {% include \'partials/card.html#card\' with x=1 %}', // 6
      '  {%- block form -%}', // 7
      '    <form id="login-form">', // 8
      '    </form>', // 9
      '  {%- endblock form -%}', // 10
      '  {% partialdef card inline %}', // 11
      '    <div>{{ x }}</div>', // 12
      '  {% endpartialdef %}', // 13
      '{% endblock content %}', // 14
      '{% block scripts %}', // 15
      '<script type="module">', // 16
      '  const submit = async () => {', // 17
      '  };', // 18
      '</script>', // 19
      '{% endblock %}', // 20
    );

    it('block、partial、extends、include、<script> 內的 JS', () => {
      const r = detect(tpl, 'html');
      assert.deepStrictEqual(outline(r.symbols), {
        'reference base.html@0-0': {},
        'block title@3-3': {},
        'block content@4-14': {
          'reference partials/nav.html@5-5': {},
          'reference partials/card.html#card@6-6': {},
          'block form@7-10': {},
          'partial card@11-13': {},
        },
        'block scripts@15-20': { 'function submit@17-18': {} },
      });
      assert.strictEqual(r.symbols[2].children[2].path, 'content.form');
      assert.strictEqual(r.symbols[0].target, 'base.html');
      assert.strictEqual(r.symbols[0].ruleId, 'dj-extends');
    });

    it('django-html 與 jinja-html 語言也適用', () => {
      for (const lang of ['django-html', 'jinja-html']) {
        assert.strictEqual(detect('{% block a %}{% endblock %}', lang).symbols.length, 1, lang);
      }
    });

    it('html-id 預設停用；啟用後可抓有 id 的標籤', () => {
      assert.ok(!JSON.stringify(outline(detect(tpl, 'html').symbols)).includes('login-form'));
      const r = detect(tpl, 'html', BUILTIN_RULES);
      assert.deepStrictEqual(outline(r.symbols[2].children[2].children), { 'block login-form@8-8': {} });
    });

    it('jinja-macro', () => {
      const r = detect(lines('{% macro field(f, cls="") %}', '  {{ f }}', '{% endmacro %}'), 'jinja-html');
      assert.deepStrictEqual(outline(r.symbols), { 'macro field@0-2': {} });
    });
  });
});
