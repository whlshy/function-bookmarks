import * as assert from 'assert';
import { highlightRanges, isEmptyQuery, matchesQuery, parseQuery, SearchFields } from '../../src/bookmarks/filter';

/** 測試用的書籤欄位；沒給的欄位當成空的。 */
function fields(over: Partial<SearchFields> = {}): SearchFields {
  return { names: [], tags: [], author: '', file: '', ...over };
}

const matches = (query: string, f: SearchFields) => matchesQuery(parseQuery(query), f);

describe('搜尋列：parseQuery／isEmptyQuery', () => {
  it('一般文字轉小寫，空白（含多個空白、tab）隔開成多個字', () => {
    assert.deepStrictEqual(parseQuery('Login   Form\tView'), { text: ['login', 'form', 'view'], tags: [], authors: [] });
  });

  it('#開頭是標籤、@開頭是來源，都去掉符號並轉小寫', () => {
    assert.deepStrictEqual(parseQuery('foo #Auth @Alex.Chen #todo'), {
      text: ['foo'],
      tags: ['auth', 'todo'],
      authors: ['alex.chen'],
    });
  });

  it('單獨一個 # 或 @ 忽略', () => {
    assert.deepStrictEqual(parseQuery('# @ foo'), { text: ['foo'], tags: [], authors: [] });
    assert.deepStrictEqual(parseQuery('#'), { text: [], tags: [], authors: [] });
  });

  it('只有中間或結尾的 # 不算標籤', () => {
    assert.deepStrictEqual(parseQuery('a#b c@d'), { text: ['a#b', 'c@d'], tags: [], authors: [] });
  });

  it('前後空白去掉；空字串、全空白都是空的搜尋', () => {
    assert.deepStrictEqual(parseQuery('  foo  '), { text: ['foo'], tags: [], authors: [] });
    assert.strictEqual(isEmptyQuery(parseQuery('')), true);
    assert.strictEqual(isEmptyQuery(parseQuery('   \t ')), true);
  });

  it('只有單獨的 # 或 @ 也算空的搜尋', () => {
    assert.strictEqual(isEmptyQuery(parseQuery('#')), true);
    assert.strictEqual(isEmptyQuery(parseQuery('@ #')), true);
  });

  it('文字、標籤、來源任何一種有內容就不是空的', () => {
    assert.strictEqual(isEmptyQuery(parseQuery('a')), false);
    assert.strictEqual(isEmptyQuery(parseQuery('#a')), false);
    assert.strictEqual(isEmptyQuery(parseQuery('@a')), false);
  });

  it('中文字串照常解析', () => {
    assert.deepStrictEqual(parseQuery('登入 #待修 @小明'), { text: ['登入'], tags: ['待修'], authors: ['小明'] });
  });
});

describe('搜尋列：matchesQuery 一般文字', () => {
  it('空的搜尋符合所有書籤', () => {
    assert.strictEqual(matches('', fields()), true);
    assert.strictEqual(matches('#', fields({ names: ['x'] })), true);
  });

  it('不分大小寫、部分比對', () => {
    const f = fields({ names: ['LoginView'] });
    assert.strictEqual(matches('login', f), true);
    assert.strictEqual(matches('LOGIN', f), true);
    assert.strictEqual(matches('inVi', f), true);
    assert.strictEqual(matches('logout', f), false);
  });

  it('每個欄位都能比對：names、tags、file、func、line、note', () => {
    assert.strictEqual(matches('alpha', fields({ names: ['alpha_name'] })), true, 'names');
    assert.strictEqual(matches('beta', fields({ tags: ['beta_tag'] })), true, 'tags');
    assert.strictEqual(matches('gamma', fields({ file: 'app/gamma_views.py' })), true, 'file');
    assert.strictEqual(matches('delta', fields({ func: 'Outer.delta_method' })), true, 'func');
    assert.strictEqual(matches('epsilon', fields({ line: 'x = epsilon(1)' })), true, 'line');
    assert.strictEqual(matches('zeta', fields({ note: '記得處理 zeta 的情形' })), true, 'note');
  });

  it('names 有多個（自訂名稱底下的原名）時任一個符合即可', () => {
    const f = fields({ names: ['登入入口', 'login_view'] });
    assert.strictEqual(matches('入口', f), true);
    assert.strictEqual(matches('login_v', f), true);
    assert.strictEqual(matches('logout', f), false);
  });

  it('沒有的可選欄位（func、line、note 為 undefined）不會出錯也不會符合', () => {
    const f = fields({ names: ['abc'] });
    assert.strictEqual(matches('x', f), false);
    assert.strictEqual(matches('abc', f), true);
  });

  it('空白隔開的每個字都要符合，且可以分散在不同欄位', () => {
    const f = fields({ names: ['save'], file: 'app/views.py', note: '檢查權限' });
    assert.strictEqual(matches('save views', f), true);
    assert.strictEqual(matches('save 權限', f), true);
    assert.strictEqual(matches('save nothing', f), false);
    assert.strictEqual(matches('nothing save', f), false);
  });

  it('一般文字也會比對標籤文字（不必打 #）', () => {
    assert.strictEqual(matches('auth', fields({ tags: ['auth'] })), true);
  });

  it('一般文字不比對來源（author）', () => {
    assert.strictEqual(matches('alex', fields({ names: ['x'], author: 'alex.chen' })), false);
  });

  it('中文部分比對', () => {
    assert.strictEqual(matches('入口', fields({ names: ['登入入口'] })), true);
    assert.strictEqual(matches('出口', fields({ names: ['登入入口'] })), false);
  });
});

describe('搜尋列：matchesQuery #標籤', () => {
  it('#標籤 只比對標籤，部分比對、不分大小寫', () => {
    const f = fields({ names: ['x'], tags: ['Authentication', 'todo'] });
    assert.strictEqual(matches('#auth', f), true);
    assert.strictEqual(matches('#TODO', f), true);
    assert.strictEqual(matches('#thent', f), true);
    assert.strictEqual(matches('#nope', f), false);
  });

  it('#標籤 不會比對到名稱、檔名、備註等其他欄位', () => {
    const f = fields({ names: ['auth_view'], file: 'auth.py', func: 'auth', line: 'auth()', note: 'auth', tags: [] });
    assert.strictEqual(matches('#auth', f), false);
    assert.strictEqual(matches('auth', f), true, '同樣的字不加 # 就找得到');
  });

  it('多個 #標籤 每個都要有', () => {
    const f = fields({ tags: ['auth', 'todo'] });
    assert.strictEqual(matches('#auth #todo', f), true);
    assert.strictEqual(matches('#auth #todo #other', f), false);
    assert.strictEqual(matches('#auth #other', f), false);
  });

  it('同一個標籤可以同時符合兩個搜尋的 #標籤（各自獨立判斷）', () => {
    assert.strictEqual(matches('#au #auth', fields({ tags: ['auth'] })), true);
  });

  it('沒有標籤的書籤不符合任何 #標籤', () => {
    assert.strictEqual(matches('#a', fields({ names: ['a'] })), false);
  });

  it('#標籤 和一般文字一起：兩者都要符合', () => {
    const f = fields({ names: ['save_article'], tags: ['auth'] });
    assert.strictEqual(matches('save #auth', f), true);
    assert.strictEqual(matches('load #auth', f), false);
    assert.strictEqual(matches('save #todo', f), false);
  });

  it('單獨一個 # 忽略：不影響其他條件', () => {
    assert.strictEqual(matches('# save', fields({ names: ['save'] })), true);
    assert.strictEqual(matches('# save', fields({ names: ['load'] })), false);
  });

  it('中文標籤', () => {
    assert.strictEqual(matches('#待修', fields({ tags: ['待修'] })), true);
    assert.strictEqual(matches('#待', fields({ tags: ['待修'] })), true);
  });
});

describe('搜尋列：matchesQuery @來源', () => {
  it('@來源 只找 author 符合的（部分比對、不分大小寫）', () => {
    const f = fields({ names: ['x'], author: 'Alex.Chen' });
    assert.strictEqual(matches('@alex', f), true);
    assert.strictEqual(matches('@CHEN', f), true);
    assert.strictEqual(matches('@bob', f), false);
  });

  it('自己的書籤（author 為空字串）不會被 @xxx 找到', () => {
    assert.strictEqual(matches('@alex', fields({ names: ['alex'], author: '' })), false);
    assert.strictEqual(matches('@a', fields({ names: ['a'], author: '' })), false);
  });

  it('@來源 不會比對到名稱等其他欄位', () => {
    assert.strictEqual(matches('@alex', fields({ names: ['alex'], file: 'alex.py', note: 'alex', author: 'bob' })), false);
  });

  it('多個 @ 符合任一個即可', () => {
    const f = fields({ author: 'bob' });
    assert.strictEqual(matches('@alex @bob', f), true);
    assert.strictEqual(matches('@alex @carol', f), false);
    assert.strictEqual(matches('@bob @alex', f), true);
  });

  it('@來源 和一般文字、#標籤 一起：全部條件都要符合', () => {
    const f = fields({ names: ['save'], tags: ['auth'], author: 'bob' });
    assert.strictEqual(matches('@bob save #auth', f), true);
    assert.strictEqual(matches('@alex save #auth', f), false);
    assert.strictEqual(matches('@bob load #auth', f), false);
    assert.strictEqual(matches('@bob save #todo', f), false);
  });

  it('單獨一個 @ 忽略：不會把自己的書籤排除掉', () => {
    assert.strictEqual(matches('@ save', fields({ names: ['save'], author: '' })), true);
  });
});

describe('搜尋列：highlightRanges', () => {
  it('同一個字重疊出現也標到（aaa 裡的 aa）', () => {
    assert.deepStrictEqual(highlightRanges('aaa', ['aa']), [[0, 3]]);
    assert.deepStrictEqual(highlightRanges('abababa', ['aba']), [[0, 7]]);
  });

  it('回傳 [開始, 結束) 的位置，不分大小寫', () => {
    assert.deepStrictEqual(highlightRanges('LoginView', ['view']), [[5, 9]]);
    assert.deepStrictEqual(highlightRanges('abcabc', ['bc']), [
      [1, 3],
      [4, 6],
    ]);
  });

  it('沒有符合、沒有搜尋字、空文字都回傳空陣列', () => {
    assert.deepStrictEqual(highlightRanges('abc', ['x']), []);
    assert.deepStrictEqual(highlightRanges('abc', []), []);
    assert.deepStrictEqual(highlightRanges('', ['a']), []);
  });

  it('空的搜尋字忽略（不會無限迴圈）', () => {
    assert.deepStrictEqual(highlightRanges('abc', ['']), []);
    assert.deepStrictEqual(highlightRanges('abc', ['', 'b']), [[1, 2]]);
  });

  it('多個搜尋字的結果依位置排序', () => {
    assert.deepStrictEqual(highlightRanges('save_article', ['article', 'save']), [
      [0, 4],
      [5, 12],
    ]);
  });

  it('重疊的範圍合併', () => {
    assert.deepStrictEqual(highlightRanges('abcdef', ['abcd', 'cdef']), [[0, 6]]);
    assert.deepStrictEqual(highlightRanges('abcdef', ['bcd', 'cd']), [[1, 4]]);
  });

  it('相鄰的範圍合併', () => {
    assert.deepStrictEqual(highlightRanges('abcdef', ['abc', 'def']), [[0, 6]]);
  });

  it('包含關係：大範圍吃掉小範圍', () => {
    assert.deepStrictEqual(highlightRanges('hello world', ['hello world', 'lo w']), [[0, 11]]);
  });

  it('不相鄰也不重疊的範圍分開保留', () => {
    assert.deepStrictEqual(highlightRanges('a-b', ['a', 'b']), [
      [0, 1],
      [2, 3],
    ]);
  });

  it('同一個字出現多次：每一處都標；不重疊的連續出現會合併', () => {
    assert.deepStrictEqual(highlightRanges('aaaa', ['aa']), [[0, 4]]);
    assert.deepStrictEqual(highlightRanges('a_a_a', ['a']), [
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
  });

  it('中文位置正確', () => {
    assert.deepStrictEqual(highlightRanges('登入入口', ['入口']), [[2, 4]]);
  });

  it('轉小寫後長度改變的文字（例如 İ）回傳空陣列', () => {
    assert.strictEqual('İ'.toLowerCase().length, 2, '前提：這個字轉小寫後變長');
    assert.deepStrictEqual(highlightRanges('İstanbul', ['stan']), []);
    assert.deepStrictEqual(highlightRanges('İ', ['i']), []);
  });

  it('highlightRanges 不改動傳入的陣列', () => {
    const terms = ['b', 'a'];
    highlightRanges('ab', terms);
    assert.deepStrictEqual(terms, ['b', 'a']);
  });
});
