// 在 Markdown 預覽中把 <pre class="fb-mermaid"> 畫成 Mermaid 圖。
// mermaid.min.js 很大（約 5 MB），頁面真的有 Mermaid 區塊時才載入（與本檔同一個套件的 dist/）。
(function () {
  const self = document.currentScript;
  // 預覽的 CSP 只允許帶 nonce 的 script；動態載入時沿用本檔的 nonce
  const nonce = self && self.nonce;
  const mermaidSrc = self && self.src ? new URL('../dist/mermaid.min.js', self.src).href : undefined;
  let counter = 0;
  let running = false;
  /** 繪圖中又收到更新：畫完再檢查一次，不漏掉這次更新。 */
  let pending = false;
  let loading;

  function isDark() {
    const c = document.body.classList;
    return c.contains('vscode-dark') || c.contains('vscode-high-contrast');
  }

  function loadMermaid() {
    if (window.mermaid) {
      return Promise.resolve(window.mermaid);
    }
    if (!loading) {
      loading = new Promise(function (resolve, reject) {
        if (!mermaidSrc) {
          reject(new Error('mermaid.min.js not found'));
          return;
        }
        const s = document.createElement('script');
        s.src = mermaidSrc;
        s.charset = 'UTF-8';
        if (nonce) {
          s.nonce = nonce;
        }
        s.onload = function () {
          if (window.mermaid) {
            resolve(window.mermaid);
          } else {
            reject(new Error('mermaid did not load'));
          }
        };
        s.onerror = function () {
          reject(new Error('mermaid.min.js failed to load'));
        };
        document.head.appendChild(s);
      }).catch(function (e) {
        // 下次更新時再試
        loading = undefined;
        throw e;
      });
    }
    return loading;
  }

  async function render() {
    if (running) {
      pending = true;
      return;
    }
    const nodes = Array.from(document.querySelectorAll('pre.fb-mermaid:not([data-fb-done])'));
    if (nodes.length === 0) {
      return;
    }
    running = true;
    try {
      let mermaid;
      try {
        mermaid = await loadMermaid();
      } catch (e) {
        return;
      }
      mermaid.initialize({ startOnLoad: false, theme: isDark() ? 'dark' : 'default', securityLevel: 'strict' });
      for (const pre of nodes) {
        // 等待載入或繪圖期間預覽內容可能已整個換掉
        if (!pre.isConnected) {
          continue;
        }
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
          if (pre.isConnected) {
            pre.replaceWith(div);
          }
        } catch (e) {
          pre.classList.add('fb-mermaid-error');
          pre.title = String((e && e.message) || e);
        }
      }
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void render();
      }
    }
  }

  /** 同一輪的多次變動只畫一次。 */
  let scheduled = false;
  function schedule() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      void render();
    }, 0);
  }

  function hasMermaid(node) {
    return node.nodeType === 1 && (node.matches('pre.fb-mermaid') || !!node.querySelector('pre.fb-mermaid'));
  }

  // 內建預覽剛打開時，內容是在預覽自己的 script 載入後才插進 body，而且不會發出
  // vscode.markdown.updateContent 事件；所以改用 MutationObserver 監看，只要有 Mermaid 區塊加進頁面就畫
  function observe() {
    new MutationObserver(function (records) {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (hasMermaid(n)) {
            schedule();
            return;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    schedule();
  }

  // 內容更新時預覽會就地修改既有節點（不一定是新增），事件仍要聽
  window.addEventListener('vscode.markdown.updateContent', schedule);
  if (document.body) {
    observe();
  } else {
    document.addEventListener('DOMContentLoaded', observe);
  }
})();
