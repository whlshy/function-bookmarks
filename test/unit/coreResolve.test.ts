import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { makeAnchor } from '../../src/bookmarks/model';
import { checkLineBookmarks, detectWithRules, favoriteLineUpdates, resolveFavorite, rulesCover, syncFileMarks } from '../../src/core/resolve';
import { settingsFrom } from '../../src/core/settings';
import { readerFromSettings } from '../../src/core/settingsFile';
import { decodeStoreText, storeTextToWrite } from '../../src/core/storeFile';
import { addBookmark, emptyStore, findMark, serializeStore, setFavorite } from '../../src/storage/marks';

const ROOT = path.resolve(__dirname, '../../..');

/** 從某個檔案出發，沿相對路徑的 import 走訪所有依賴，回傳引用了 vscode 的檔案。 */
function filesImportingVscode(entry: string): string[] {
  const seen = new Set<string>();
  const bad: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec === 'vscode') {
        bad.push(path.relative(ROOT, file).replace(/\\/g, '/'));
      } else if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(file), spec);
        const target = [`${base}.ts`, path.join(base, 'index.ts')].find((p) => fs.existsSync(p));
        if (target) {
          visit(target);
        }
      }
    }
  };
  visit(entry);
  return bad;
}

describe('共用核心：不依賴編輯器', () => {
  it('src/core 底下每個檔案（含間接引用）都沒有引用 vscode，CLI 才能在編輯器外執行', () => {
    const dir = path.join(ROOT, 'src', 'core');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 4);
    for (const f of files) {
      assert.deepStrictEqual(filesImportingVscode(path.join(dir, f)), [], f);
    }
    assert.deepStrictEqual(filesImportingVscode(path.join(ROOT, 'src', 'cli', 'main.ts')), [], 'CLI 進入點');
  });
});

describe('共用核心：偵測與書籤位置', () => {
  const settings = settingsFrom(readerFromSettings(undefined));
  const PY = ['import os', '', 'class View:', '    def get(self):', '        return 1', '', 'def helper():', '    pass'];
  const symbols = detectWithRules(PY.join('\n'), 'python', settings, 'app/views.py', '/w/app/views.py').symbols;

  it('用規則偵測檔案；規則能不能涵蓋這個語言', () => {
    assert.deepStrictEqual(
      symbols.map((s) => [s.path, s.nameLine]),
      [
        ['View', 2],
        ['helper', 6],
      ],
    );
    assert.strictEqual(symbols[0].children[0].path, 'View.get');
    assert.ok(rulesCover(settings, 'python', 'a.py', '/w/a.py'));
    assert.ok(!rulesCover(settings, undefined, 'Makefile', '/w/Makefile'));
    assert.ok(!rulesCover({ ...settings, source: 'languageServer' }, 'python', 'a.py', '/w/a.py'));
  });

  it('函式書籤：找得到、找不到函式、讀不到檔案；行號不同時要更新', () => {
    assert.strictEqual(resolveFavorite({ path: 'View.get', kind: 'method' }, symbols).symbol?.nameLine, 3);
    assert.deepStrictEqual(resolveFavorite({ path: 'gone', kind: 'function' }, symbols), { status: 'missing' });
    assert.deepStrictEqual(resolveFavorite({ path: 'helper', kind: 'function' }, undefined), { status: 'noFile' });
    const resolved = [
      { mark: { file: 'a.py', path: 'helper', kind: 'function' as const, line: 1 }, symbol: symbols[1] },
      { mark: { file: 'a.py', path: 'View', kind: 'class' as const, line: 2 }, symbol: symbols[0] },
      { mark: { file: 'a.py', path: 'gone', kind: 'function' as const, line: 9 } },
    ];
    assert.deepStrictEqual(
      favoriteLineUpdates(resolved).map((u) => [u.item.mark.path, u.line]),
      [['helper', 6]],
    );
  });

  it('整理一個檔案的函式書籤：改名接回、更新最後已知行號；沒變化回傳原物件', () => {
    let data = setFavorite(emptyStore(), { file: 'app/views.py', path: 'helper', kind: 'function' }, true, 1);
    data = setFavorite(data, { file: 'app/views.py', path: 'old_name', kind: 'function' }, true, 6);
    const next = syncFileMarks(data, 'app/views.py', symbols);
    assert.strictEqual(findMark(next, { file: 'app/views.py', path: 'helper', kind: 'function' })?.line, 6);
    const synced = syncFileMarks(next, 'app/views.py', symbols);
    assert.strictEqual(synced, next, '已經是最新就回傳同一個物件');
  });

  it('行號書籤：內容相同不動、搬家了找回來、找不到標需確認、沒有記得內容只限制範圍', () => {
    const old = ['a = 1', 'b = 2', 'target_line()', 'c = 3'];
    const now = ['x = 0', 'a = 1', 'b = 2', 'target_line()', 'c = 3'];
    const r = checkLineBookmarks(
      [
        { id: 'same', line: 1, anchor: makeAnchor(now, 1) },
        { id: 'moved', line: 2, anchor: makeAnchor(old, 2) },
        { id: 'gone', line: 0, anchor: { text: 'deleted_call()', before: [], after: [] } },
        { id: 'plain', line: 99 },
      ],
      now,
    );
    assert.deepStrictEqual(r, [
      { id: 'same', line: 1 },
      { id: 'moved', line: 3 },
      { id: 'gone', line: 0, status: 'lost' },
      { id: 'plain', line: 4 },
    ]);
  });
});

describe('共用核心：書籤檔', () => {
  it('判讀：沒有檔案或空白、壞掉、正常', () => {
    assert.strictEqual(decodeStoreText(undefined).kind, 'empty');
    assert.strictEqual(decodeStoreText('  \n').kind, 'empty');
    assert.strictEqual(decodeStoreText('{oops').kind, 'broken');
    const data = addBookmark(emptyStore(), { id: 'a', file: 'x.py', line: 3 });
    const r = decodeStoreText(`﻿${serializeStore(data)}`);
    assert.ok(r.kind === 'ok' && r.data.bookmarks.length === 1, '開頭有 BOM 也能讀');
  });

  it('寫入：沒有資料且檔案不存在時不建立；檔案存在時寫入空清單', () => {
    assert.strictEqual(storeTextToWrite(emptyStore(), false), undefined);
    assert.strictEqual(storeTextToWrite(emptyStore(), true), serializeStore(emptyStore()));
    const data = addBookmark(emptyStore(), { id: 'a', file: 'x.py', line: 3 });
    assert.strictEqual(storeTextToWrite(data, false), serializeStore(data));
  });
});
