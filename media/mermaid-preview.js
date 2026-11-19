// 在 Markdown 預覽中把 <pre class="fb-mermaid"> 畫成 Mermaid 圖。
// mermaid.min.js 會先載入（package.json 的 markdown.previewScripts）。
(function () {
  let counter = 0;
  let running = false;

  function isDark() {
    const c = document.body.classList;
    return c.contains('vscode-dark') || c.contains('vscode-high-contrast');
  }

  async function render() {
    const mermaid = window.mermaid;
    if (!mermaid || running) {
      return;
    }
    const nodes = Array.from(document.querySelectorAll('pre.fb-mermaid:not([data-fb-done])'));
    if (nodes.length === 0) {
      return;
    }
    running = true;
    try {
      mermaid.initialize({ startOnLoad: false, theme: isDark() ? 'dark' : 'default', securityLevel: 'strict' });
      for (const pre of nodes) {
        pre.setAttribute('data-fb-done', '1');
        const source = pre.textContent || '';
        try {
          counter += 1;
          const result = await mermaid.render('fb-mermaid-' + counter, source);
          const div = document.createElement('div');
          div.className = 'code-line fb-mermaid-diagram';
          const line = pre.getAttribute('data-line');
          if (line !== null) {
            div.setAttribute('data-line', line);
          }
          div.innerHTML = result.svg;
          pre.replaceWith(div);
        } catch (e) {
          pre.classList.add('fb-mermaid-error');
          pre.title = String((e && e.message) || e);
        }
      }
    } finally {
      running = false;
    }
  }

  window.addEventListener('vscode.markdown.updateContent', () => void render());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void render());
  } else {
    void render();
  }
})();
