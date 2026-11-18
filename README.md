# Function Bookmarks

> Preview — under active development. The roadmap is in PLAN.md in the repository (Traditional Chinese).

Bookmarks that survive `git pull` and branch switches, plus a customizable function list with favorites. Works in VS Code and Cursor.

## Current features (0.0.2)

- **Function list** for the current file in its own side bar
- **Favorites** — star a function and find it in the Favorites section without opening the file; favorites follow edits and `git pull`
- **Display names** — rename how a function is shown (F2); hover to see the original name and path
- **Whole project** browser and **Search Functions** across the workspace
- **Django templates** — click `extends` / `include` to open the template; see which blocks override the parent template
- **Customizable detection rules** — decide what counts as a function with regular expressions
- **Built-in rules**
  - TypeScript / JavaScript: `function`, arrow functions, function expressions, classes, methods, object methods
  - Python: `def`, `async def`, `class`, methods
  - Django templates: `{% block %}`, `{% partialdef %}`, `{% extends %}`, `{% include %}`, functions inside `<script>`
- Languages without rules fall back to the language server
- Click to jump; the function under the cursor is highlighted

## Settings

| Setting | Default | Description |
|---|---|---|
| `functionBookmarks.detection.source` | `rules` | `rules`, `languageServer` or `both` |
| `functionBookmarks.detection.rules` | `[]` | Your own rules; same `id` overrides a built-in rule |
| `functionBookmarks.detection.disabledRules` | `["html-id"]` | Built-in rule IDs to turn off |
| `functionBookmarks.detection.templateFiles` | `["**/templates/**"]` | Where the Django / HTML rules apply |
| `functionBookmarks.followCursor` | `true` | Highlight the function under the cursor |
| `functionBookmarks.storage` | `file` | `file` (`.vscode/function-bookmarks.json`) or `workspaceState` |
| `functionBookmarks.project.include` | `**/*.{ts,tsx,…,py,html,htm}` | Files listed under Whole project and used by search |
| `functionBookmarks.project.exclude` | `node_modules`, `.venv`, `dist`, … | Excluded from Whole project and search |
| `functionBookmarks.django.templateDirs` | `[]` | Extra template folders (folders named `templates` are found automatically) |

### Example rule

```jsonc
"functionBookmarks.detection.rules": [
  {
    "id": "go-func",
    "languages": ["go"],
    "pattern": "^func[ \\t]+(?:\\([^)]*\\)[ \\t]*)?(?<name>\\w+)",
    "kind": "function",
    "body": "brace"
  }
]
```

`body` decides how the end of a symbol is found: `brace`, `indent`, `pair` (with `end`), `line` or `embedded` (with `end` and `embeddedLanguage`).

## Privacy

This extension does not collect any data.

---

## 繁體中文

函式書籤：`git pull`、切換分支都不會位移的書籤，加上可自訂的函式列表與收藏，VS Code 與 Cursor 都能使用。目前為預覽版，開發規劃請見原始碼中的 PLAN.md。
