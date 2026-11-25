import * as assert from 'assert';
import { addBookmark, emptyStore, parseStoreFileImport, serializeStore, setFavorite, setTagColor } from '../../src/storage/marks';
import {
  clearHandledOppositeSources,
  hashStoreData,
  isOppositeSourceHandled,
  markOppositeSourcesHandled,
  oppositeStorageMode,
  parseStorageOverride,
  resolveStorageMode,
} from '../../src/storage/storageMode';

describe('存放模式解析與來源雜湊已處理紀錄', () => {
  it('這個專案的個別選擇優先於設定，沒有個別選擇時跟隨設定', () => {
    assert.strictEqual(resolveStorageMode('workspaceState', 'file'), 'workspaceState');
    assert.strictEqual(resolveStorageMode('file', 'workspaceState'), 'file');
    assert.strictEqual(resolveStorageMode(undefined, 'file'), 'file');
    assert.strictEqual(resolveStorageMode(undefined, 'workspaceState'), 'workspaceState');
  });

  it('parseStorageOverride 只接受合法值，其餘視為跟隨設定', () => {
    assert.strictEqual(parseStorageOverride('file'), 'file');
    assert.strictEqual(parseStorageOverride('workspaceState'), 'workspaceState');
    assert.strictEqual(parseStorageOverride(undefined), undefined);
    assert.strictEqual(parseStorageOverride('setting'), undefined);
    assert.strictEqual(parseStorageOverride(''), undefined);
    assert.strictEqual(parseStorageOverride(123), undefined);
  });

  it('oppositeStorageMode 正確回傳另一端存放模式', () => {
    assert.strictEqual(oppositeStorageMode('file'), 'workspaceState');
    assert.strictEqual(oppositeStorageMode('workspaceState'), 'file');
  });

  it('hashStoreData：相同語意內容雜湊一致（不受陣列順序影響），內容有變動時雜湊改變', () => {
    let a = addBookmark(emptyStore(), { id: 'b2', file: 'b.py', line: 5, label: 'B' });
    a = addBookmark(a, { id: 'b1', file: 'a.py', line: 1, label: 'A' });
    let b = addBookmark(emptyStore(), { id: 'b1', file: 'a.py', line: 1, label: 'A' });
    b = addBookmark(b, { id: 'b2', file: 'b.py', line: 5, label: 'B' });
    assert.strictEqual(hashStoreData(a), hashStoreData(b));

    const modified = addBookmark(a, { id: 'b3', file: 'c.py', line: 2, label: 'C' });
    assert.notStrictEqual(hashStoreData(a), hashStoreData(modified));
  });

  it('已處理紀錄：相同雜湊視為已處理、來源變動後雜湊不同需再提示；不同資料夾與模式各自獨立', () => {
    const h1 = hashStoreData(addBookmark(emptyStore(), { id: 'b1', file: 'a.py', line: 1 }));
    const h2 = hashStoreData(addBookmark(emptyStore(), { id: 'b2', file: 'a.py', line: 2 }));

    let state = markOppositeSourcesHandled(undefined, 'workspaceState', { folderA: h1 });
    assert.strictEqual(isOppositeSourceHandled(state, 'workspaceState', 'folderA', h1), true);
    assert.strictEqual(isOppositeSourceHandled(state, 'workspaceState', 'folderA', h2), false, '來源內容變更後不應略過');
    assert.strictEqual(isOppositeSourceHandled(state, 'workspaceState', 'folderB', h1), false);
    assert.strictEqual(isOppositeSourceHandled(state, 'file', 'folderA', h1), false);

    // 同時記錄多個資料夾與另一個模式
    state = markOppositeSourcesHandled(state, 'workspaceState', { folderB: h2 });
    state = markOppositeSourcesHandled(state, 'file', { folderA: h1 });
    assert.strictEqual(isOppositeSourceHandled(state, 'workspaceState', 'folderA', h1), true);
    assert.strictEqual(isOppositeSourceHandled(state, 'workspaceState', 'folderB', h2), true);
    assert.strictEqual(isOppositeSourceHandled(state, 'file', 'folderA', h1), true);

    // 舊格式（陣列）不會拋錯，視為尚未處理
    const legacy = { workspaceState: ['folderA'] } as unknown as Parameters<typeof isOppositeSourceHandled>[0];
    assert.strictEqual(isOppositeSourceHandled(legacy, 'workspaceState', 'folderA', h1), false);

    // 只清除指定資料夾
    state = clearHandledOppositeSources(state, 'workspaceState', ['folderA']);
    assert.strictEqual(isOppositeSourceHandled(state, 'workspaceState', 'folderA', h1), false);
    assert.strictEqual(isOppositeSourceHandled(state, 'workspaceState', 'folderB', h2), true);
    assert.strictEqual(isOppositeSourceHandled(state, 'file', 'folderA', h1), true);

    // 清除整個模式（主動切換到該模式時）
    state = clearHandledOppositeSources(state, 'workspaceState');
    assert.strictEqual(isOppositeSourceHandled(state, 'workspaceState', 'folderB', h2), false);
    assert.strictEqual(isOppositeSourceHandled(state, 'file', 'folderA', h1), true);
  });
});

describe('parseStoreFileImport：辨識套件自己的書籤檔格式', () => {
  it('可解析完整的書籤檔，保留自己的書籤、函式標記、他方來源與標籤顏色', () => {
    let d = setFavorite(emptyStore(), { file: 'app/views.py', path: 'index', kind: 'function' }, true, 3);
    d = addBookmark(d, { id: 'mine1', file: 'app/views.py', line: 5, label: '我的書籤' });
    d = addBookmark(d, {
      id: 'colleague1',
      file: 'app/views.py',
      line: 8,
      label: '同事書籤',
      source: { author: 'alex.chen', importId: 'i1', originalId: 'o1', importedAt: '2026-11-25T00:00:00Z' },
    });
    d = setTagColor(d, 'auth', 'blue');

    const parsed = parseStoreFileImport(serializeStore(d));
    assert.ok(parsed);
    assert.strictEqual(parsed.symbols.length, 1);
    assert.strictEqual(parsed.bookmarks.length, 2);
    assert.strictEqual(parsed.bookmarks.find((b) => b.id === 'mine1')?.source, undefined);
    assert.strictEqual(parsed.bookmarks.find((b) => b.id === 'colleague1')?.source?.author, 'alex.chen');
    assert.deepStrictEqual(parsed.tagColors, { auth: 'blue' });
  });

  it('允許空的合法書籤檔與只含 bookmarks 的版本', () => {
    const empty = parseStoreFileImport(JSON.stringify({ version: 1, symbols: [] }));
    assert.deepStrictEqual(empty, emptyStore());
    const bmOnly = parseStoreFileImport(
      JSON.stringify({ version: 1, bookmarks: [{ id: 'b1', file: 'a.py', line: 2 }] }),
    );
    assert.strictEqual(bmOnly?.bookmarks.length, 1);
    assert.strictEqual(bmOnly?.symbols.length, 0);
  });

  it('過濾含 .. 的不安全路徑並正規化路徑分隔符號', () => {
    const parsed = parseStoreFileImport(
      JSON.stringify({
        version: 1,
        symbols: [
          { file: 'app\\views.py', path: 'index', kind: 'function', favorite: true },
          { file: '../secret.py', path: 'bad', kind: 'function', favorite: true },
        ],
        bookmarks: [
          { id: 'ok', file: '/app\\views.py', line: 1 },
          { id: 'bad', file: 'a/../../secret.py', line: 2 },
        ],
      }),
    );
    assert.deepStrictEqual(parsed?.symbols.map((s) => s.file), ['app/views.py']);
    assert.deepStrictEqual(parsed?.bookmarks.map((b) => [b.id, b.file]), [['ok', 'app/views.py']]);
  });

  it('拒絕非書籤檔的 JSON（空物件、package.json、匯出檔、alefragnani 格式、壞掉 JSON）', () => {
    assert.strictEqual(parseStoreFileImport('{'), undefined);
    assert.strictEqual(parseStoreFileImport('[]'), undefined);
    assert.strictEqual(parseStoreFileImport('{}'), undefined);
    assert.strictEqual(parseStoreFileImport(JSON.stringify({ version: 1 })), undefined);
    assert.strictEqual(parseStoreFileImport(JSON.stringify({ name: 'pkg', version: '1.0.0' })), undefined);
    assert.strictEqual(
      parseStoreFileImport(JSON.stringify({ version: 1, format: 'function-bookmarks/v1', bookmarks: [] })),
      undefined,
    );
    assert.strictEqual(
      parseStoreFileImport(JSON.stringify({ files: [{ path: 'a.py', bookmarks: [{ line: 1 }] }] })),
      undefined,
    );
    assert.strictEqual(
      parseStoreFileImport(JSON.stringify({ bookmarks: [{ path: 'a.py', bookmarks: [1] }] })),
      undefined,
    );
    assert.strictEqual(
      parseStoreFileImport(JSON.stringify({ version: 1, symbols: [], tagColors: ['not-object'] })),
      undefined,
    );
  });
});
