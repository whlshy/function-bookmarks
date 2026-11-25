import * as assert from 'assert';
import { hashLines, LineHashEdit, splitLines, updateLineHashes } from '../../src/bookmarks/relocate';

/** 把編輯套到文字上（座標相對於編輯前的文件，依位置由後往前套）。 */
function applyEdits(text: string, edits: (LineHashEdit & { startChar: number; endChar: number })[]): string {
  const lines = splitLines(text);
  const offsetOf = (line: number, ch: number) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + ch;
  let out = text;
  for (const e of [...edits].sort((a, b) => b.startLine - a.startLine || b.startChar - a.startChar)) {
    out = out.slice(0, offsetOf(e.startLine, e.startChar)) + e.text + out.slice(offsetOf(e.endLine, e.endChar));
  }
  return out;
}

function check(before: string, edits: (LineHashEdit & { startChar: number; endChar: number })[]): void {
  const after = applyEdits(before, edits);
  const lines = splitLines(after);
  const got = updateLineHashes(hashLines(before), edits, lines.length, (i) => lines[i]);
  assert.deepStrictEqual(got, hashLines(after));
}

describe('updateLineHashes：只重算被改到的行', () => {
  const base = ['def a():', '    return 1', '', 'def b():', '    return 2', ''].join('\n');

  it('行內打字、插入多行、刪除多行、多行換成多行，結果都和整份重算一致', () => {
    check(base, [{ startLine: 1, startChar: 11, endLine: 1, endChar: 12, text: '42' }]);
    check(base, [{ startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: '# x\n# y\n' }]);
    check(base, [{ startLine: 1, startChar: 0, endLine: 3, endChar: 0, text: '' }]);
    check(base, [{ startLine: 3, startChar: 0, endLine: 4, endChar: 12, text: 'def c():\n    pass\n    return 3' }]);
  });

  it('多游標在不同行同時編輯（不論順序）也一致', () => {
    check(base, [
      { startLine: 4, startChar: 4, endLine: 4, endChar: 4, text: '# ' },
      { startLine: 1, startChar: 4, endLine: 1, endChar: 4, text: '# ' },
    ]);
    check(base, [
      { startLine: 0, startChar: 8, endLine: 0, endChar: 8, text: '\n    """doc"""' },
      { startLine: 3, startChar: 8, endLine: 3, endChar: 8, text: '\n    """doc"""' },
    ]);
  });

  it('同一行有兩處編輯、或記住的內容行數對不上時回傳 undefined（改用整份重算）', () => {
    const lines = splitLines(base);
    const sameLine = [
      { startLine: 1, startChar: 4, endLine: 1, endChar: 4, text: 'a' },
      { startLine: 1, startChar: 8, endLine: 1, endChar: 8, text: 'b' },
    ];
    assert.strictEqual(updateLineHashes(hashLines(base), sameLine, lines.length, (i) => lines[i]), undefined);
    const stale = hashLines(base).slice(0, 2);
    const edit = [{ startLine: 4, startChar: 0, endLine: 4, endChar: 0, text: 'x' }];
    assert.strictEqual(updateLineHashes(stale, edit, lines.length, (i) => lines[i]), undefined);
  });
});
