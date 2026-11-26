import * as assert from 'assert';
import { chooseJumpTarget, JumpState } from '../../src/util/jumpTarget';

const base = (patch: Partial<JumpState>): JumpState => ({ target: 'b', otherGroups: [], sideBySide: true, ...patch });

describe('跳到書籤時選擇編輯器（chooseJumpTarget）', () => {
  it('使用中群組的一般分頁就是目標：留在原分頁', () => {
    assert.deepStrictEqual(chooseJumpTarget(base({ activeGroup: { viewColumn: 1, text: 'b' } })), { kind: 'activeText', viewColumn: 1 });
  });

  it('activeTextEditor 沒更新（還停在別的群組）時，以使用中的群組為準', () => {
    const s = base({
      activeGroup: { viewColumn: 1, text: 'c' },
      otherGroups: [{ viewColumn: 2, text: 'b' }],
      activeEditor: { key: 'b', viewColumn: 2 },
    });
    assert.deepStrictEqual(chooseJumpTarget(s), { kind: 'otherGroup', viewColumn: 2 });
  });

  it('差異比較：焦點已在目標那一側時留在原處', () => {
    const s = base({ activeGroup: { viewColumn: 1, diff: { original: 'a', modified: 'b' } }, activeEditor: { key: 'b', viewColumn: 1 } });
    assert.deepStrictEqual(chooseJumpTarget(s), { kind: 'activeDiff', viewColumn: 1 });
  });

  it('差異比較：目標在另一側時切過去', () => {
    const s = base({ target: 'a', activeGroup: { viewColumn: 1, diff: { original: 'a', modified: 'b' } }, activeEditor: { key: 'b', viewColumn: 1 } });
    assert.deepStrictEqual(chooseJumpTarget(s), { kind: 'diffOtherSide', viewColumn: 1 });
  });

  it('差異比較兩側的編輯器沒有 viewColumn 時，仍能判斷焦點在哪一側', () => {
    const s = base({ target: 'a', activeGroup: { viewColumn: 1, diff: { original: 'a', modified: 'b' } }, activeEditor: { key: 'b' } });
    assert.deepStrictEqual(chooseJumpTarget(s), { kind: 'diffOtherSide', viewColumn: 1 });
    assert.deepStrictEqual(chooseJumpTarget({ ...s, target: 'b' }), { kind: 'activeDiff', viewColumn: 1 });
  });

  it('差異比較：不知道焦點在哪一側時，留在差異比較', () => {
    const s = base({ target: 'a', activeGroup: { viewColumn: 1, diff: { original: 'a', modified: 'b' } } });
    assert.deepStrictEqual(chooseJumpTarget(s), { kind: 'activeDiff', viewColumn: 1 });
  });

  it('焦點在輸出面板等沒有 viewColumn 的地方時，不會誤判成差異比較的另一側', () => {
    const s = base({ target: 'a', activeGroup: { viewColumn: 1, diff: { original: 'a', modified: 'b' } }, activeEditor: { key: 'x' } });
    assert.deepStrictEqual(chooseJumpTarget(s), { kind: 'activeDiff', viewColumn: 1 });
  });

  it('行內差異比較看不到左側：目標在左側時改為開啟一般分頁', () => {
    const s = base({
      target: 'a',
      sideBySide: false,
      activeGroup: { viewColumn: 1, diff: { original: 'a', modified: 'b' } },
      activeEditor: { key: 'b', viewColumn: 1 },
    });
    assert.deepStrictEqual(chooseJumpTarget(s), { kind: 'open' });
  });

  it('其他群組：只沿用一般分頁，差異比較不動；多個群組時取 viewColumn 小的', () => {
    const s = base({
      activeGroup: { viewColumn: 1, text: 'c' },
      otherGroups: [
        { viewColumn: 3, text: 'b' },
        { viewColumn: 2, diff: { original: 'a', modified: 'b' } },
        { viewColumn: 4, text: 'b' },
      ],
    });
    assert.deepStrictEqual(chooseJumpTarget(s), { kind: 'otherGroup', viewColumn: 3 });
  });

  it('使用中群組不是文字分頁（例如備註預覽），其他地方也沒有：在使用中的群組開啟', () => {
    assert.deepStrictEqual(chooseJumpTarget(base({ activeGroup: { viewColumn: 1 } })), { kind: 'open' });
  });
});
