import * as assert from 'assert';
import { LineBookmark } from '../../src/bookmarks/model';
import { parseGitConfig } from '../../src/git/branch';
import { emptyStore } from '../../src/storage/marks';
import {
  applyImport,
  decodeHashes,
  encodeHashes,
  existingCounts,
  extractFunctionSnippet,
  extractLineSnippet,
  normalizeRemote,
  parseExport,
  sortGuideEntries,
  toCsv,
  toGuideMarkdown,
  toMarkdown,
} from '../../src/share/format';

const src = (author: string, originalId: string) => ({ author, importId: 'i1', originalId, importedAt: '2026-11-22T00:00:00Z' });

describe('匯出與匯入書籤：格式', () => {
  it('行雜湊壓縮成 base64 再還原', () => {
    const h = [0, 1, 0xffffffff, 0x811c9dc5, 123456789];
    assert.deepStrictEqual(decodeHashes(encodeHashes(h)), h);
    assert.strictEqual(decodeHashes('abc'), undefined, '長度不是 4 的倍數');
  });

  it('remote 網址：https、ssh、帳號、.git 結尾都視為同一個', () => {
    const want = 'github.com/whlshy/function-bookmarks';
    for (const u of [
      'https://github.com/whlshy/function-bookmarks.git',
      'git@github.com:whlshy/function-bookmarks.git',
      'ssh://git@github.com/whlshy/function-bookmarks',
      'https://user@GitHub.com/whlshy/function-bookmarks/',
    ]) {
      assert.strictEqual(normalizeRemote(u), want, u);
    }
    assert.strictEqual(normalizeRemote(undefined), undefined);
  });

  it('讀取匯出檔：檢查格式、略過壞掉的項目與工作區外的路徑', () => {
    assert.deepStrictEqual(parseExport('{'), { error: 'json' });
    assert.deepStrictEqual(parseExport('{"format":"other","bookmarks":[]}'), { error: 'format' });
    const r = parseExport(
      JSON.stringify({
        format: 'function-bookmarks/v1',
        exportedBy: ' alex.chen ',
        repo: { remote: 'x', commit: 'abc' },
        files: { 'app\\views.py': { hashes: 'AAAAAA==' } },
        bookmarks: [
          {
            kind: 'line',
            id: 'a',
            file: 'app/views.py',
            line: 3,
            label: '登入',
            tags: ['auth', ''],
            createdAt: '2026-11-27T06:01:00.000Z',
            anchor: { text: 'x = 1', before: [], after: [] },
          },
          {
            kind: 'symbol',
            id: 'b',
            file: 'app/views.py',
            line: 10,
            path: 'ArticleView.get',
            symbolKind: 'method',
            createdAt: '2026-11-27T06:02:00.000Z',
          },
          { kind: 'line', id: 'c', file: '../secret.py', line: 1 },
          { kind: 'line', id: 'd', file: 'a.py', line: -1 },
          null,
        ],
      }),
    );
    assert.ok(!('error' in r));
    if ('error' in r) {
      return;
    }
    assert.strictEqual(r.exportedBy, 'alex.chen');
    assert.strictEqual(r.includesCode, true);
    assert.deepStrictEqual(Object.keys(r.files!), ['app/views.py']);
    assert.deepStrictEqual(
      r.bookmarks.map((b) => [b.id, b.kind, b.line, b.tags, b.path, b.createdAt]),
      [
        ['a', 'line', 3, ['auth'], undefined, '2026-11-27T06:01:00.000Z'],
        ['b', 'symbol', 10, undefined, 'ArticleView.get', '2026-11-27T06:02:00.000Z'],
      ],
    );
  });
});

describe('匯出與匯入書籤：取代與合併', () => {
  const mine: LineBookmark = { id: 'm1', file: 'a.py', line: 1 };
  const old1: LineBookmark = { id: 'x1', file: 'a.py', line: 5, label: '舊', source: src('alex.chen', 'h1'), positions: { main: { line: 4 } } };
  const old2: LineBookmark = { id: 'x2', file: 'a.py', line: 9, source: src('alex.chen', 'h2') };
  const amy: LineBookmark = { id: 'y1', file: 'a.py', line: 7, source: src('amy.lin', 'a1') };
  const data = { ...emptyStore(), bookmarks: [mine, old1, old2, amy] };
  const incoming: LineBookmark[] = [
    { id: 'n1', file: 'a.py', line: 6, label: '新', source: src('alex.chen', 'h1') },
    { id: 'n3', file: 'b.py', line: 0, source: src('alex.chen', 'h3') },
  ];

  it('取代：同來源舊的刪掉換成新的，自己的與其他來源不動', () => {
    const r = applyImport(data, incoming, 'replace');
    assert.deepStrictEqual(r.bookmarks.map((b) => b.id), ['m1', 'y1', 'n1', 'n3']);
  });

  it('合併：同一筆（原始 id）更新並沿用本機 id 與分支紀錄，新的加入，沒出現的保留', () => {
    const r = applyImport(data, incoming, 'merge');
    assert.deepStrictEqual(r.bookmarks.map((b) => [b.id, b.label, b.line]), [
      ['m1', undefined, 1],
      ['x1', '新', 6],
      ['x2', undefined, 9],
      ['y1', undefined, 7],
      ['n3', undefined, 0],
    ]);
    assert.deepStrictEqual(r.bookmarks[1].positions, { main: { line: 4 } });
  });

  it('預覽：各來源之前匯入過幾筆', () => {
    assert.deepStrictEqual([...existingCounts(data, ['alex.chen', 'nobody'])], [['alex.chen', 2]]);
  });
});

describe('匯出成 Markdown／CSV', () => {
  const labels = { file: 'File', line: 'Line', name: 'Name', kind: 'Kind', tags: 'Tags', note: 'Note', code: 'Code', source: 'Source', fn: 'function', lineKind: 'line' };
  const rows = [
    { file: 'app/views.py', line: 12, name: 'a|b', kind: 'line' as const, tags: ['auth'], note: '第一行\n第二行', code: 'x = "1", y', source: 'alex.chen' },
    { file: 'app/views.py', line: 20, name: 'get', kind: 'symbol' as const, tags: [] },
  ];

  it('Markdown：跳脫 |、換行改 <br>，有程式碼與來源時才多兩欄', () => {
    const md = toMarkdown(rows, labels);
    assert.ok(md.startsWith('| File | Line | Name | Tags | Note | Code | Source |'));
    assert.ok(md.includes('| app/views.py | 12 | a\\|b | #auth | 第一行<br>第二行 | `x = "1", y` | alex.chen |'));
    assert.ok(md.includes('| get (function) |'));
    assert.ok(!toMarkdown([rows[1]], labels).includes('Code'));
  });

  it('CSV：BOM、需要時加引號、雙引號跳脫', () => {
    const csv = toCsv(rows, labels);
    assert.ok(csv.startsWith('﻿File,Line,Name,Kind,Tags,Note,Code,Source\r\n'));
    assert.ok(csv.includes('app/views.py,12,a|b,line,#auth,"第一行\n第二行","x = ""1"", y",alex.chen\r\n'));
    assert.ok(csv.includes('app/views.py,20,get,function,,,,\r\n'));
  });

  it('導讀文件（Markdown）：依編號排序、函式超 30 行截斷、行號取前後 3 行、不含程式碼時省略片段', () => {
    const lines = Array.from({ length: 45 }, (_, i) => `line_${i + 1}`);
    const fnFull = extractFunctionSnippet(lines, 0, 9);
    assert.strictEqual(fnFull?.omittedLines, 0);
    assert.strictEqual(fnFull?.code.split('\n').length, 10);

    const fnCut = extractFunctionSnippet(lines, 0, 39);
    assert.strictEqual(fnCut?.omittedLines, 10);
    assert.strictEqual(fnCut?.code.split('\n').length, 30);

    const lineCtx = extractLineSnippet(lines, 1);
    assert.deepStrictEqual(lineCtx?.code.split('\n'), ['line_1', 'line_2', 'line_3', 'line_4', 'line_5']);

    const ordered = sortGuideEntries([
      { file: 'b.py', line: 10 },
      { number: 3, file: 'z.py', line: 1 },
      { file: 'a.py', line: 2 },
      { number: 1, file: 'm.py', line: 5 },
    ]);
    assert.deepStrictEqual(
      ordered.map((x) => `${x.number ?? '-'}:${x.file}:${x.line}`),
      ['1:m.py:5', '3:z.py:1', '-:a.py:2', '-:b.py:10'],
    );

    const md = toGuideMarkdown(
      [
        { file: 'b.py', line: 2, name: '無編號項目', tags: [], note: '一般備註' },
        {
          number: 2,
          file: 'a.py',
          line: 10,
          name: '第二步',
          tags: ['core'],
          language: 'python',
          snippet: { code: 'def big():\n    return "```"', omittedLines: 5 },
          note: '- 要點一\n- 要點二',
        },
        { number: 1, file: 'z.py', line: 1, name: '第一步', tags: [] },
      ],
      { title: 'Demo — Walkthrough', omittedLabel: (n) => `… (${n} more line(s) omitted)` },
    );
    assert.ok(md.indexOf('## 1. 第一步') < md.indexOf('## 2. 第二步'));
    assert.ok(md.indexOf('## 2. 第二步') < md.indexOf('## 無編號項目'));
    assert.ok(md.includes('`a.py:10` · #core'));
    assert.ok(md.includes('````python\ndef big():\n    return "```"\n````'), '程式碼含三個反引號時自動升級圍欄');
    assert.ok(md.includes('*… (5 more line(s) omitted)*'));
    assert.ok(md.includes('- 要點一\n- 要點二'));
    assert.ok(!md.slice(md.indexOf('## 無編號項目')).includes('```'), '沒有 snippet 時不輸出程式碼區塊');
  });
});

describe('讀取 git 設定檔', () => {
  it('section、子 section、引號、註解', () => {
    const cfg = parseGitConfig('# c\n[user]\n\tname = Alex Chen\n[remote "origin"]\n  url = git@github.com:a/b.git\n[core]\n  bare\n');
    assert.strictEqual(cfg.get('user.name'), 'Alex Chen');
    assert.strictEqual(cfg.get('remote.origin.url'), 'git@github.com:a/b.git');
    assert.strictEqual(cfg.get('core.bare'), 'true');
  });
});
