import * as assert from 'assert';
import MarkdownIt from 'markdown-it';
import { mermaidPlugin } from '../../src/markdown/mermaid';

describe('Mermaid 支援', () => {
  const md = mermaidPlugin(new MarkdownIt());

  it('```mermaid 區塊轉成待繪製的 <pre>，內容跳脫，保留行號', () => {
    const html = md.render('# t\n\n```mermaid\nflowchart TD\n  A --> B<script>\n```\n');
    assert.ok(html.includes('<pre class="code-line fb-mermaid" data-line="2">flowchart TD\n  A --&gt; B&lt;script&gt;\n</pre>'), html);
  });

  it('其他程式碼區塊照原本方式顯示；~~~ mermaid 也支援', () => {
    const html = md.render('```js\nx()\n```\n\n~~~ Mermaid\ngraph LR\n~~~\n');
    assert.ok(html.includes('<pre><code class="language-js">x()'), html);
    assert.ok(html.includes('fb-mermaid" data-line="4">graph LR'), html);
  });
});
