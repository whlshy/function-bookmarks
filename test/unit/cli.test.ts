import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rootFromScriptPath } from '../../src/cli/project';
import { run } from '../../src/cli/run';
import { parseStore, StoreData } from '../../src/storage/marks';

const PY = [
  'import os',
  '',
  '',
  'class ArticleView:',
  '    def get(self, request):',
  '        article = load(request)',
  '        return render(article)',
  '',
  '    def post(self, request):',
  '        save(request)',
  '',
  '',
  'def helper(payload):',
  '    data = parse(payload)',
  '    return data',
];

describe('CLI（給 AI 助理用）', () => {
  let root: string;
  let sub: string;

  const write = (rel: string, text: string) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const read = (rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
  const store = (): StoreData => parseStore(read('.vscode/function-bookmarks.json'))!;

  /** 執行一個指令，回傳結束碼與輸出。預設在子資料夾執行（確認會往上找專案根目錄）。 */
  async function fb(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const code = await run(argv, { cwd: sub, out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) });
    return { code, out, err };
  }
  async function ok(...argv: string[]): Promise<string> {
    const r = await fb(...argv);
    assert.strictEqual(r.code, 0, `${argv.join(' ')}\n${r.err}`);
    return r.out;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cli-'));
    write('.git/HEAD', 'ref: refs/heads/main\n');
    write('app/views.py', PY.join('\n') + '\n');
    write('app/notes.unknownext', 'hello\n');
    sub = path.join(root, 'app');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('複製到專案 skills 資料夾的 CLI 由自己的位置得知專案根目錄；其他位置不猜', () => {
    for (const agent of ['.cursor', '.claude', '.agents']) {
      assert.strictEqual(rootFromScriptPath(path.join(root, agent, 'skills', 'function-bookmarks', 'scripts', 'fb.js')), root, agent);
    }
    assert.strictEqual(rootFromScriptPath(path.join(root, 'dist', 'cli.js')), undefined);
    assert.strictEqual(rootFromScriptPath(path.join(root, '.other', 'skills', 'function-bookmarks', 'scripts', 'fb.js')), undefined);
    assert.strictEqual(rootFromScriptPath(undefined), undefined);
  });

  it('往上找專案根目錄時停在最近一個有 .vscode 的資料夾，不會跑去改上層專案的書籤', async () => {
    write('.vscode/function-bookmarks.json', '{"version":1,"symbols":[]}');
    write('nested/.vscode/settings.json', '{}');
    write('nested/a.py', 'def f():\n    pass\n');
    let err = '';
    const code = await run(['add', 'a.py#f'], { cwd: path.join(root, 'nested'), out: () => undefined, err: (t) => (err += t) });
    assert.strictEqual(code, 0, err);
    assert.ok(fs.existsSync(path.join(root, 'nested', '.vscode', 'function-bookmarks.json')));
    assert.strictEqual(read('.vscode/function-bookmarks.json'), '{"version":1,"symbols":[]}', '上層的書籤檔不動');
  });

  it('沒有書籤時；說明；不認得的指令', async () => {
    assert.ok((await ok('list')).includes('No bookmarks.'));
    const info = JSON.parse(await ok('info', '--json'));
    assert.deepStrictEqual([info.root, info.bookmarksFileExists, info.branch], [root, false, 'main']);
    assert.ok((await ok('help')).includes('fb add'));
    const bad = await fb('nope');
    assert.strictEqual(bad.code, 1);
    assert.ok(bad.err.includes('Unknown command'));
  });

  it('依名稱加函式書籤：建立書籤檔、加進 .git/info/exclude；名稱打錯時提示用 functions 查', async () => {
    const out = await ok('add', 'views.py#ArticleView.get', '--label', '文章頁', '--note', '要檢查權限', '--tags', 'auth,core', '--number', '1');
    assert.ok(out.startsWith('Added: app/views.py:5  method  ArticleView.get "文章頁"  [1]  #auth  #core  (note)'), out);
    const m = store().symbols[0];
    assert.deepStrictEqual(
      [m.file, m.path, m.kind, m.favorite, m.alias, m.note, m.tags, m.number, m.line],
      ['app/views.py', 'ArticleView.get', 'method', true, '文章頁', '要檢查權限', ['auth', 'core'], 1, 4],
    );
    assert.ok(read('.git/info/exclude').includes('.vscode/function-bookmarks.json'));

    const miss = await fb('add', 'views.py#ArticleView.put');
    assert.strictEqual(miss.code, 1);
    assert.ok(miss.err.includes('fb functions app/views.py'), miss.err);
  });

  it('依行號加書籤：函式名稱那一行加成函式書籤（同編輯器），--line 強制行號書籤；同一行不重複；號碼不能重複', async () => {
    await ok('add', 'views.py:13');
    assert.strictEqual(store().symbols[0].path, 'helper');
    await ok('add', 'views.py:6', '--label', '讀文章', '--number', '2');
    await ok('add', 'views.py:13', '--line');
    const bms = store().bookmarks;
    assert.deepStrictEqual(
      bms.map((b) => [b.line, b.label, b.number, b.anchor?.text, b.anchor?.symbolPath]),
      [
        [5, '讀文章', 2, 'article = load(request)', 'ArticleView.get'],
        [12, undefined, undefined, 'def helper(payload):', 'helper'],
      ],
    );
    const dup = await fb('add', 'views.py:6');
    assert.ok(dup.code !== 0 && dup.err.includes('already has a bookmark'));
    const taken = await fb('add', 'views.py:14', '--number', '2');
    assert.ok(taken.code !== 0 && taken.err.includes('Number 2 is already used by'), taken.err);
    const outOfRange = await fb('add', 'views.py:99');
    assert.ok(outOfRange.code !== 0 && outOfRange.err.includes('line 99 does not exist'));
  });

  it('list、show：目前位置、號碼、標籤、備註與程式碼；依號碼、id、檔案#函式、檔案:行號都找得到', async () => {
    await ok('add', 'views.py#helper', '--number', '1', '--note', '- 解析\n- 回傳');
    await ok('add', 'views.py:6', '--label', '讀文章', '--tags', 'core');
    const list = await ok('list');
    assert.deepStrictEqual(
      list.trim().split('\n').map((l) => l.split('  ').slice(0, 3).join(' | ')),
      ['app/views.py:6 | line | "讀文章"', 'app/views.py:13 | function | helper'],
    );
    assert.ok((await ok('list', '--tag', 'core')).includes('讀文章'));
    assert.ok(!(await ok('list', '--tag', 'core')).includes('helper'));
    assert.ok((await ok('list', '--query', '解析')).includes('helper'), '搜尋也比對備註');

    const shown = await ok('show', '1');
    assert.ok(shown.includes('Note:\n- 解析\n- 回傳'));
    assert.ok(shown.includes('Code (from line 13):\ndef helper(payload):\n    data = parse(payload)\n    return data'), shown);
    const id = store().bookmarks[0].id;
    for (const ref of [id, 'views.py:6', 'app/views.py:6']) {
      assert.ok((await ok('show', ref)).includes('讀文章'), ref);
    }
    assert.ok((await ok('show', 'app/views.py#helper')).includes('helper'));
    const json = JSON.parse(await ok('show', 'views.py:6', '--json'));
    assert.deepStrictEqual([json.kind, json.line, json.name, json.codeStartLine], ['line', 6, '讀文章', 3]);
  });

  it('程式碼改過（編輯器沒開）：函式依名稱、行號書籤依記得的內容找到新位置；內容不見了標需確認', async () => {
    await ok('add', 'views.py#ArticleView.post');
    await ok('add', 'views.py:6', '--label', '讀文章');
    await ok('add', 'views.py:14', '--label', '解析');
    write('app/views.py', ['# header', '# more', ...PY.slice(0, 13), '    return payload'].join('\n') + '\n');
    const rows = JSON.parse(await ok('list', '--json')) as { name?: string; function?: string; line: number; status?: string }[];
    assert.deepStrictEqual(
      rows.map((r) => [r.name ?? r.function, r.line, r.status]),
      [
        ['讀文章', 8, undefined],
        ['ArticleView.post', 11, undefined],
        ['解析', 14, 'needs checking'],
      ],
    );
    fs.rmSync(path.join(root, 'app', 'views.py'));
    const gone = JSON.parse(await ok('list', '--json')) as { status?: string }[];
    assert.deepStrictEqual(gone.map((r) => r.status), ['needs checking', 'file not found', 'needs checking']);
  });

  it('set：名稱、備註（取代與附加）、標籤增減、號碼（0 移除）；remove', async () => {
    await ok('add', 'views.py#helper', '--label', 'A');
    await ok('add', 'views.py:6');
    await ok('set', 'views.py#helper', '--label', 'B', '--note', '第一段', '--number', '3', '--tags', 'x,y');
    await ok('set', 'views.py#helper', '--append-note', '第二段', '--add-tag', 'z', '--remove-tag', 'x');
    let m = store().symbols[0];
    assert.deepStrictEqual([m.alias, m.note, m.tags, m.number], ['B', '第一段\n\n第二段', ['y', 'z'], 3]);
    await ok('set', '3', '--label', '', '--number', '0');
    m = store().symbols[0];
    assert.deepStrictEqual([m.alias, m.number], [undefined, undefined]);

    await ok('set', 'views.py:6', '--label', '讀文章', '--note', 'n', '--number', '3');
    assert.deepStrictEqual([store().bookmarks[0].label, store().bookmarks[0].note, store().bookmarks[0].number], ['讀文章', 'n', 3]);
    await ok('set', 'views.py:6', '--note', '');
    assert.strictEqual(store().bookmarks[0].note, undefined);

    await ok('remove', 'views.py:6');
    assert.strictEqual(store().bookmarks.length, 0);
    await ok('remove', 'views.py#helper');
    assert.ok(!store().symbols.some((s) => s.favorite), '函式書籤取消收藏（與編輯器相同）');
    const missing = await fb('remove', 'views.py:6');
    assert.ok(missing.code !== 0 && missing.err.includes('No bookmark matches'));
  });

  it('guide：有編號的在前、附備註與程式碼；--no-code 不含程式碼', async () => {
    await ok('add', 'views.py#helper', '--number', '2', '--note', '最後解析');
    await ok('add', 'views.py#ArticleView.get', '--number', '1', '--label', '入口');
    await ok('add', 'views.py:10', '--label', '存檔');
    const md = await ok('guide');
    assert.ok(md.indexOf('## 1. 入口') < md.indexOf('## 2. helper'));
    assert.ok(md.indexOf('## 2. helper') < md.indexOf('## 存檔'));
    assert.ok(md.includes('```python\ndef helper(payload):'));
    assert.ok(md.includes('最後解析'));
    assert.ok(!(await ok('guide', '--no-code')).includes('```'));
  });

  it('functions：列出偵測到的函式與是否已加書籤；沒有內建規則的檔案說明改用行號書籤', async () => {
    await ok('add', 'views.py#helper');
    const out = await ok('functions', 'views.py');
    assert.ok(out.includes('class ArticleView  lines 4-10'), out);
    assert.ok(out.includes('  method ArticleView.get  lines 5-7'));
    assert.ok(out.includes('function helper  lines 13-15  [bookmarked]'));
    const unknown = await fb('functions', 'notes.unknownext');
    assert.ok(unknown.code !== 0 && unknown.err.includes('--line'), unknown.err);
  });

  it('settings.json（含註解）的自訂規則與停用規則也會套用', async () => {
    write(
      '.vscode/settings.json',
      [
        '{',
        '  // 自訂：全大寫的常數列成 block',
        '  "functionBookmarks.detection.rules": [',
        '    { "id": "const", "languages": ["python"], "pattern": "^(?<name>[A-Z_]{3,})\\\\s*=", "kind": "block", "body": "statement" },',
        '  ],',
        '  "functionBookmarks.detection.disabledRules": ["py-class", "py-method"],',
        '}',
      ].join('\n'),
    );
    write('app/views.py', ['ROUTES = []', ...PY].join('\n'));
    const out = await ok('functions', 'views.py');
    assert.ok(out.includes('block ROUTES'), out);
    assert.ok(!out.includes('ArticleView'), '停用的規則不套用');
  });

  it('保護：書籤檔壞掉時不寫入；書籤存在編輯器內部時拒絕修改；專案外的路徑', async () => {
    write('.vscode/function-bookmarks.json', '{ oops');
    const broken = await fb('add', 'views.py#helper');
    assert.strictEqual(broken.code, 2);
    assert.strictEqual(read('.vscode/function-bookmarks.json'), '{ oops', '壞掉的檔案保持原樣');

    write('.vscode/function-bookmarks.json', '{"version":1,"symbols":[]}');
    write('.vscode/settings.json', '{ "functionBookmarks.storage": "workspaceState" }');
    const inEditor = await fb('add', 'views.py#helper');
    assert.strictEqual(inEditor.code, 3);
    assert.ok((await ok('info')).includes('stores bookmarks inside the editor'));

    fs.rmSync(path.join(root, '.vscode', 'settings.json'));
    const outside = await fb('add', path.join(os.tmpdir(), 'x.py:1'));
    assert.ok(outside.code !== 0 && outside.err.includes('outside the project'), outside.err);
  });
});
