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
  lastKnownCode,
  normalizeRemote,
  parseExport,
  pickTagColors,
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
    assert.deepStrictEqual(parseExport('﻿{"format":"other","bookmarks":[]}'), { error: 'format' }, '開頭有 BOM 也能解析');
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
  const labels = { file: 'File', line: 'Line', name: 'Name', kind: 'Kind', tags: 'Tags', note: 'Note', code: 'Code', source: 'Source', fn: 'function', lineKind: 'line', status: 'Status' };
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
      { title: 'Demo — Walkthrough', omittedLabel: (n) => `… (${n} more line(s) omitted)`, warningLabel: (st) => st },
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

describe('匯出與匯入書籤：號碼、顏色與標籤顏色', () => {
  const parse = (o: Record<string, unknown>) => {
    const r = parseExport(JSON.stringify({ format: 'function-bookmarks/v1', ...o }));
    assert.ok(!('error' in r));
    return r as Exclude<typeof r, { error: unknown }>;
  };
  const item = (id: string, extra: Record<string, unknown>) => ({ kind: 'line', id, file: 'a.py', line: 1, ...extra });

  it('匯出→解析：保留號碼、顏色與標籤顏色', () => {
    const tagColors = pickTagColors(['auth', 'core', 'auth', 'plain'], new Map([['auth', 'red'], ['core', 'blue'], ['unused', 'green']]));
    assert.deepStrictEqual(tagColors, { auth: 'red', core: 'blue' }, '只帶這批書籤用到、而且有設定顏色的標籤');
    const r = parse({
      tagColors,
      bookmarks: [item('a', { number: 1, color: 'orange' }), item('b', { kind: 'symbol', path: 'get', number: 9, color: 'gray' })],
    });
    assert.deepStrictEqual(r.bookmarks.map((b) => [b.id, b.number, b.color]), [['a', 1, 'orange'], ['b', 9, 'gray']]);
    assert.deepStrictEqual(r.tagColors, { auth: 'red', core: 'blue' });
  });

  it('解析：不合格的號碼與顏色只略過該欄位，書籤保留；舊版匯出檔照常讀取', () => {
    const bad = [{ number: 0, color: 'magenta' }, { number: 10, color: '' }, { number: 1.5, color: 3 }, { number: '2', color: '#F14C4C' }, { number: null, color: null }];
    const r = parse({ bookmarks: bad.map((x, i) => item(`b${i}`, { ...x, label: 'x' })) });
    assert.strictEqual(r.bookmarks.length, bad.length);
    assert.ok(r.bookmarks.every((b) => !('number' in b) && !('color' in b) && b.label === 'x'));

    assert.deepStrictEqual(parse({ bookmarks: [], tagColors: { ok: 'teal', bad: 'nope', num: 1, ' ': 'red' } }).tagColors, { ok: 'teal' });
    for (const tagColors of [undefined, null, 'red', ['red'], { bad: 'nope' }]) {
      assert.ok(!('tagColors' in parse({ bookmarks: [], tagColors })), JSON.stringify(tagColors));
    }
    assert.strictEqual(pickTagColors(['a'], new Map()), undefined);
    assert.strictEqual(pickTagColors(['constructor'], new Map()), undefined);
  });

  it('解析：保留位置不可靠的狀態，不認得的狀態略過', () => {
    const r = parse({
      bookmarks: [
        item('a', { status: 'lost' }),
        item('b', { status: 'notOnBranch' }),
        item('c', { kind: 'symbol', path: 'gone', status: 'missing' }),
        item('d', { kind: 'symbol', path: 'x', status: 'noFile' }),
        item('e', { status: 'weird' }),
        item('f', {}),
      ],
    });
    assert.deepStrictEqual(r.bookmarks.map((b) => [b.id, b.status]), [
      ['a', 'lost'],
      ['b', 'notOnBranch'],
      ['c', 'missing'],
      ['d', 'noFile'],
      ['e', undefined],
      ['f', undefined],
    ]);
  });

  const run = (data: Parameters<typeof applyImport>[0], incoming: LineBookmark[], mode: 'merge' | 'replace', extras: Parameters<typeof applyImport>[3] = {}) => {
    let skipped = 0;
    const out = applyImport(data, incoming, mode, { ...extras, onNumbersSkipped: (n) => (skipped = n) });
    return { out, skipped, rows: out.bookmarks.map((b) => [b.id, b.number, b.color]) };
  };
  const bm = (id: string, extra: Partial<LineBookmark> = {}): LineBookmark => ({ id, file: 'a.py', line: 1, ...extra });
  const from = (id: string, originalId: string, extra: Partial<LineBookmark> = {}) => bm(id, { source: src('alex.chen', originalId), ...extra });

  it('取代：號碼避開自己的書籤、函式書籤、其他來源與其他資料夾；重複的不帶號碼但書籤與顏色保留', () => {
    const data = {
      ...emptyStore(),
      symbols: [
        { file: 'a.py', path: 'f', kind: 'function' as const, favorite: true, number: 2 },
        { file: 'a.py', path: 'g', kind: 'function' as const, alias: '沒加書籤', number: 6 },
      ],
      bookmarks: [bm('mine', { number: 1 }), bm('amy', { number: 3, source: src('amy.lin', 'a') }), from('old', 'h0', { number: 5 })],
    };
    const incoming = [1, 2, 3, 4, 5, 6, 4].map((n, i) => from(`n${i}`, `h${i + 1}`, { number: n, color: 'red' }));
    const r = run(data, incoming, 'replace', { usedNumbers: [4] });
    assert.deepStrictEqual(r.rows, [
      ['mine', 1, undefined],
      ['amy', 3, undefined],
      ['n0', undefined, 'red'],
      ['n1', undefined, 'red'],
      ['n2', undefined, 'red'],
      ['n3', undefined, 'red'],
      ['n4', 5, 'red'], // 舊的同來源書籤移除後，號碼空出來
      ['n5', 6, 'red'], // 沒加書籤的函式不佔號碼
      ['n6', undefined, 'red'],
    ]);
    assert.strictEqual(r.skipped, 5);
    assert.strictEqual(incoming[0].number, 1, '不改動傳入的物件');
  });

  it('取代：匯入檔內部重複的號碼只有第一筆拿到；沒有重複時不回報', () => {
    const dup = run(emptyStore(), [from('a', '1', { number: 7 }), from('b', '2', { number: 7 })], 'replace');
    assert.deepStrictEqual(dup.rows, [['a', 7, undefined], ['b', undefined, undefined]]);
    assert.strictEqual(dup.skipped, 1);
    let called = false;
    applyImport(emptyStore(), [from('a', '1', { number: 7 }), from('b', '2')], 'replace', { onNumbersSkipped: () => (called = true) });
    assert.strictEqual(called, false);
  });

  it('合併：本機的號碼與顏色優先，本機沒有才用匯入的；重複的號碼不帶入', () => {
    const data = {
      ...emptyStore(),
      bookmarks: [
        bm('mine', { number: 1 }),
        from('keep', 'h1', { number: 2, color: 'blue' }),
        from('fill', 'h2'),
        from('clash', 'h3'),
        from('absent', 'h4', { number: 8, color: 'pink' }),
        from('same', 'h5', { number: 9 }),
      ],
    };
    const r = run(
      data,
      [
        from('i1', 'h1', { number: 3, color: 'red' }),
        from('i2', 'h2', { number: 4, color: 'green' }),
        from('i3', 'h3', { number: 1 }),
        from('i5', 'h5', { number: 9 }),
        from('i6', 'h6', { number: 2, color: 'gray' }),
        from('i7', 'h7', { number: 8 }),
        from('i8', 'h8', { number: 3 }),
        from('i9', 'h9', { number: 5 }),
      ],
      'merge',
      { usedNumbers: [5] },
    );
    assert.deepStrictEqual(r.rows, [
      ['mine', 1, undefined],
      ['keep', 2, 'blue'],
      ['fill', 4, 'green'],
      ['clash', undefined, undefined],
      ['absent', 8, 'pink'],
      ['same', 9, undefined],
      ['i6', undefined, 'gray'],
      ['i7', undefined, undefined],
      ['i8', 3, undefined], // h1 保留本機的 2，匯入的 3 沒人用
      ['i9', undefined, undefined],
    ]);
    assert.strictEqual(r.skipped, 4, '本機優先而沒用到的號碼不算重複');
  });

  it('合併：匯入檔沒有號碼與顏色（舊版）時，本機的維持不變', () => {
    const r = run({ ...emptyStore(), bookmarks: [from('x', 'h1', { number: 2, color: 'blue' })] }, [from('n', 'h1')], 'merge');
    assert.deepStrictEqual(r.rows, [['x', 2, 'blue']]);
    assert.strictEqual(r.skipped, 0);
  });

  it('標籤顏色：本機已設定的不覆蓋（含其他資料夾），沒設定的才補上', () => {
    for (const mode of ['merge', 'replace'] as const) {
      const r = applyImport({ ...emptyStore(), tagColors: { auth: 'blue' } }, [from('a', '1')], mode, {
        tagColors: { auth: 'red', core: 'green', other: 'pink', constructor: 'gray' },
        coloredTags: ['auth', 'other'],
      });
      assert.deepStrictEqual(r.tagColors, { auth: 'blue', core: 'green', constructor: 'gray' }, mode);
      const local = applyImport({ ...emptyStore(), tagColors: { auth: 'blue' } }, [], mode, { tagColors: { auth: 'red' } });
      assert.deepStrictEqual(local.tagColors, { auth: 'blue' }, '沒有帶 coloredTags 也不覆蓋這個資料夾的設定');
      assert.ok(!('tagColors' in applyImport(emptyStore(), [from('a', '1')], mode)), '沒有顏色時不多出欄位');
    }
  });
});

describe('匯出位置不可靠的書籤（需確認、不在目前分支、找不到函式或檔案）', () => {
  const anchor = { text: 'old_line()', before: [], after: [] };
  const statuses = ['lost', 'notOnBranch', 'missing', 'noFile'] as const;
  const options = {
    title: 'T',
    omittedLabel: (n: number) => `omitted ${n}`,
    warningLabel: (status: string, hasCode: boolean) => `${status}${hasCode ? ' (last known)' : ''}`,
  };
  const labels = { file: 'File', line: 'Line', name: 'Name', kind: 'Kind', tags: 'Tags', note: 'Note', code: 'Code', source: 'Source', fn: 'function', lineKind: 'line', status: 'Status' };

  it('只有需確認的書籤附上最後記得的那一行', () => {
    assert.deepStrictEqual(statuses.map((s) => lastKnownCode(s, anchor)), ['old_line()', undefined, undefined, undefined]);
    assert.strictEqual(lastKnownCode('lost', undefined), undefined);
    assert.strictEqual(lastKnownCode('lost', { ...anchor, text: '' }), undefined);
  });

  it('導讀文件：警示放在標題下方；沒有片段時只留警示與備註', () => {
    const md = toGuideMarkdown(
      [
        { number: 1, name: 'a', file: 'a.py', line: 1, tags: [], status: 'lost', snippet: { code: 'old_line()', omittedLines: 0 }, language: 'python' },
        { number: 2, name: 'b', file: 'a.py', line: 2, tags: [], status: 'lost' },
        { number: 3, name: 'c', file: 'a.py', line: 3, tags: [], status: 'notOnBranch', note: '備註 c' },
        { number: 4, name: 'd', file: 'a.py', line: 4, tags: [], status: 'missing' },
        { number: 5, name: 'e', file: 'a.py', line: 5, tags: [], status: 'noFile' },
      ],
      options,
    );
    assert.strictEqual(
      md,
      [
        '# T',
        '## 1. a', '> ⚠ lost (last known)', '`a.py:1`', '```python\nold_line()\n```',
        '## 2. b', '> ⚠ lost', '`a.py:2`',
        '## 3. c', '> ⚠ notOnBranch', '`a.py:3`', '備註 c',
        '## 4. d', '> ⚠ missing', '`a.py:4`',
        '## 5. e', '> ⚠ noFile', '`a.py:5`',
      ].join('\n\n') + '\n',
    );
  });

  const ok = { file: 'a.py', line: 1, name: 'ok', kind: 'line' as const, tags: [], code: 'x = 1' };
  const bad = { file: 'a.py', line: 2, name: 'bad', kind: 'symbol' as const, tags: [], code: '', status: '需|確認,x' };

  it('表格與 CSV：任何一筆有狀態才多一欄，其他列留空', () => {
    assert.strictEqual(
      toMarkdown([ok, bad], labels),
      '| File | Line | Name | Tags | Note | Code | Status |\n|---|---|---|---|---|---|---|\n' +
        '| a.py | 1 | ok |  |  | `x = 1` |  |\n| a.py | 2 | bad (function) |  |  |  | 需\\|確認,x |\n',
    );
    assert.strictEqual(
      toCsv([ok, bad], labels),
      '﻿File,Line,Name,Kind,Tags,Note,Code,Source,Status\r\n' +
        'a.py,1,ok,line,,,x = 1,,\r\na.py,2,bad,function,,,,,"需|確認,x"\r\n',
    );
    const noCode = { file: 'a.py', line: 2, name: 'bad', kind: 'line' as const, tags: [], status: 'gone' };
    assert.ok(toMarkdown([noCode], labels).startsWith('| File | Line | Name | Tags | Note | Status |\n'), '不含程式碼時');
    assert.ok(toCsv([noCode], labels).startsWith('﻿File,Line,Name,Kind,Tags,Note,Source,Status\r\n'));
  });

  it('沒有狀態時輸出和原本完全相同', () => {
    assert.strictEqual(toMarkdown([ok], labels), '| File | Line | Name | Tags | Note | Code |\n|---|---|---|---|---|---|\n| a.py | 1 | ok |  |  | `x = 1` |\n');
    assert.strictEqual(toCsv([ok], labels), '﻿File,Line,Name,Kind,Tags,Note,Code,Source\r\na.py,1,ok,line,,,x = 1,\r\n');
    assert.strictEqual(
      toGuideMarkdown([{ number: 1, name: 'ok', file: 'a.py', line: 1, tags: ['t'], note: 'n', snippet: { code: 'x = 1', omittedLines: 2 } }], options),
      '# T\n\n## 1. ok\n\n`a.py:1` · #t\n\n```\nx = 1\n```\n\n*omitted 2*\n\nn\n',
    );
  });
});

