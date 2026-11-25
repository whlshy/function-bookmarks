import * as assert from 'assert';
import {
  addLabeledBookmarkKey,
  bookmarkChordPrefix,
  goToNumberKeys,
  renameBookmarkKey,
  setNumberKey,
  setNumberKeys,
  toggleBookmarkKey,
} from '../../src/util/shortcuts';

describe('快捷鍵提示文字（依平台）', () => {
  it('依平台產生快捷鍵提示文字（macOS 顯示 Ctrl+Shift+B，Windows／Linux 顯示 Alt+Shift+B）', () => {
    assert.strictEqual(bookmarkChordPrefix('win32'), 'Alt+Shift+B');
    assert.strictEqual(bookmarkChordPrefix('linux'), 'Alt+Shift+B');
    assert.strictEqual(bookmarkChordPrefix('darwin'), 'Ctrl+Shift+B');

    assert.strictEqual(toggleBookmarkKey('win32'), 'Alt+Shift+B B');
    assert.strictEqual(toggleBookmarkKey('darwin'), 'Ctrl+Shift+B B');

    assert.strictEqual(addLabeledBookmarkKey('win32'), 'Alt+Shift+B Shift+B');
    assert.strictEqual(addLabeledBookmarkKey('darwin'), 'Ctrl+Shift+B Shift+B');

    assert.strictEqual(renameBookmarkKey('win32'), 'Alt+Shift+B R');
    assert.strictEqual(renameBookmarkKey('darwin'), 'Ctrl+Shift+B R');

    assert.strictEqual(goToNumberKeys('win32'), 'Alt+Shift+B 1–9');
    assert.strictEqual(goToNumberKeys('darwin'), 'Ctrl+Shift+B 1–9');

    assert.strictEqual(setNumberKeys('win32'), 'Alt+Shift+B Shift+1–9');
    assert.strictEqual(setNumberKeys('darwin'), 'Ctrl+Shift+B Shift+1–9');

    assert.strictEqual(setNumberKey(3, 'win32'), 'Alt+Shift+B Shift+3');
    assert.strictEqual(setNumberKey(3, 'darwin'), 'Ctrl+Shift+B Shift+3');
  });
});
