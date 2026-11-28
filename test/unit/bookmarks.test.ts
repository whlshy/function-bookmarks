import * as assert from 'assert';
import {
  applyChanges,
  filterNavigationItems,
  findAvailableTourStep,
  isBlockReplace,
  isWholeDocumentReplace,
  LineChange,
  makeAnchor,
  neighbor,
  parseTags,
  shiftLine,
  suggestName,
  tourCandidateIndices,
} from '../../src/bookmarks/model';
import { matchesQuery, parseQuery } from '../../src/bookmarks/filter';
import { addBookmark, emptyStore, parseStore, removeBookmarks, renamePath, serializeStore, setAlias, setFavorite, updateBookmark } from '../../src/storage/marks';

const ins = (line: number, ch: number, text: string): LineChange => ({ startLine: line, startChar: ch, endLine: line, endChar: ch, text });
const del = (sl: number, sc: number, el: number, ec: number, text = ''): LineChange => ({
  startLine: sl,
  startChar: sc,
  endLine: el,
  endChar: ec,
  text,
});

describe('行號書籤：編輯時平移', () => {
  it('在書籤上方插入行，書籤往下', () => {
    assert.deepStrictEqual(shiftLine(10, ins(3, 5, 'a\nb\n')), { line: 12, deleted: false });
  });

  it('在書籤下方編輯，不變', () => {
    assert.deepStrictEqual(shiftLine(10, ins(11, 0, 'x\n')), { line: 10, deleted: false });
  });

  it('在書籤那一行的行首按 Enter：書籤跟著原內容往下', () => {
    assert.deepStrictEqual(shiftLine(10, ins(10, 0, '\n')), { line: 11, deleted: false });
  });

  it('在書籤那一行的中間或行尾按 Enter：書籤留在原行', () => {
    assert.deepStrictEqual(shiftLine(10, ins(10, 4, '\n')), { line: 10, deleted: false });
  });

  it('游標在縮排後面按 Enter（插入點前只有空白，含自動縮排）：書籤跟著程式碼往下', () => {
    assert.deepStrictEqual(shiftLine(10, { ...ins(10, 4, '\n    '), blankBefore: true }), { line: 11, deleted: false });
    assert.deepStrictEqual(shiftLine(10, { ...ins(10, 1, '\n\t'), blankBefore: true }), { line: 11, deleted: false });
    // 在縮排後面貼上兩行
    assert.deepStrictEqual(shiftLine(10, { ...ins(10, 4, 'a()\n    b()\n    '), blankBefore: true }), { line: 12, deleted: false });
    // 前面只有空白但插入的文字最後不是換行：原本的內容接在插入文字後面，書籤留在原行
    assert.deepStrictEqual(shiftLine(10, { ...ins(10, 4, 'x\ny'), blankBefore: true }), { line: 10, deleted: false });
  });

  it('刪除書籤上方的行，書籤往上', () => {
    assert.deepStrictEqual(shiftLine(10, del(2, 0, 5, 0)), { line: 7, deleted: false });
  });

  it('整行刪除書籤所在的行：移到下一行並標記 deleted', () => {
    // 選取第 9～10 行整行刪除（從 9:0 到 11:0）
    assert.deepStrictEqual(shiftLine(10, del(9, 0, 11, 0)), { line: 9, deleted: true });
  });

  it('刪除範圍剛好結束在書籤行的開頭：書籤那行沒被刪，只是往上', () => {
    assert.deepStrictEqual(shiftLine(10, del(8, 0, 10, 0)), { line: 8, deleted: false });
  });

  it('合併行（在上一行行尾按 Delete）：書籤併到上一行', () => {
    assert.deepStrictEqual(shiftLine(10, del(9, 20, 10, 0)), { line: 9, deleted: false });
  });

  it('多筆編輯（多游標）由下往上套用', () => {
    const r = applyChanges({ line: 10 }, [ins(2, 0, 'a\n'), ins(5, 0, 'b\n'), ins(20, 0, 'c\n')], 'moveToNext');
    assert.deepStrictEqual(r, { line: 12, status: undefined });
  });

  it('onLineDelete：moveToNext／markLost／remove', () => {
    const change = [del(9, 0, 11, 0)];
    assert.deepStrictEqual(applyChanges({ line: 10 }, change, 'moveToNext'), { line: 9, status: undefined });
    assert.deepStrictEqual(applyChanges({ line: 10 }, change, 'markLost'), { line: 9, status: 'lost' });
    assert.strictEqual(applyChanges({ line: 10 }, change, 'remove'), undefined);
  });
});

describe('行號書籤：存檔與讀回', () => {
  it('書籤與函式標記存在同一份檔案，可完整讀回；沒有書籤時不輸出 bookmarks 欄位', () => {
    let d = setFavorite(emptyStore(), { file: 'a.py', path: 'f', kind: 'function' }, true, 1, new Date('2026-11-19T00:00:00Z'));
    assert.ok(!serializeStore(d).includes('bookmarks'));
    d = addBookmark(d, {
      id: 'x1',
      file: 'a.py',
      line: 5,
      label: '登入',
      tags: ['auth'],
      note: 'n',
      anchor: { text: 'login()', before: ['', 'a'], after: ['b', ''], symbolPath: 'f', symbolOffset: 2 },
      createdAt: 't',
    });
    const back = parseStore(serializeStore(d))!;
    assert.deepStrictEqual(back.bookmarks, d.bookmarks);
    assert.strictEqual(back.symbols.length, 1);
  });

  it('修改函式標記不會弄丟書籤；檔案改名時書籤跟著改', () => {
    let d = addBookmark(emptyStore(), { id: 'x1', file: 'app/a.py', line: 1 });
    d = setAlias(d, { file: 'app/a.py', path: 'f', kind: 'function' }, '名', 'f');
    assert.strictEqual(d.bookmarks.length, 1);
    d = renamePath(d, 'app', 'core');
    assert.strictEqual(d.bookmarks[0].file, 'core/a.py');
  });

  it('updateBookmark：沒有變化回傳原物件；回傳 undefined 即刪除', () => {
    const d = addBookmark(emptyStore(), { id: 'x1', file: 'a.py', line: 1 });
    assert.strictEqual(updateBookmark(d, 'x1', (b) => b), d);
    assert.strictEqual(updateBookmark(d, 'x1', (b) => ({ ...b, label: 'L' })).bookmarks[0].label, 'L');
    assert.strictEqual(updateBookmark(d, 'x1', () => undefined).bookmarks.length, 0);
    assert.strictEqual(removeBookmarks(d, ['nope']), d);
  });

  it('整份文件被換掉（git pull、格式化）時不平移', () => {
    assert.ok(isWholeDocumentReplace([del(0, 0, 99, 0, 'x\n'.repeat(120))], 121));
    assert.ok(!isWholeDocumentReplace([del(0, 0, 3, 0)], 97));
    assert.ok(!isWholeDocumentReplace([ins(0, 0, 'x\n'), ins(5, 0, 'y\n')], 102));
  });

  it('多行換成多行（套用 AI 修改、貼上覆蓋、移動行）改用差異換算；打字、單純插入或刪除不算', () => {
    assert.ok(isBlockReplace([del(10, 0, 15, 0, 'a\nb\n')]));
    assert.ok(isBlockReplace([ins(0, 0, 'x\n'), del(3, 0, 5, 0, 'y\n')]));
    assert.ok(!isBlockReplace([del(3, 0, 5, 0)]), '單純刪除');
    assert.ok(!isBlockReplace([ins(3, 0, 'a\nb\n')]), '單純插入');
    assert.ok(!isBlockReplace([del(3, 2, 3, 5, 'abc')]), '同一行內修改');
    assert.ok(!isBlockReplace([del(3, 2, 4, 0, 'abc')]), '合併兩行');
  });
});

describe('行號書籤：其他工具', () => {
  const list = [
    { file: 'b.py', line: 3 },
    { file: 'a.py', line: 10 },
    { file: 'a.py', line: 2 },
  ];

  it('下一個／上一個：跨檔案依序、頭尾相接', () => {
    assert.deepStrictEqual(neighbor(list, 'a.py', 2, 1), { file: 'a.py', line: 10 });
    assert.deepStrictEqual(neighbor(list, 'a.py', 5, 1), { file: 'a.py', line: 10 });
    assert.deepStrictEqual(neighbor(list, 'a.py', 10, 1), { file: 'b.py', line: 3 });
    assert.deepStrictEqual(neighbor(list, 'b.py', 3, 1), { file: 'a.py', line: 2 });
    assert.deepStrictEqual(neighbor(list, 'a.py', 2, -1), { file: 'b.py', line: 3 });
    assert.deepStrictEqual(neighbor(list, 'b.py', 0, -1), { file: 'a.py', line: 10 });
    assert.deepStrictEqual(neighbor(list, undefined, 0, 1), { file: 'a.py', line: 2 });
    assert.strictEqual(neighbor([], 'a.py', 0, 1), undefined);
  });

  it('下一個／上一個：不循環（wrap = false）時到頭尾回傳 undefined', () => {
    assert.deepStrictEqual(neighbor(list, 'a.py', 2, 1, false), { file: 'a.py', line: 10 });
    assert.deepStrictEqual(neighbor(list, 'a.py', 10, 1, false), { file: 'b.py', line: 3 });
    assert.strictEqual(neighbor(list, 'b.py', 3, 1, false), undefined, '在最後一個書籤不再循環');
    assert.strictEqual(neighbor(list, 'b.py', 10, 1, false), undefined, '在最後一個書籤之後不再循環');
    assert.strictEqual(neighbor(list, 'c.py', 0, 1, false), undefined, '在最後一個檔案之後不再循環');

    assert.deepStrictEqual(neighbor(list, 'b.py', 3, -1, false), { file: 'a.py', line: 10 });
    assert.deepStrictEqual(neighbor(list, 'a.py', 10, -1, false), { file: 'a.py', line: 2 });
    assert.strictEqual(neighbor(list, 'a.py', 2, -1, false), undefined, '在第一個書籤不再循環');
    assert.strictEqual(neighbor(list, 'a.py', 0, -1, false), undefined, '在第一個書籤之前不再循環');
    assert.strictEqual(neighbor(list, '0.py', 0, -1, false), undefined, '在第一個檔案之前不再循環');

    assert.deepStrictEqual(neighbor(list, undefined, 0, 1, false), { file: 'a.py', line: 2 }, '沒開檔時從第一個開始');
    assert.deepStrictEqual(neighbor(list, undefined, 0, -1, false), { file: 'b.py', line: 3 }, '沒開檔時往回從最後一個開始');
    assert.strictEqual(neighbor([], 'a.py', 0, 1, false), undefined);

    // 只有一個書籤且游標剛好在上面：循環回傳自己，不循環回傳 undefined
    const single = [{ file: 'a.py', line: 5 }];
    assert.deepStrictEqual(neighbor(single, 'a.py', 5, 1, true), single[0]);
    assert.strictEqual(neighbor(single, 'a.py', 5, 1, false), undefined);
    assert.strictEqual(neighbor(single, 'a.py', 5, -1, false), undefined);
  });

  it('filterNavigationItems：套用側邊欄搜尋與 currentFile 條件，排除無行號並區分空狀態原因', () => {
    type Entry = { file: string; line?: number; name: string; tags: string[] };
    const entries: Entry[] = [
      { file: '000/a.py', line: 1, name: 'auth_login', tags: ['auth'] },
      { file: '000/a.py', line: 8, name: 'render_home', tags: ['ui'] },
      { file: '000/a.py', line: undefined, name: 'missing_auth_fn', tags: ['auth'] },
      { file: '000/b.py', line: 3, name: 'auth_logout', tags: ['auth'] },
    ];
    const matchFor = (query: string) => {
      const q = parseQuery(query);
      return (e: Entry) => matchesQuery(q, { names: [e.name], tags: e.tags, author: '', file: e.file });
    };

    // 無搜尋、all：排除沒有行號的項目
    const all = filterNavigationItems(entries, { fileKey: (e) => e.file });
    assert.strictEqual(all.searchActive, false);
    assert.strictEqual(all.emptyReason, undefined);
    assert.deepStrictEqual(all.items.map((e) => e.name), ['auth_login', 'render_home', 'auth_logout']);

    // 無搜尋、完全沒有書籤
    const none = filterNavigationItems<Entry>([], { fileKey: (e) => e.file });
    assert.deepStrictEqual(none, { items: [], searchActive: false, emptyReason: 'noBookmarks' });

    // 搜尋啟用、all：只留有行號且符合搜尋的項目
    const byTag = filterNavigationItems(entries, { fileKey: (e) => e.file, searchMatch: matchFor('#auth') });
    assert.strictEqual(byTag.searchActive, true);
    assert.strictEqual(byTag.emptyReason, undefined);
    assert.deepStrictEqual(byTag.items.map((e) => e.name), ['auth_login', 'auth_logout']);

    // 搜尋只符合沒有行號的遺失函式：視為沒有可跳的符合書籤
    const onlyMissing = filterNavigationItems(entries, { fileKey: (e) => e.file, searchMatch: matchFor('missing_auth_fn') });
    assert.deepStrictEqual(onlyMissing, { items: [], searchActive: true, emptyReason: 'noMatch' });

    // 搜尋沒有任何符合
    const noHit = filterNavigationItems(entries, { fileKey: (e) => e.file, searchMatch: matchFor('nope') });
    assert.deepStrictEqual(noHit, { items: [], searchActive: true, emptyReason: 'noMatch' });

    // currentFile 未搜尋
    const curFile = filterNavigationItems(entries, { fileKey: (e) => e.file, currentFile: '000/a.py', currentFileOnly: true });
    assert.deepStrictEqual(curFile.items.map((e) => e.name), ['auth_login', 'render_home']);
    const curFileEmpty = filterNavigationItems(entries, { fileKey: (e) => e.file, currentFile: '000/c.py', currentFileOnly: true });
    assert.deepStrictEqual(curFileEmpty, { items: [], searchActive: false, emptyReason: 'noBookmarksInFile' });

    // currentFile 搭配搜尋：兩個條件都要符合
    const both = filterNavigationItems(entries, {
      fileKey: (e) => e.file,
      currentFile: '000/a.py',
      currentFileOnly: true,
      searchMatch: matchFor('#auth'),
    });
    assert.strictEqual(both.searchActive, true);
    assert.deepStrictEqual(both.items.map((e) => e.name), ['auth_login']);

    // currentFile 搭配搜尋：目前檔案有書籤但不符合搜尋 -> noMatch
    const fileHasOther = filterNavigationItems(entries, {
      fileKey: (e) => e.file,
      currentFile: '000/b.py',
      currentFileOnly: true,
      searchMatch: matchFor('#ui'),
    });
    assert.deepStrictEqual(fileHasOther, { items: [], searchActive: true, emptyReason: 'noMatch' });

    // currentFile 搭配搜尋：目前檔案沒有任何書籤，但其他檔案有符合 -> noBookmarksInFile
    const fileHasNoneOtherMatches = filterNavigationItems(entries, {
      fileKey: (e) => e.file,
      currentFile: '000/c.py',
      currentFileOnly: true,
      searchMatch: matchFor('#auth'),
    });
    assert.deepStrictEqual(fileHasNoneOtherMatches, { items: [], searchActive: true, emptyReason: 'noBookmarksInFile' });

    // currentFile 搭配搜尋：整個專案都沒有符合 -> noMatch
    const nowhereMatches = filterNavigationItems(entries, {
      fileKey: (e) => e.file,
      currentFile: '000/c.py',
      currentFileOnly: true,
      searchMatch: matchFor('zzz'),
    });
    assert.deepStrictEqual(nowhereMatches, { items: [], searchActive: true, emptyReason: 'noMatch' });
  });

  it('名稱建議：選取文字 → 游標單字 → 函式名稱 → 該行內容', () => {
    assert.strictEqual(suggestName({ selection: ' user.save() ', word: 'user', symbolName: 'login', lineText: 'x' }), 'user.save()');
    assert.strictEqual(suggestName({ selection: 'a\nb', word: 'user', lineText: 'x' }), 'user');
    assert.strictEqual(suggestName({ symbolName: 'login', lineText: 'x' }), 'login');
    assert.strictEqual(suggestName({ lineText: '    return render(request)  ' }), 'return render(request)');
  });

  it('標籤：空白或逗號分隔，# 可有可無，去除重複', () => {
    assert.deepStrictEqual(parseTags('#auth, api  #auth，待修'), ['auth', 'api', '待修']);
    assert.deepStrictEqual(parseTags('  '), []);
  });

  it('anchor：該行、前後各 2 行、函式內偏移', () => {
    const lines = ['a', ' b ', 'c', 'd', 'e'];
    assert.deepStrictEqual(makeAnchor(lines, 0, 'f', 0), { text: 'a', before: ['', ''], after: ['b', 'c'], symbolPath: 'f', symbolOffset: 0 });
    assert.deepStrictEqual(makeAnchor(lines, 3), { text: 'd', before: ['b', 'c'], after: ['e', ''], symbolPath: undefined, symbolOffset: undefined });
  });

  it('tourCandidateIndices：依方向產生循環候選順序', () => {
    assert.deepStrictEqual(tourCandidateIndices(0, -1, 1), []);
    assert.deepStrictEqual(tourCandidateIndices(3, -1, 1), [0, 1, 2]);
    assert.deepStrictEqual(tourCandidateIndices(3, -1, -1), [2, 1, 0]);
    assert.deepStrictEqual(tourCandidateIndices(3, 0, 1), [1, 2, 0]);
    assert.deepStrictEqual(tourCandidateIndices(3, 2, 1), [0, 1, 2]);
    assert.deepStrictEqual(tourCandidateIndices(3, 2, -1), [1, 0, 2]);
    assert.deepStrictEqual(tourCandidateIndices(3, 0, -1), [2, 1, 0]);
    assert.deepStrictEqual(tourCandidateIndices(1, 0, 1), [0]);
    assert.deepStrictEqual(tourCandidateIndices(1, 0, -1), [0]);
  });

  it('findAvailableTourStep：略過不可用步驟、保留原始索引、全部不可用時回傳 undefined', async () => {
    const steps = [
      { number: 1, ok: true },
      { number: 2, ok: false },
      { number: 3, ok: true },
    ];
    // 正向從第 0 步（#1）出發：略過 #2，跳到 #3（索引 2）
    const next = await findAvailableTourStep(steps, 0, 1, async (s) => s.ok);
    assert.deepStrictEqual(next, { step: steps[2], index: 2 });

    // 反向從第 2 步（#3）出發：略過 #2，跳回 #1（索引 0）
    const prev = await findAvailableTourStep(steps, 2, -1, async (s) => s.ok);
    assert.deepStrictEqual(prev, { step: steps[0], index: 0 });

    // 未定位時從第一或最後開始，遇到不可用往同方向繼續找
    const onlyMiddle = [
      { number: 1, ok: false },
      { number: 2, ok: true },
      { number: 3, ok: false },
    ];
    assert.deepStrictEqual(await findAvailableTourStep(onlyMiddle, -1, 1, (s) => s.ok), { step: onlyMiddle[1], index: 1 });
    assert.deepStrictEqual(await findAvailableTourStep(onlyMiddle, -1, -1, (s) => s.ok), { step: onlyMiddle[1], index: 1 });

    // 全部都不可用：每個步驟只試一次並回傳 undefined
    const tried: number[] = [];
    const none = await findAvailableTourStep(
      [
        { number: 1, ok: false },
        { number: 2, ok: false },
        { number: 3, ok: false },
      ],
      0,
      1,
      (s) => {
        tried.push(s.number);
        return s.ok;
      },
    );
    assert.strictEqual(none, undefined);
    assert.deepStrictEqual(tried, [2, 3, 1]);
  });
});
