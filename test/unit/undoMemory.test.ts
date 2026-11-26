import * as assert from 'assert';
import { DeletionMemory, isUndoOf } from '../../src/bookmarks/undoMemory';
import type { LineChange } from '../../src/bookmarks/model';

const change = (startLine: number, startChar: number, endLine: number, endChar: number, text = ''): LineChange => ({
  startLine,
  startChar,
  endLine,
  endChar,
  text,
});

describe('復原刪行的紀錄（undoMemory）', () => {
  it('在同一個位置插回同樣行數，才算復原這次刪行', () => {
    const del = change(9, 0, 10, 0);
    assert.ok(isUndoOf(change(9, 0, 9, 0, 'const tax = 1;\n'), del));
    assert.ok(!isUndoOf(change(9, 0, 9, 0, 'a\nb\n'), del), '行數不同');
    assert.ok(!isUndoOf(change(8, 0, 8, 0, 'x\n'), del), '位置不同');
    assert.ok(!isUndoOf(change(9, 0, 9, 3, 'x\n'), del), '不是單純插入');
    assert.ok(!isUndoOf(change(9, 0, 9, 0, 'x\n'), change(9, 0, 9, 5)), '原本不是刪行');
  });

  it('從行尾選到下一段行尾的刪除，也能比對', () => {
    const del = change(8, 12, 10, 7);
    assert.ok(isUndoOf(change(8, 12, 8, 12, '\nline9\nline10'), del));
  });

  it('取出最近一筆符合的紀錄，並丟掉比它新的紀錄', () => {
    const memory = new DeletionMemory();
    const moved = [{ id: 'a', line: 9, afterLine: 9 }];
    memory.remember('f', { change: change(9, 0, 10, 0), moved, removed: [] });
    memory.remember('f', { change: change(3, 0, 4, 0), moved, removed: [] });
    assert.strictEqual(memory.takeUndo('f', change(9, 0, 9, 0, 'x\n'))?.change.startLine, 9);
    assert.strictEqual(memory.takeUndo('f', change(3, 0, 3, 0, 'x\n')), undefined, '較新的紀錄已一併丟掉');
  });

  it('沒有影響任何書籤的刪行不記錄', () => {
    const memory = new DeletionMemory();
    memory.remember('f', { change: change(9, 0, 10, 0), moved: [], removed: [] });
    assert.strictEqual(memory.takeUndo('f', change(9, 0, 9, 0, 'x\n')), undefined);
  });
});
