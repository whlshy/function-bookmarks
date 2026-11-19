# Function Bookmarks — VS Code 套件規劃

## 1. 背景：為什麼現有套件會位移

`alefragnani/vscode-bookmarks` 以「行號」儲存書籤（存在 workspace state，或開啟 `bookmarks.saveBookmarksInProject` 時存在 `.vscode/bookmarks.json`）。

- **在 VS Code 內打字編輯**：套件會收到 `onDidChangeTextDocument` 事件並調整行號，所以不太會跑掉。
- **`git pull` / `checkout` / `rebase` / 外部工具改檔**：檔案是從磁碟整個被換掉，套件只看到「整份內容被取代」，無法知道哪幾行是新插入的，因此行號原封不動 → 書籤位移。

這是設計上的限制，不是設定問題，沒有任何設定能修正。

## 2. 目標功能

| 功能 | 說明 |
|---|---|
| 自動偵測函式 | 依使用者可自訂的偵測規則找出 function / method / class，沒有規則的語言改用 VS Code 語言伺服器（見第 4 節） |
| 側邊欄樹狀檢視 | 檔案 → 類別 → 函式，點擊即跳轉 |
| 函式收藏 | 以「符號路徑」（例如 `UserService.login`）收藏，不依賴行號，天生不怕位移；**收藏區不必打開檔案就看得到**（見下方） |
| 自訂函式顯示名稱 | 可替函式取一個自己看得懂的名稱（例如「登入驗證」），滑鼠移上去仍看得到原本的函式名稱與路徑（見下方） |
| 只顯示收藏 | 檢視上方切換按鈕：全部 / 只顯示收藏 / 只顯示書籤 |
| 行號書籤 + 標籤 | 任意行可加書籤、自訂名稱、分組標籤（tag） |
| 抗位移 | `git pull` 等外部變動後自動重新定位書籤（見第 3 節） |
| 失效提示 | 真的找不到時標成「⚠ 需確認」，而不是默默指到錯的行 |

### 收藏區的行為

「目前檔案的函式」只顯示正在編輯的檔案；**收藏區則列出整個專案所有加了星號的函式，不必打開檔案**。

```
★ 收藏
├─ 📄 app/views.py
│   ├─ 文章頁 GET               ✎
│   └─ index
└─ 📄 app/templates/app/login.html
    └─ content.form
```

- 依檔案分組，可切換成不分組（依名稱排序）
- 點擊時開啟該檔案並跳到函式；用名稱路徑重新偵測位置，所以檔案被改過也找得到
- 每筆收藏記住「檔案、名稱路徑、最後已知行號」；側邊欄打開時，在背景讀取這些檔案（不開分頁）確認函式還在，找不到就反灰顯示「找不到函式」
- 監看收藏檔案的變動（含 git pull、切換分支），變動後重新確認
- 檔案被改名或刪除：改名時跟著更新路徑；刪除時反灰保留，可手動移除

### 備註（M2.1，已與老闆對齊）

- **對象**：函式（M2.1 完成）；任意一行的備註併入 M3 行號書籤（需要行號跟隨機制）
- **內容**：多行 Markdown
- **編輯**：右鍵「編輯備註」→ 開啟 Markdown 編輯分頁（暫存檔，放在套件的 globalStorage）→ `Ctrl+S` 存檔時寫回書籤資料並關閉分頁；清空後存檔即刪除；不存檔直接關閉則不變更
- **顯示**：平常不顯示內容，只在滑鼠移上去時顯示全文
  - 側邊欄：不另外加圖示（太擠），改把名稱前的圖示換成藍色；提示中顯示備註全文
  - 編輯器：行號旁顯示藍色備註圖示（同時收藏時顯示收藏圖示）；滑鼠移到函式名稱上顯示備註
  - 搜尋函式：清單的第二行附上備註第一行
- **Markdown 預覽**（老闆需求）：
  - 編輯備註時，右側並排 VS Code／Cursor 內建的 Markdown 預覽，存檔或關閉時一起關
  - 右鍵「預覽備註」或提示中的「在預覽中開啟」，用完整的預覽分頁查看（支援圖片、表格、程式碼高亮）
- **Mermaid**（老闆回饋，0.0.8 定案）：VS Code 原本的 Markdown 預覽畫不出 Mermaid；改用 Cursor 自己的編輯器又無法自動切到預覽、不會同步捲動。最後做法是**把 Mermaid 接進內建 Markdown 預覽**（`markdown.markdownItPlugins`＋`markdown.previewScripts`，打包 mermaid）：
  - 備註編輯：左邊文字、右邊內建預覽（一開就是預覽、會跟著捲動）；Cursor 的編輯檔用 `.markdown`，避免被 Cursor 的 Markdown 編輯器接管
  - 預覽備註：內建預覽分頁
  - 附帶效果：使用者在編輯器內預覽任何 `.md` 都能畫 Mermaid；已安裝 `bierner.markdown-mermaid` 時自動讓開
  - 滑鼠提示無法執行繪圖程式，Mermaid 區塊直接顯示原始碼（老闆決定）
  - **暫緩**：老闆實測 Cursor 的內建預覽仍畫不出 Mermaid，先擱置，之後再研究
- 以「檔案＋名稱路徑」記錄，跟收藏一樣不怕行號位移

### 自訂函式顯示名稱

在樹狀檢視裡，把函式顯示成自己取的名稱，不會改到程式碼。

- 任何函式都能改名，不一定要先收藏；改過名的函式旁邊顯示 ✎
- 操作方式：
  - 右鍵選單「重新命名顯示名稱」，或選取後按 `F2`
  - 輸入框預設帶入目前的名稱；清空後按 Enter 就恢復原本的函式名稱
- 滑鼠移上去的提示顯示：
  - 原本的函式名稱與完整路徑，例如 `ArticleView.get`
  - 所在檔案與行號、偵測規則
- 「目前檔案的函式」與「收藏」兩個區塊都顯示自訂名稱
- 之後的快速搜尋（M3）同時比對自訂名稱與原本的函式名稱
- 以「檔案＋名稱路徑」記錄，跟收藏一樣不怕行號位移；函式找不到時保留並反灰
- 匯出、匯入（第 5 節）只處理行號書籤，不含自訂函式名稱

## 3. 核心設計：書籤錨點（Anchor）

每個書籤除了行號，還額外記錄：

```jsonc
{
  "id": "uuid",
  "file": "src/services/user.ts",      // 相對路徑
  "line": 120,                          // 最後已知行號
  "label": "登入驗證邏輯",
  "tags": ["auth"],
  "anchor": {
    "text": "if (!user.isActive) {",    // 該行內容（去除前後空白）
    "before": ["const user = await repo.find(id);", ""],  // 前 2 行
    "after":  ["  throw new Error('inactive');", "}"],    // 後 2 行
    "symbolPath": "UserService.login",  // 所在函式
    "symbolOffset": 7,                  // 距離函式開頭第幾行
    "commit": "a1b2c3d"                 // 建立/最後確認時的 git HEAD
  },
  "status": "ok",                       // ok | moved | lost | notOnBranch
  "source": null,                       // null＝自己加的；匯入的見第 5 節
  "scope": "all",                       // all：所有分支都顯示；branch：只在 homeBranch 顯示（見第 6 節）
  "homeBranch": "feature/login",        // 建立時所在分支
  "positions": {                        // 各分支最後確認的位置（見第 6 節）
    "feature/login": { "line": 120, "commit": "a1b2c3d", "status": "ok" },
    "main":          { "line": 98,  "commit": "e4f5g6h", "status": "ok" }
  }
}
```

### 依變動來源分三種跟隨方式

| 變動來源 | 怎麼偵測 | 怎麼跟隨行號 |
|---|---|---|
| **A. 在編輯器裡打字、貼上、刪行** | `onDidChangeTextDocument`，事件會帶出「哪一段被換成幾行」 | 跟原 Bookmarks 套件一樣即時平移：變動範圍之後的書籤加減差的行數 |
| **B. Git 操作**（pull、checkout、merge、rebase、stash、reset） | 內建 `vscode.git` 擴充 API：`repository.state.onDidChange`，比較 `HEAD.commit` 前後是否改變 | 執行 `git diff --unified=0 <舊HEAD> <新HEAD> -- <file>`，依 hunk（`@@ -a,b +c,d @@`）換算新行號 |
| **C. 其他外部變動**（格式化工具、其他編輯器、腳本） | `FileSystemWatcher`，或開檔時發現內容和上次記錄的不同 | 用上次記錄的檔案內容快照與新內容做行比對（diff），換算方式同 B |

### Git 行號換算規則（方式 B）

把舊行號 `L` 依序套過每個 hunk：

- `L` 在 hunk 之前 → 不變
- `L` 在 hunk 之後 → `L + (新行數 − 舊行數)` 累加
- `L` 剛好在被修改或刪除的範圍內 → 交給下方「後備定位」，仍找不到就標成需確認
- 檔案有本機未提交的修改時：先用 `git diff <舊HEAD>`（工作區對舊 HEAD）把書籤換算回舊 HEAD 的行號，套用 pull 的 diff 後，再換算回目前工作區
- 發生衝突（檔案含 `<<<<<<<`）時，衝突區內的書籤先標成需確認，解完衝突後重新定位一次

### 後備定位（B、C 換算不出來時）

1. **原位檢查**：目前行號的內容仍等於 `anchor.text` → 不動
2. **模糊比對**：搜尋全檔與 `text + before + after` 最相似的位置，依「相似度」與「離原位置的距離」計分，超過門檻才採用
3. **函式相對定位**：找到同名函式 `symbolPath`，加上 `symbolOffset`，再在附近小範圍比對
4. **失敗**：標成 `status: "lost"`，保留並反灰顯示「需確認」，讓使用者手動重新放置

### 其他規則

- 每次定位成功都更新 `anchor`（該行內容、前後行、目前 HEAD commit），讓下次比對更準
- 換算完立即存檔，避免 VS Code 關閉後遺失
- 函式收藏以函式名稱路徑記錄，不需要上面的行號換算；找不到同名函式時一樣反灰顯示

## 4. 函式偵測規則（使用者可自訂）

使用者可以自己決定「什麼樣的程式碼算函式」。套件內建各語言常用寫法，可逐條開關，也可以新增自己的規則。

### 偵測來源

設定 `functionBookmarks.detection.source`：

| 值 | 說明 |
|---|---|
| `rules`（預設） | 有規則的語言用規則偵測；沒有規則的語言才改用 VS Code 語言伺服器（`executeDocumentSymbolProvider`） |
| `languageServer` | 全部用語言伺服器，規則不生效 |
| `both` | 兩者合併，同一行重複的只留一筆 |

選 `rules` 當預設的原因：結果完全由使用者掌控、不需要安裝語言擴充、速度快，而且像 `const xxx = () => {}` 這種寫法，語言伺服器有時會把它當成變數。

### 規則格式

```jsonc
"functionBookmarks.detection.rules": [
  {
    "id": "ts-arrow",                       // 唯一識別，內建規則可用 id 關閉
    "label": "箭頭函式",
    "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    "pattern": "^\\s*(?:export\\s+)?(?:const|let|var)\\s+(?<name>[A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=>",
    "kind": "function",                     // function | method | class | block | partial | macro | reference，決定圖示
    "body": "brace",                        // 怎麼找結尾，見下表
    "enabled": true
  }
]
```

| `body` | 怎麼找結尾 | 用在 |
|---|---|---|
| `brace` | 配對大括號，略過字串與註解 | TS / JS |
| `indent` | 縮排回到同層或更外層為止 | Python |
| `pair` | 搭配 `end` 正規表示式找成對的結束標籤，可巢狀 | Django／Jinja 的 `{% block %}…{% endblock %}` |
| `line` | 只有一行，沒有內容範圍 | `{% include %}` 這類參照 |

另外有 `embedded`：在檔案的某個區域裡套用另一種語言的規則，例如 HTML 的 `<script>…</script>` 內改用 JS 規則（見下方 Django 一節）。

- `pattern` 是正規表示式，必須包含 `(?<name>...)` 取出函式名稱
- `body` 用來算出函式的結束行，才能判斷「某行書籤在哪個函式裡」，以及類別和方法的上下層關係（`UserService.login`）
- 使用者的規則與內建規則合併；`"functionBookmarks.detection.disabledRules": ["ts-method"]` 可關閉內建規則

### 內建規則（第一版）

| 語言 | id | 偵測寫法 | body |
|---|---|---|---|
| TS / JS | `ts-function` | `function xxx() {}`、`export default async function xxx()`、`function* xxx()` | brace |
| TS / JS | `ts-arrow` | `const xxx = () => {}`、`const xxx = async (a: T): R => {}` | brace |
| TS / JS | `ts-function-expr` | `const xxx = function () {}` | brace |
| TS / JS | `ts-class` | `class Xxx`、`export abstract class Xxx` | brace |
| TS / JS | `ts-method` | 類別內的 `xxx() {}`、`async xxx()`、`private static xxx()`、`get xxx()`（排除 `if`、`for`、`while`、`switch`、`catch`） | brace |
| TS / JS | `ts-object-fn` | 物件內的 `xxx: () => {}`、`xxx: function () {}` | brace |
| Python | `py-def` | `def xxx():`、`async def xxx():` | indent |
| Python | `py-class` | `class Xxx:` | indent |

其他語言（C#、Java、Go 等）之後再補內建規則；使用者也可以自己先加。

### Markdown 目錄結構

Markdown 沒有函式，改把**標題**當成可跳轉、可收藏的區段，側邊欄就是文件的目錄：

```
📄 README.md
├─ 安裝
│   ├─ 使用 npm
│   └─ 手動安裝
└─ 使用方式
    └─ 設定
```

| id | 偵測寫法 | kind | body |
|---|---|---|---|
| `md-heading` | `# 標題` ～ `###### 標題`（ATX 寫法，結尾的 `#` 會去掉） | heading | heading |
| `md-setext` | 下一行是 `===`（第 1 層）或 `---`（第 2 層）的標題 | heading | heading |

- 新增 `body: "heading"`：區段到下一個「同層或更上層」的標題前結束，所以 `##` 會自動成為上一個 `#` 的子節點
- 新增 kind `heading`，圖示用 `symbol-key`
- 遮蔽規則：程式碼區塊（```` ``` ````、`~~~`）、HTML 註解、YAML front matter 裡的 `#` 不算標題
- 名稱路徑以標題文字串成，例如 `安裝.使用 npm`，收藏與自訂顯示名稱照常可用
- 套用語言：`markdown`；「整個專案」預設的 include 加上 `.md`、`.markdown`

### 事件監聽與網路請求（M2.1，老闆回饋）

前端程式（含 Django template 的 `<script>`）常見的寫法不是具名函式，而是事件監聽與 ajax。對應規則：

| id | 偵測寫法 | 顯示名稱 | kind |
|---|---|---|---|
| `js-jquery-event` | `$('#toggleBtn').on('click', function (e) {…})`、`$(document).on('click', '.btn', …)` | `#toggleBtn click`、`document click .btn` | event |
| `js-jquery-shorthand` | `$('.item').click(function () {…})`、`$(window).resize(…)` | `.item click` | event |
| `js-ready` | `$(document).ready(…)`、`$(function () {…})` | `document ready` | event |
| `js-add-listener` | `btn.addEventListener('click', …)` | `btn click` | event |
| `js-on-prop` | `window.onload = function () {…}` | `window load` | event |
| `html-event-attr` | `<button onclick="toggle()">` | `button onclick → toggle()` | event |
| `js-ajax` | `$.ajax({ url: '/do_action', type: 'GET', … })` | `GET /do_action`（沒寫 type 時為 `AJAX`） | request |
| `js-ajax-short` | `$.get('/x', …)`、`$.post`、`$.getJSON` | `GET /x` | request |
| `js-fetch` | `fetch('/x', { method: 'PUT' })` | `PUT /x`（沒寫 method 時為 `GET`） | request |
| `js-axios` | `axios.delete('/x')` | `DELETE /x` | request |

- ajax 的 `success`、`error`、`complete` 等回呼**不顯示**（老闆決定，避免列表被大量同名回呼淹沒）；回呼裡如果還有別的 ajax 或事件監聽，仍會顯示在該節點底下
- 事件處理函式裡的 ajax 會顯示在事件節點底下，例如 `#save click › POST /save`
- 規則引擎為此新增：
  - `nameTemplate`：用多個群組組成名稱，支援 `${g:upper|預設}`
  - `matchRaw`：比對原文，字串內容也能取出；起點在註解或字串裡仍會略過
  - `body: "call"`：範圍到函式呼叫的右括號為止
  - `hideChildren`：隱藏指定規則抓到的子節點

### Django template 支援

Template 裡沒有真正的函式，但有類似「可命名、可跳轉的區段」。對應方式如下：

| 語言 | id | 偵測寫法 | kind | body | 預設 |
|---|---|---|---|---|---|
| Django / Jinja | `dj-block` | `{% block content %}` … `{% endblock %}`（也接受 `{% endblock content %}`） | block | pair | 開 |
| Django 6.0+ | `dj-partial` | `{% partialdef card %}` / `{% partialdef card inline %}` … `{% endpartialdef %}` | partial | pair | 開 |
| Jinja2 | `jinja-macro` | `{% macro render_field(field) %}` … `{% endmacro %}` | macro | pair | 開 |
| Django / Jinja | `dj-extends` | `{% extends "base.html" %}` | reference | line | 開 |
| Django / Jinja | `dj-include` | `{% include "partials/nav.html" %}`、`{% include "x.html#card" %}` | reference | line | 開 |
| HTML | `html-script` | `<script>` … `</script>` 內套用 TS/JS 規則 | — | embedded | 開 |
| HTML | `html-id` | 有 `id` 的標籤，例如 `<form id="login-form">` | block | line | 關 |

細節：

- **語言判斷**：同時套用到 `django-html`（裝了 Django 語言擴充時）、`jinja-html` 與 `html`；只套用在 `templates/` 資料夾下的 `.html`，可在設定調整，避免一般靜態 HTML 也被掃
- **巢狀區段**：`{% block content %}` 裡的 `{% block sidebar %}` 顯示成 `content.sidebar`，書籤的「所在函式」也用這個路徑
- **略過註解**：`{# … #}` 與 `{% comment %}…{% endcomment %}` 內的標籤不算
- **參照可以點**：`extends`、`include` 顯示成連結節點，點了就開啟該 template。依序到各 app 的 `templates/` 和設定 `functionBookmarks.django.templateDirs` 找檔案；`x.html#card` 會直接跳到 `card` 這個 partial
- **繼承關係**：子 template 覆寫父 template 的 block 時，在節點旁顯示「覆寫 base.html」，可一鍵跳到父 template 的同名 block
- **收藏**：block、partial、macro 都能收藏，以「檔案＋區段路徑」記錄，例如 `accounts/login.html › content.form`
- **Python 端**：view 函式、class-based view 由 `py-def`、`py-class` 處理，不用另外設定

### 已知限制

- 正規表示式一次比對一行，參數跨多行的函式只要「名稱那一行」符合就抓得到；但名稱本身被換行拆開就抓不到
- 大括號配對會略過字串與註解，但樣板字串內的 `${}` 等極端寫法可能誤判，誤判時可改用語言伺服器

### 輔助工具

- 指令「測試偵測規則」：在目前檔案標示每條規則抓到哪些行，方便調整正規表示式
- 規則設定錯誤（正規表示式寫錯、缺少 `name` 群組）時顯示警告，不影響其他規則

## 5. 匯出與匯入書籤（含來源註記）

只處理**自訂的行號書籤**，函式收藏不匯出。用途：把自己標的重點交給同事，或匯入同事標的書籤，又不會跟自己的混在一起。

### 匯出

指令「匯出書籤」：

1. 選範圍：全部自己的書籤／指定標籤（tag）／指定檔案或資料夾／在樹狀檢視勾選的項目
2. 選輸出方式：存成檔案（`*.fbookmarks.json`）或複製到剪貼簿（方便貼到聊天軟體）
3. 預設只匯出自己的書籤；匯入來的別人書籤要另外勾選才會一起匯出，避免轉來轉去

匯出檔內容：

```jsonc
{
  "format": "function-bookmarks/v1",
  "exportedBy": "henry.hsu",            // 設定 functionBookmarks.authorName，未設定時預設帶 git config user.name
  "exportedAt": "2026-11-18T10:00:00Z",
  "repo": {
    "remote": "github.com/xxx/yyy",     // 用來提醒「這份書籤可能不是這個專案的」
    "branch": "feature/login",
    "commit": "a1b2c3d"                 // 匯出當下的 HEAD，匯入時用來換算行號
  },
  "bookmarks": [
    { "id": "原始 id", "file": "src/services/user.ts", "line": 120,
      "label": "登入驗證邏輯", "tags": ["auth"], "anchor": { ... } }
  ]
}
```

### 匯入

指令「匯入書籤」（檔案或剪貼簿）：

1. 讀取並檢查格式；`repo.remote` 和目前專案不同時先警告
2. **輸入來源註記**：預設帶入 `exportedBy`（例如 `henry.hsu`），使用者可修改；同一個註記會被當成同一個來源
3. 預覽：共幾筆、幾筆的檔案在本專案找不到
4. 同一來源已匯入過時，選擇處理方式：
   - **取代**（預設）：刪掉該來源舊的書籤，換成這次的
   - **合併**：以原始 id 比對，相同的更新、新的加入
   - **取消**
5. 匯入後馬上重新定位：
   - 對方的 `repo.commit` 在本機存在 → 用 `git diff <對方commit> HEAD` 換算（同第 3 節方式 B）
   - 不存在（對方還沒推上來）→ 用 anchor 做後備定位
   - 都找不到 → 標成需確認

匯入的書籤會記錄：

```jsonc
"source": {
  "author": "henry.hsu",                // 使用者輸入的來源註記
  "importId": "uuid",                   // 這次匯入的批次
  "originalId": "對方的書籤 id",
  "importedAt": "2026-11-18T10:05:00Z"
}
```

### 篩選與顯示

- 樹狀檢視標題列新增「來源」篩選：**只看我的**（預設）／全部／勾選指定作者（例如只看 henry.hsu）
- 可選「依來源分組」顯示：`我的`、`henry.hsu`、`amy.lin` 各一組
- 別人的書籤 gutter 圖示用不同顏色，滑鼠移上去顯示「來源：henry.hsu」
- 上一個／下一個書籤跳轉只在目前篩選結果中移動
- 管理功能：刪除某個來源的全部書籤、修改來源註記、把某筆別人的書籤「轉成我的」（`source` 改回 null）
- 別人的書籤可以改名稱與標籤，但會保留來源註記

## 6. 分支切換時的書籤狀態

### 要解決的問題

- 書籤檔 `.vscode/function-bookmarks.json` 不受 git 追蹤（寫在 `.git/info/exclude`），切換分支時不會被 git 換掉，所以**所有分支共用同一份書籤資料**，分支相關資訊要記在資料裡
- 在 feature 分支新寫的程式碼，切回 main 時根本不存在；如果只記一個行號，來回切換一次就會遺失位置
- 檔案在不同分支可能被改名、刪除或不存在

### 做法：每個分支各自記住位置

每個書籤有 `positions`，以分支名稱記錄「在這個分支最後確認的行號與 commit」。

從分支 X 切到分支 Y 時（偵測 HEAD 的分支名稱或 commit 改變）：

1. **Y 有紀錄**：從 `positions[Y].commit` 換算到 Y 目前的 HEAD（Y 可能在你離開後又 pull 了新東西）
2. **Y 沒有紀錄**：從 `positions[X]` 用 `git diff <X的commit> <Y的HEAD>` 換算
3. **換算前先處理改名**：`git diff --name-status -M` 偵測到檔案改名就更新 `file`
4. **檔案在 Y 不存在，或換算後找不到** → 狀態設為 `notOnBranch`（不在此分支），保留不刪除，切回 X 時用 X 的紀錄還原，不會遺失
5. 換算成功就寫入 `positions[Y]`

因為每個分支各自保留紀錄，**來回切換不會一路累積誤差**。

### 書籤的分支範圍

| `scope` | 行為 | 適合 |
|---|---|---|
| `all`（預設） | 所有分支都顯示，依上面規則換算位置 | 一般程式碼重點 |
| `branch` | 只在 `homeBranch` 顯示，其他分支自動隱藏 | 只跟某個功能開發有關的暫時書籤 |

新增書籤後可在右鍵選單切換「只屬於這個分支」。

### 顯示

- `notOnBranch` 的書籤預設反灰顯示「不在此分支」，可在篩選中選擇隱藏
- 樹狀檢視標題顯示目前分支名稱
- 函式收藏同理：目前分支找不到同名函式就反灰，切回去自動恢復

### 特殊情況

| 情況 | 處理 |
|---|---|
| rebase、merge、cherry-pick 進行中（`.git/rebase-merge`、`MERGE_HEAD` 存在） | 暫停換算，等操作結束再一次換算，避免中間狀態亂跳 |
| detached HEAD（直接 checkout 某個 commit） | 以 commit 當鍵值暫存，不寫入分支紀錄 |
| 帶著未提交修改切分支 | 同第 3 節「未提交修改」規則處理 |
| `git stash` / `stash pop` | 視為外部變動，用方式 C 換算 |
| 分支被刪除或改名 | 「清理分支紀錄」指令列出已不存在的分支，讓使用者刪除或對應到新名稱 |
| 不是 git 專案 | 不使用分支功能，只用方式 A、C |

## 7. 參考其他套件補強的功能

參考來源：alefragnani Bookmarks、Numbered Bookmarks、Labeled Bookmarks、JetBrains IDE 書籤、Visual Studio 的 Bookmark Studio、CodeTour、Inline Bookmarks、Smart Code Bookmarks。

### 納入（已排進里程碑）

| 功能 | 參考來源 | 說明 | 階段 |
|---|---|---|---|
| 快速搜尋跳轉 | Labeled Bookmarks、JetBrains | 一個快捷鍵叫出清單，打字篩選名稱、標籤、檔名、函式，Enter 跳轉；跟著目前的篩選條件走 | M3 |
| 名稱自動建議 | Bookmark Studio | 新增時依序建議：選取的文字 → 游標所在單字 → 所在函式名稱 → 該行內容 | M3 |
| 刪除行時的行為 | alefragnani | 設定 `onLineDelete`：`moveToNext`（移到下一行，預設）／`markLost`（標需確認）／`remove`（刪除）。因為我們存了 anchor，Undo 把行恢復時書籤也能找回來，這點原套件做不到 | M3 |
| 捲軸上的位置標記 | 多數套件 | 在右側捲軸（overview ruler）標出書籤位置，可設定位置或關閉 | M3 |
| 多游標同時切換 | alefragnani、Labeled Bookmarks | 多個游標時每一行各自切換書籤 | M3 |
| 清除前確認 | alefragnani | 清除整個檔案或全部書籤前先確認 | M3 |
| 數字快速書籤 | Numbered Bookmarks、JetBrains、Bookmark Studio | 書籤可指定 1～9 號，`Ctrl+Alt+1`～`9` 直接跳；新增時可自動給下一個空號；號碼重複時詢問是否覆蓋 | M7 |
| 備註 | Bookmark Studio、Smart Code Bookmarks | 每個書籤可寫多行備註（支援 Markdown），滑鼠移到 gutter 圖示上顯示 | M7 |
| 顏色 | Labeled Bookmarks、Bookmark Studio | 可替書籤或標籤設定顏色，gutter 圖示跟著變色 | M7 |
| 行尾顯示名稱 | alefragnani、Labeled Bookmarks | 在書籤行的行尾淡淡顯示書籤名稱，可關閉 | M7 |
| 暫時隱藏全部圖示 | Labeled Bookmarks | 一鍵隱藏 gutter 圖示，方便設中斷點，書籤不受影響 | M7 |
| 狀態列 | Labeled Bookmarks | 顯示目前檔案的書籤數與目前篩選條件，點擊打開快速搜尋 | M7 |
| 匯出成 Markdown／CSV | alefragnani、Bookmark Studio | 除了可匯入的 JSON，也能匯出成 Markdown 表格（貼進 PR 說明或文件）或 CSV | M6 |
| 匯出時提醒機密內容 | Labeled Bookmarks 的警告 | 匯出檔含有程式碼內容（anchor），匯出前提示，並提供「不含程式碼內容」選項（匯入後只靠行號與 git 換算） | M6 |
| 多根工作區、遠端開發 | alefragnani | 支援一個視窗開多個專案資料夾（各自存書籤）；支援 SSH、WSL、Dev Container，套件在遠端執行才能呼叫 git | M1 起就考量 |

### 列為之後的候選（暫不排程）

| 功能 | 參考來源 | 說明 |
|---|---|---|
| 書籤導覽 | CodeTour | 把一組書籤排成有順序的步驟加說明，帶新人走一遍程式流程；可搭配匯出分享 |
| 註解標記自動成為書籤 | Inline Bookmarks | 程式碼裡的 `TODO`、`FIXME`、`@note` 自動列出；可直接沿用第 4 節的規則引擎 |
| 範圍書籤 | Smart Code Bookmarks | 標記一段連續的多行，不只單一行 |
| 檔案／資料夾書籤 | JetBrains | 書籤指向整個檔案或資料夾 |
| 書籤之間的選取工具 | alefragnani | 選取兩個書籤之間的所有行，適合看 log 檔 |
| 最近刪除 | — | 誤刪的書籤可以從「最近刪除」還原 |

### 不納入

- **每個分支一套完全獨立的書籤**（JetBrains 預設）：我們已決定預設所有分支共用並自動換算，個別書籤可設成只屬於某分支，彈性更大
- **書籤資料提交進 git 共用**（alefragnani、Bookmark Studio）：已決定只給自己用，分享改用匯出與匯入

## 8. 介面規劃

**側邊欄（自己的 Activity Bar 圖示）**

```
FUNCTION BOOKMARKS  ⎇ feature/login   [全部 | ★收藏 | 🔖書籤] [來源：只看我的 ▾] [⟳]
├─ ★ 收藏
│   ├─ UserService.login        user.ts
│   └─ parseConfig              config.ts
├─ 🔖 書籤
│   ├─ 登入驗證邏輯   #auth      user.ts:120
│   ├─ ⚠ TODO 待確認  (需確認)   api.ts:45
│   └─ ░ 新流程入口   (不在此分支) flow.ts:12
├─ 👤 henry.hsu（來源篩選選「全部」時才顯示）
│   └─ 金流回呼處理              pay.ts:88
└─ 📄 目前檔案的函式
    ├─ class UserService
    │   ├─ ☆ constructor
    │   ├─ ★ login
    │   └─ ☆ logout
    └─ ☆ helper
```

**編輯器內**

- Gutter 圖示標示書籤行
- 函式上方 CodeLens：`☆ 加入收藏` / `★ 已收藏`（可在設定關閉）

**指令（Command Palette + 快捷鍵）**

- `切換書籤`、`新增書籤並命名`、`編輯標籤`
- `收藏游標所在函式`
- `下一個 / 上一個書籤`
- `重新定位所有書籤`
- `匯出書籤`、`匯入書籤`、`管理來源`（刪除或改名某個來源）
- `切換：只屬於這個分支`、`清理分支紀錄`
- `從 alefragnani Bookmarks 匯入`（讀 `.vscode/bookmarks.json`）

## 9. 儲存

- 預設：`.vscode/function-bookmarks.json`，第一次寫入時自動加進 `.git/info/exclude`（只在本機生效，不改團隊共用的 `.gitignore`；已被 `.gitignore` 涵蓋就不動），所有分支共用同一份；要分享給別人時用「匯出」（第 5 節）
- 可選：存在 workspace state（不產生檔案）
- 一律使用相對路徑，換電腦 / 換資料夾也能用

## 10. 技術選型

- TypeScript + `yo code` 產生骨架
- 打包：esbuild
- 測試：`@vscode/test-cli` + Mocha；重新定位演算法寫成純函式，方便單元測試
- 模糊比對：自行實作（Levenshtein / 行相似度），不引入大型依賴
- Git：優先使用 `vscode.git` 擴充 API，必要時呼叫 `git` CLI
- 套件設為在工作區端執行（`extensionKind: ["workspace"]`），遠端開發時才能在遠端呼叫 git、讀取檔案
- 多根工作區：每個資料夾各自一份 `.vscode/function-bookmarks.json`，路徑相對於該資料夾

## 11. 支援的編輯器與上架

### 支援的編輯器

- **Cursor**（老闆日常使用）與 **VS Code**：Cursor 以 VS Code 為基礎，套件 API 相同，同一份程式碼兩邊都能用
- 其他同樣以 VS Code 為基礎、使用 Open VSX 的編輯器（例如 VSCodium、Windsurf）理論上也能用，但不列入正式測試

### 相容性注意事項

- **最低版本**：`package.json` 的 `engines.vscode` 不能高於 Cursor 內建的 VS Code 版本，否則 Cursor 會拒絕安裝
  - 老闆家用電腦：Cursor 3.17.8，內建 VS Code **1.128.0**（2026-11-18 從安裝檔 `product.json` 確認）；辦公電腦版本更新
  - 決定設為 `"engines.vscode": "^1.90.0"`，`@types/vscode` 鎖在 1.90：本套件需要的 API（樹狀檢視、裝飾、CodeLens、`vscode.l10n`、Git 擴充 API）在 1.90 都已具備，設低一點可以讓較舊的 Cursor、VS Code 使用者也能安裝
- **只用穩定 API**：不使用 VS Code 的實驗性 API（proposed API），上架與 Cursor 都不允許
- **Cursor AI 改檔**：Cursor 的 AI 可能透過編輯器修改（走方式 A），也可能直接寫入磁碟（走方式 C），兩種都要實測。AI 一次改很多檔案時，換算要合併處理（debounce），避免卡頓
- **Django 內建 template**：沒裝 Django 語言擴充時，Cursor 會把 template 當成 `html`，所以 Django 規則預設套用 `html`，並以 `templates/` 路徑限制範圍

### 測試方式

- 自動測試在 VS Code 跑（`@vscode/test-electron`），每次修改都執行
- 每個里程碑完成後打包 `.vsix`，安裝到 Cursor 實測，用老闆的 Django 專案當實際案例

### 上架

Cursor 不從微軟的 VS Code Marketplace 安裝套件，而是從 **Open VSX** 同步，所以兩邊都要上架：

| 平台 | 給誰用 | 工具 | 需要的帳號 |
|---|---|---|---|
| VS Code Marketplace | VS Code | `vsce publish` | 微軟 Azure DevOps 帳號，建立 publisher 與存取權杖 |
| Open VSX | Cursor、VSCodium 等 | `ovsx publish` | Eclipse Foundation 帳號，申請 namespace |

- Cursor 的套件清單是定期同步 Open VSX，新版本可能晚一點才搜尋得到；GitHub Releases 也附上 `.vsix`，可手動安裝
- 兩個平台使用相同的套件 ID（`<publisher>.function-bookmarks`）
- 先以 0.x 預覽版上架，穩定後再發 1.0

### 上架前準備

- 名稱：暫定「Function Bookmarks」，初步搜尋沒有同名套件，正式上架前再確認一次
- 介面文字：英文為預設，附繁體中文翻譯（`vscode.l10n` + `package.nls.zh-tw.json`），依編輯器的顯示語言自動切換；老闆的 Cursor 設成繁中就會看到中文
- 128×128 圖示、README（英文與繁中，附操作 GIF）、CHANGELOG、MIT 授權、`repository` 欄位、分類與關鍵字
- 隱私：不收集任何使用資料，README 註明
- GitHub Actions：每次推送跑測試；推送版本標籤時自動發布到兩個平台

## 12. 開發里程碑

| 階段 | 內容 | 完成標準 |
|---|---|---|
| M1 | 專案骨架（含多根工作區、遠端開發的架構）、側邊欄、規則引擎（brace／indent／pair／line／embedded）、內建 TS/JS、Python、Django template 規則、目前檔案的函式列表 | 開 `.py`、`.ts`、Django template 都能看到函式或區段樹，點擊可跳轉 |
| M2 | 函式收藏、篩選切換、儲存、整個專案的函式列表、Django `extends`／`include` 連結與 block 繼承 | 收藏後重開 VS Code 仍在；可只顯示收藏；template 可點擊跳到父 template |
| M3 | 行號書籤、命名與名稱建議、標籤、gutter 與捲軸標記、上下跳轉、快速搜尋跳轉、編輯時即時平移（方式 A）、刪除行行為、多游標、清除確認 | 基本書籤功能超過原套件 |
| M4 | Git 變動跟隨（方式 B）：偵測 HEAD 改變、diff hunk 換算、未提交修改、衝突處理 | `git pull` 插入程式碼後書籤不位移 |
| M5 | 其他外部變動（方式 C）與後備定位：內容快照 diff、模糊比對、函式相對定位；分支切換（各分支位置紀錄、分支範圍、特殊情況） | 格式化工具改檔、來回切換分支後書籤都正確 |
| M6 | 匯出（JSON／Markdown／CSV、機密提醒）、匯入、來源註記、來源篩選與管理 | 匯入 henry.hsu 的書籤後，可一鍵只看自己的 |
| M7 | 加強功能：數字快速書籤、備註、顏色、行尾顯示名稱、暫時隱藏圖示、狀態列 | 日常操作更順手 |
| M8 | 失效提示、匯入舊套件書籤、CodeLens、測試偵測規則指令、設定項、多根與遠端實測、打包 | 可日常使用並打包成 `.vsix` |

## 13. 現有套件調查（2026-11）

| 套件 | 抗 git pull 位移 | 自動列出函式 | 收藏函式 + 只顯示收藏 | 行書籤 + 標籤 | 安裝數 |
|---|---|---|---|---|---|
| alefragnani Bookmarks | ✗ 只靠編輯事件 | ✗ | ✗ | ✓ | 數百萬 |
| Labeled Bookmarks | ✗ 官方註明 git 會造成位移 | ✗ | ✗ | ✓ | 約 1 萬 |
| Smart Code Bookmarks | △ 以符號＋模糊比對重新定位，未說明外部變動 | ✗ 只列書籤 | ✗ | ✓ | 個位數 |
| FnList 函数列表 | △ 釘選以函式名稱重新綁定 | ✓ 僅頂層、主要 C/C++/Python | △ 可釘選，無篩選 | ✗ | 數十 |
| Bookmark Bridge | ✗ 只跟隨編輯插刪行 | ✗ | △ 可加星號，無篩選 | ✓ | 個位數 |
| navigation-history | 未說明 | △ 依瀏覽紀錄建樹 | △ 可釘選 | ✗ | — |

結論：沒有任何一個套件同時具備四項功能，且沒有一個明確處理 git pull 等外部變動。值得參考的做法：

- Smart Code Bookmarks 的「符號 → 名稱 → 簽章 → 前後文 → 模糊比對」逐層退回定位
- FnList 的「找不到時保留並反灰」處理方式

## M3 完成紀錄（2026-11-19，0.1.0）

- 快捷鍵：切換書籤 `Ctrl+Alt+B`、新增有名稱的書籤 `Ctrl+Alt+Shift+B`、下一個／上一個 `Ctrl+Alt+.`／`Ctrl+Alt+,`、快速搜尋 `Ctrl+Alt+/`
- 書籤圖示：青綠色書籤（收藏是橘色、函式備註是藍色）
- 書籤資料存在同一份 `.vscode/function-bookmarks.json` 的 `bookmarks` 欄位；編輯時的行號平移延後 0.8 秒才寫檔
- **重要發現**：檔案開著時被外部修改（git pull、其他工具），VS Code／Cursor 重新載入時會給出精確的差異編輯，書籤因此已能正確移動；只有「整份取代」（格式化工具）才不平移。M4 主要處理**檔案沒開著**時的 git 換算
- 書籤的備註、預覽與函式備註共用同一套編輯分頁

## 書籤與收藏整合（2026-11-19 與老闆對齊，0.2.0 已完成）

### 核心概念：一種書籤、兩種對象

「收藏」這個詞從介面上拿掉，統一叫**書籤**。書籤依對象分兩種，功能完全相同，只差在定位方式：

| | 函式書籤（原本的收藏） | 行號書籤 |
|---|---|---|
| 對象 | 函式、類別、Django block、Markdown 標題等偵測到的符號 | 任意一行 |
| 定位 | 檔案＋名稱路徑（例如 `ArticleView.get`），最不怕位移 | 行號＋anchor，編輯時平移，git 變動由 M4 換算 |
| 側邊欄圖示 | 符號種類圖示（ƒ、class、block…） | 🔖 書籤圖示 |
| 名稱、標籤、備註、上下跳轉、搜尋、匯出 | ✓ | ✓ |

### 介面

```
🔖 書籤  5                            [只顯示書籤] [依檔案／依標籤]
├─ 📄 views.py
│   ├─ ƒ index               5
│   ├─ ƒ ArticleView.get    12  #api
│   └─ 🔖 驗證登入狀態    18  #auth
└─ 📄 login.html
    └─ { } content.form       7
```

- 側邊欄只剩一個「書籤」區塊（取代原本的「收藏」與「書籤」兩個區塊），根節點順序：書籤、目前檔案、整個專案
- 同一個檔案內，兩種書籤**依行號混排**；函式書籤用目前偵測到的行號，找不到函式時反灰排在最後
- 分組：依檔案（預設）／依標籤；原本收藏的「不分組」併入，不再單獨提供
- 篩選：只留「只顯示書籤」（原本的「只顯示收藏」併入）
- 「目前檔案」與「整個專案」中，函式旁的 ☆／★ 按鈕改稱「加入書籤／移除書籤」
- 文字調整：所有「收藏」改為「書籤」或「函式書籤」

### 操作

- **`Ctrl+Alt+B`**：游標在函式、類別、block 等**名稱那一行**時，切換**函式書籤**；其他行切換行號書籤（老闆決定：自動判斷）
  - 該行已經有行號書籤時，一律移除那個行號書籤（避免同一行同時有兩種）
- **`Ctrl+Alt+Shift+B`**：同樣規則，建立時順便取名
- 標籤、重新命名、備註、預覽備註、移除：兩種書籤都適用，右鍵選單相同
  - 函式書籤的「重新命名」就是原本的自訂顯示名稱
- 清除檔案／清除全部：兩種都清除（先確認）；函式的自訂名稱與備註保留，只取消書籤
- **上一個／下一個**、**快速搜尋**：兩種一起，依檔名與行號排序

### 編輯器行號旁的圖示（老闆決定：統一一種）

| 情況 | 圖示 |
|---|---|
| 行號書籤 | 青綠色書籤 |
| 函式書籤 | 青綠色書籤＋白色星星 |
| 有備註但沒有加書籤的函式 | 藍色備註圖示（維持現狀） |

### 資料

- 儲存格式**不變**，不需要轉換舊資料：函式書籤仍存在 `symbols`（`favorite: true`），行號書籤存在 `bookmarks`
- `symbols` 多一個 `tags` 欄位，讓函式書籤也能加標籤
- 程式內新增一層「統一書籤」介面（`BookmarkItem`：`kind: 'symbol' | 'line'`），側邊欄、跳轉、搜尋、匯出都透過它存取兩種書籤

### 對其他里程碑的影響

- **M6 匯出／匯入**（老闆決定）：函式書籤也一起匯出；匯入後用名稱路徑定位，最不容易跑掉
- **M4／M5**：只有行號書籤需要 git 換算；函式書籤靠名稱重新找到即可

### 後續（0.2.1）

- 函式上方的可點文字「☆ 加入書籤／★ 已加入書籤」（CodeLens，老闆需求，從 M8 提前）
- 0.2.2：老闆不喜歡 CodeLens 佔一行空間，改成**滑鼠移到函式名稱時的提示視窗**：加入／移除書籤、重新命名、編輯備註，並顯示備註內容（取代原本只顯示備註的提示）；CodeLens 移除

### 同批完成

- 行號右鍵選單（比照 alefragnani Bookmarks）：切換書籤、新增有名稱的書籤
- 修正：點書籤跳轉後，側邊欄選取被游標跟隨搶到最近的函式

## 14. 已決定事項（2026-11-18）

- **書籤只給自己用**：`.vscode/function-bookmarks.json` 寫進 `.git/info/exclude`，不與團隊共用，也不修改團隊的 `.gitignore`
- **優先支援語言**：TypeScript / JavaScript、Python（測試以這兩種為主，其他語言靠 VS Code 的符號功能盡量支援）
- **要做整個專案的函式列表**：樹狀檢視新增「整個專案」區塊
  - 以 `workspace.findFiles` 列出 `.ts/.tsx/.js/.jsx/.py` 檔（排除 `node_modules`、`.venv`、`dist` 等，可在設定調整）
  - 展開檔案節點時才讀取該檔函式（延遲載入），避免大型專案開啟時卡住
  - 提供搜尋框，以 `vscode.executeWorkspaceSymbolProvider` 搜尋全專案函式名稱
- **匯入的別人書籤可以修改**名稱與標籤，來源註記保留；用「合併」重新匯入同一來源時，自己改過的欄位不被覆蓋
- **匯出作者名稱**預設取 `git config user.name`，可用設定 `functionBookmarks.authorName` 覆蓋
- **Django 使用內建 template**（非 Jinja2）：優先測試 `dj-block`、`dj-extends`、`dj-include`、`dj-partial`、`html-script`；`jinja-macro` 保留但不優先
- **支援所有 Django 版本**：各版本的 template 語法都偵測，`{% partialdef %}`（6.0 起）也預設開啟並一起測試；舊版專案沒有這種寫法，規則不會誤抓
- **老闆使用 Cursor**：以 Cursor 實測為準，VS Code 跑自動測試
- **目標是上架**：同時發布到 VS Code Marketplace 與 Open VSX（Cursor 用），見第 11 節
- **新增書籤預設所有分支都顯示**（`scope: "all"`），個別書籤可用右鍵改成只屬於目前分支
