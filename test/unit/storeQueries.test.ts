import * as assert from 'assert';
import type * as vscode from 'vscode';
import { LineBookmark } from '../../src/bookmarks/model';
import { emptyStore, StoreData, SymbolMark } from '../../src/storage/marks';
import { HandledOppositeRecords, hashesOfDataMap } from '../../src/storage/storageMode';
import { collectNumbered, collectSources, collectTagColors, collectTags } from '../../src/storage/storeQueries';
import type { BookmarkEntry, FavoriteEntry } from '../../src/storage/store';

const folder = (name: string) => ({ name, index: 0, uri: { toString: () => `file:///${name}` } }) as unknown as vscode.WorkspaceFolder;
const uriOf = (f: vscode.WorkspaceFolder, rel: string) => ({ path: `${f.name}/${rel}` }) as unknown as vscode.Uri;
const line = (b: Partial<LineBookmark>): LineBookmark => ({ id: 'x', file: 'a.ts', line: 0, ...b }) as LineBookmark;
const mark = (m: Partial<SymbolMark>): SymbolMark => ({ file: 'a.ts', path: 'f', kind: 'function', ...m }) as SymbolMark;
const data = (d: Partial<StoreData>): StoreData => ({ ...emptyStore(), ...d });
const from = (author: string) => ({ author, importId: 'i', originalId: 'o', importedAt: '2026-01-01' });

describe('跨資料夾的書籤統計（storeQueries）', () => {
  it('來源：去重、不含自己的、依名稱排序', () => {
    const a = data({ bookmarks: [line({ source: from('bob') }), line({}), line({ source: from('alex') })] });
    const b = data({ bookmarks: [line({ source: from('bob') })] });
    assert.deepStrictEqual(collectSources([a, b]), ['alex', 'bob']);
  });

  it('標籤：行號書籤與函式書籤合併去重並排序', () => {
    const f = folder('w');
    const bms: BookmarkEntry[] = [{ folder: f, uri: uriOf(f, 'a.ts'), bookmark: line({ tags: ['todo', 'api'] }) }];
    const favs: FavoriteEntry[] = [{ folder: f, uri: uriOf(f, 'a.ts'), mark: mark({ tags: ['todo', 'bug'] }) }];
    assert.deepStrictEqual(collectTags(bms, favs), ['api', 'bug', 'todo']);
  });

  it('標籤顏色：同一個標籤以第一個資料夾為準', () => {
    const colors = collectTagColors([
      { folder: folder('a'), data: data({ tagColors: { todo: 'green' } }) },
      { folder: folder('b'), data: undefined },
      { folder: folder('c'), data: data({ tagColors: { todo: 'red', bug: 'blue' } }) },
    ]);
    assert.deepStrictEqual([...colors], [['todo', 'green'], ['bug', 'blue']]);
  });

  it('號碼：行號書籤與函式書籤都算，只算函式書籤（favorite），先出現的優先', () => {
    const a = folder('a');
    const b = folder('b');
    const m = collectNumbered(
      [
        { folder: a, data: data({ bookmarks: [line({ id: 'l1', number: 1 })], symbols: [mark({ path: 'g', number: 2, favorite: true }), mark({ path: 'h', number: 3 })] }) },
        { folder: b, data: data({ bookmarks: [line({ id: 'l2', number: 1, file: 'b.ts' })] }) },
      ],
      uriOf,
    );
    assert.deepStrictEqual([...m.keys()].sort(), [1, 2]);
    const one = m.get(1)!;
    assert.strictEqual(one.kind === 'line' && one.bookmark.id, 'l1');
    assert.strictEqual((one.uri as unknown as { path: string }).path, 'a/a.ts');
    assert.strictEqual(m.get(2)!.kind, 'symbol');
  });
});

describe('已處理過的另一端來源資料（HandledOppositeRecords）', () => {
  const memento = () => {
    const store = new Map<string, unknown>();
    return {
      store,
      keys: () => [...store.keys()],
      get: <T>(k: string) => store.get(k) as T | undefined,
      update: async (k: string, v: unknown) => {
        store.set(k, v);
      },
    } as unknown as vscode.Memento & { store: Map<string, unknown> };
  };

  it('記錄後同一份雜湊算處理過，換存放模式或內容不同就不算；清除後重新提示', async () => {
    const state = memento();
    const r = new HandledOppositeRecords(state);
    await r.mark('file', { f1: 'h1' });
    assert.strictEqual(r.isHandled('f1', 'file', 'h1'), true);
    assert.strictEqual(r.isHandled('f1', 'file', 'h2'), false);
    assert.strictEqual(r.isHandled('f1', 'workspaceState', 'h1'), false);
    await r.clear('file', ['f1']);
    assert.strictEqual(r.isHandled('f1', 'file', 'h1'), false);
  });

  it('沒有東西要記錄、清除後沒變化時不寫入', async () => {
    const state = memento();
    const r = new HandledOppositeRecords(state);
    await r.mark('file', {});
    await r.clear('file');
    assert.strictEqual(state.store.size, 0);
  });

  it('hashesOfDataMap 略過沒有資料的資料夾', () => {
    const map = new Map([
      ['f1', data({ bookmarks: [line({})] })],
      ['f2', emptyStore()],
    ]);
    assert.deepStrictEqual(Object.keys(hashesOfDataMap(map)), ['f1']);
  });
});
