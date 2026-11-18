# Changelog

## 0.0.2 (unreleased)

- **Favorites**: star any function; the Favorites section lists every favorite in the workspace without opening files, grouped by file (or flat). Favorites follow edits, `git pull`, renames, and are greyed out when the function disappears
- **Display names**: give any function your own name (F2 or right-click); the tooltip still shows the original name and path
- **Show favorites only** filter
- **Whole project** section: browse files by folder and expand a file to see its functions
- **Search Functions**: search every function in the workspace by display name, original name, path or file
- **Django templates**: click `{% extends %}` / `{% include %}` to open the template (`#partial` jumps to the partial); blocks that override a parent template show "overrides base.html" with a jump to the parent block
- Stored in `.vscode/function-bookmarks.json`, automatically kept out of git through `.git/info/exclude` (or in workspace state with `functionBookmarks.storage`)
- Fixed path comparison when Windows drive letters differ in case

## 0.0.1

- Side bar view listing the functions of the current file
- Customizable detection rules (regular expressions) with built-in rules for TypeScript / JavaScript, Python and Django templates (`block`, `partialdef`, `extends`, `include`, functions inside `<script>`)
- Falls back to the language server for languages without rules (`functionBookmarks.detection.source`)
- Click to jump; the function under the cursor is highlighted
- English and Traditional Chinese (zh-tw) UI
