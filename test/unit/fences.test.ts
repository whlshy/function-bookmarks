import * as assert from 'assert';
import MarkdownIt from 'markdown-it';
import { closeUnclosedFences } from '../../src/markdown/fences';

describe('closeUnclosedFences：補關備註中未閉合的程式碼圍欄', () => {
  it('未閉合的反引號與波浪號圍欄：在結尾補上對應圍欄', () => {
    const mermaid = '```mermaid\nflowchart TD\n  A --> B';
    assert.strictEqual(closeUnclosedFences(mermaid), `${mermaid}\n\`\`\``);

    const withTrailingNl = '```ts\nconst x = 1;\n';
    assert.strictEqual(closeUnclosedFences(withTrailingNl), `${withTrailingNl}\`\`\``);

    const crlf = '```js\r\nfoo()';
    assert.strictEqual(closeUnclosedFences(crlf), `${crlf}\n\`\`\``);

    const tilde = '~~~python\ndef f():\n  pass';
    assert.strictEqual(closeUnclosedFences(tilde), `${tilde}\n~~~`);

    const fourTicks = '````markdown\n```js\ncode\n```';
    assert.strictEqual(closeUnclosedFences(fourTicks), `${fourTicks}\n\`\`\`\``);
  });

  it('已閉合的圍欄與一般內容維持不變', () => {
    const closed = '說明\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n後段文字';
    assert.strictEqual(closeUnclosedFences(closed), closed);

    const closedTilde = '~~~\nhello\n~~~';
    assert.strictEqual(closeUnclosedFences(closedTilde), closedTilde);

    // 反引號資訊字串內含反引號（行內程式碼）不開啟圍欄
    const inline = '```inline``` text';
    assert.strictEqual(closeUnclosedFences(inline), inline);

    // 最多縮排 3 格的結尾圍欄可正常閉合
    const indent3 = '   ```js\nconst a = 1;\n   ```';
    assert.strictEqual(closeUnclosedFences(indent3), indent3);
  });

  it('縮排 4 格的圍欄：開頭 4 格不開啟圍欄；結尾 4 格不關閉圍欄須補關', () => {
    const indentedOpen = '    ```js\n    not a fence\n\nplain';
    assert.strictEqual(closeUnclosedFences(indentedOpen), indentedOpen);

    const indentedClose = '```mermaid\nflowchart TD\n  A --> B\n    ```';
    assert.strictEqual(closeUnclosedFences(indentedClose), `${indentedClose}\n\`\`\``);

    const tabClose = '```js\nfoo()\n\t```';
    assert.strictEqual(closeUnclosedFences(tabClose), `${tabClose}\n\`\`\``);

    // 結尾圍欄後方有非空白字元，或不同字元，皆不算閉合
    const trailingInfo = '```js\nfoo()\n```js';
    assert.strictEqual(closeUnclosedFences(trailingInfo), `${trailingInfo}\n\`\`\``);

    const mismatch = '```js\nfoo()\n~~~';
    assert.strictEqual(closeUnclosedFences(mismatch), `${mismatch}\n\`\`\``);
  });

  it('補關後串接「在預覽中開啟」連結，Markdown 仍能正確渲染出超連結而非程式碼文字', () => {
    const md = new MarkdownIt();
    const link = '[Open in preview](https://example.invalid/preview)';
    for (const raw of [
      '```mermaid\nflowchart TD\n  A --> B',
      '```mermaid\nflowchart TD\n  A --> B\n    ```',
      '~~~ts\nconst x = 1;',
    ]) {
      const html = md.render(`${closeUnclosedFences(raw)}\n\n${link}`);
      assert.ok(html.includes('<a href="https://example.invalid/preview">Open in preview</a>'), html);
    }
  });
});
