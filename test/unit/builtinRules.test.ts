import * as assert from 'assert';
import { BUILTIN_RULES } from '../../src/detection/languages';
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
        'function f', // useCallback 包起來的也算（ts-wrapped）；const g = 1 不算
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

  describe('事件監聽與 ajax（實際專案的程式碼）', () => {
    const snippet = lines(
      "$('#toggleBtn').on('click', function(e) {", // 0
      '    e.preventDefault();  // 防止按鈕預設行為', // 1
      "    $('#featureBox').slideToggle(300);", // 2
      "    const btnText = $(this).find('.btn-text');", // 3
      "    if (btnText.text() === '收合功能區') {", // 4
      "        btnText.text('展開功能區');", // 5
      '    }', // 6
      '});', // 7
      '', // 8
      '$.ajax({', // 9
      "    url: '/do_action',", // 10
      "    type: 'GET',", // 11
      "    data: { 'ip': select_ip, 'request': \"share_device\" },", // 12
      "    dataType: 'json',", // 13
      '    success: function (data) {', // 14
      "        if (data.status == 'success') {", // 15
      '            showPassMessage(requestData);', // 16
      '        }', // 17
      '    },', // 18
      '    error: function (jqXHR, textStatus, errorThrown) {', // 19
      "        console.error('Error fetching screenshot:', textStatus);", // 20
      '    }', // 21
      '});', // 22
    );

    it('jQuery 事件顯示成「#toggleBtn click」；ajax 顯示成「GET /do_action」，不顯示 success、error 回呼', () => {
      const r = detect(snippet, 'javascript');
      assert.deepStrictEqual(outline(r.symbols), {
        'event #toggleBtn click@0-7': {},
        'request GET /do_action@9-22': {},
      });
    });

    it('在 Django template 的 <script> 裡也一樣', () => {
      const r = detect(lines('{% block scripts %}', '<script>', snippet, '</script>', '{% endblock %}'), 'html');
      assert.deepStrictEqual(Object.keys(outline(r.symbols[0].children, false)), ['event #toggleBtn click', 'request GET /do_action']);
    });

    it('各種事件寫法', () => {
      const r = detect(
        lines(
          '$(document).on("click", ".delete-btn", function () {});',
          "$('#form').off('submit').on('submit', (e) => {});",
          "$('.item').click(function () {});",
          '$(window).resize(() => {});',
          '$(document).ready(function () {});',
          '$(function () {});',
          "document.getElementById('save').addEventListener('click', async (e) => {});",
          "btn.addEventListener('keyup', handler => {});",
          'window.onload = function () {};',
          "el.onclick = () => { go(); };",
          "// $('#nope').on('click', function () {});",
          "const s = \"$('#nope2').click(function () {})\";",
          "$('#x').on('click', namedHandler);",
        ),
        'javascript',
      );
      assert.deepStrictEqual(r.symbols.map((x) => `${x.kind} ${x.name}`), [
        'event document click .delete-btn',
        'event #form submit',
        'event .item click',
        'event window resize',
        'event document ready',
        'event document ready',
        "event document.getElementById('save') click",
        'event btn keyup',
        'event window load',
        'event el click',
      ]);
    });

    it('各種請求寫法', () => {
      const r = detect(
        lines(
          "$.ajax({ type: 'post', data: { type: 'inner' }, url: '/api/save', success: function () {} });",
          '$.ajax({ url: apiUrl, method: "DELETE" });',
          '$.ajax({ dataType: "json" });',
          "$.get('/api/list', function (data) {});",
          "$.post(`/api/${id}`, payload);",
          "fetch('/api/items');",
          "fetch('/api/items', { method: 'PUT', body: x });",
          "axios.delete('/api/items/1');",
        ),
        'javascript',
      );
      assert.deepStrictEqual(Object.keys(outline(r.symbols, false)), [
        'request POST /api/save',
        'request DELETE apiUrl',
        'request AJAX',
        'request GET /api/list',
        'request POST /api/${id}',
        'request GET /api/items',
        'request PUT /api/items',
        'request DELETE /api/items/1',
      ]);
      assert.deepStrictEqual(r.symbols[0].children, [], 'ajax 底下不顯示回呼');
    });

    it('回呼裡的 ajax、事件監聽仍然顯示（只隱藏回呼本身）', () => {
      const r = detect(
        lines(
          "$('#save').on('click', function () {",
          "  $.ajax({ url: '/save', type: 'POST', success: function () {",
          "    $.get('/reload', function () {});",
          '  } });',
          '});',
          'setTimeout(function () {}, 100);',
          '[1, 2].forEach(function (x) {});',
        ),
        'javascript',
      );
      assert.deepStrictEqual(outline(r.symbols, false), {
        'event #save click': { 'request POST /save': { 'request GET /reload': {} } },
      });
    });

    it('HTML 的 onclick 等屬性', () => {
      const r = detect(
        lines('<button type="button" onclick="toggleMenu()">選單</button>', '<form onsubmit="return check(this)">', '</form>'),
        'html',
      );
      assert.deepStrictEqual(Object.keys(outline(r.symbols, false)), [
        'event button onclick → toggleMenu()',
        'event form onsubmit → return check(this)',
      ]);
    });
  });

  describe('Markdown 目錄結構', () => {
    it('# 標題依層級形成上下層，範圍到下一個同層或更上層標題之前（不含結尾空行）', () => {
      const r = detect(
        lines(
          '# 專案說明', // 0
          '介紹文字', // 1
          '## 安裝', // 2
          '### 使用 npm', // 3
          'npm i', // 4
          '### 手動安裝 ###', // 5
          '', // 6
          '## 使用方式', // 7
          '#### 跳一層也可以', // 8
          '# 附錄', // 9
        ),
        'markdown',
      );
      assert.deepStrictEqual(outline(r.symbols), {
        'heading 專案說明@0-8': {
          'heading 安裝@2-5': { 'heading 使用 npm@3-4': {}, 'heading 手動安裝@5-5': {} },
          'heading 使用方式@7-8': { 'heading 跳一層也可以@8-8': {} },
        },
        'heading 附錄@9-9': {},
      });
      assert.strictEqual(r.symbols[0].children[0].children[0].path, '專案說明.安裝.使用 npm');
    });

    it('底線寫法（=== 第 1 層、--- 第 2 層）', () => {
      const r = detect(lines('Title', '=====', 'text', 'Sub', '---', 'more'), 'markdown');
      assert.deepStrictEqual(outline(r.symbols), { 'heading Title@0-5': { 'heading Sub@3-5': {} } });
    });

    it('程式碼區塊、HTML 註解、front matter 裡的 # 不算標題；清單後的 --- 不算底線標題', () => {
      const r = detect(
        lines(
          '---',
          'title: x',
          '# not heading',
          '---',
          '# 真的標題',
          '```bash',
          '# 這是註解',
          '```',
          '~~~',
          '## 也不是',
          '~~~',
          '<!-- # 註解 -->',
          '- 清單項目',
          '---',
          '#沒有空白不算',
          '## 結尾',
        ),
        'markdown',
      );
      assert.deepStrictEqual(outline(r.symbols, false), { 'heading 真的標題': { 'heading 結尾': {} } });
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
