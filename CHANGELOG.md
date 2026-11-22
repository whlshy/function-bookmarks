# Changelog

## 0.5.0 (unreleased) — share bookmarks (M6)

- **Export Bookmarks…**: all, by tag, the current file, chosen bookmarks, or a file / folder from the Explorer context menu. Line and function bookmarks. Save as `*.fbookmarks.json` or copy to the clipboard (both can be imported), or export a **Markdown table** / **CSV file**
- A warning before exporting that the export contains code, with a *Without code* option
- **Import Bookmarks…** from a file or the clipboard: enter a source note (defaults to the exporter, e.g. `henry.hsu`), preview, and **replace** or **merge** when the same source was imported before. Warns when the export comes from another repository
- Imported bookmarks land on the right lines even if your copy of the file is different: the export carries a hash of every line of the bookmarked files, compared with your files (no git needed — works when the other person has not pushed yet). Function bookmarks are found by name
- **Filter by Source…**: check which sources to show (mine, henry.hsu, …); hidden sources disappear from the side bar, gutter, next / previous and search. **Group Bookmarks by Source**
- Others' bookmarks have a purple icon and show their source on hover
- Rename a source, delete all bookmarks from a source, **Make It Mine**
- New setting `functionBookmarks.authorName` (defaults to git `user.name`)

## 0.4.0 (unreleased) — branch switching (M5)

- **Each branch remembers its own bookmark positions.** When you leave a branch, the extension notes where every bookmark was and what the file looked like; when you come back, positions are worked out from that — switching back and forth never accumulates drift, even if the branch got new commits in between
- Bookmarks on code that does not exist on the current branch (or in a file that does not exist there) are shown as **not on this branch** (grey branch icon) instead of *needs checking*, and come back automatically when you switch to a branch that has the code
- **Fixed**: switching branches with the file open moved bookmarks on branch-only code to the next line, and they did not come back. Reloads of open files are now matched by content too
- **Files renamed between branches** (or by other tools): bookmarks follow the renamed file (matched by content) and follow it back
- **Show Only on This Branch** / **Show on All Branches** (bookmark context menu): branch-only bookmarks are hidden on other branches
- The current branch is shown next to the side bar title; **Hide / Show Bookmarks Not on This Branch** in the title menu
- **Clean Up Records of Deleted Branches** removes position records of branches that no longer exist
- Handles rebase (counts as the branch being rebased), detached HEAD, git still writing files (`index.lock`), worktrees and submodules

## 0.3.0 (unreleased) — bookmarks follow changes made outside the editor (M4 / M5)

- **Line bookmarks now follow `git pull`, branch switches, merges, rebases, formatters, scripts and AI edits — even when the file is not open.** The extension remembers the content each bookmark's line number refers to and compares it with the new content (line diff). Local uncommitted changes are handled the same way
- Checked when a file changes on disk (changes to many files at once are processed together), when a file is opened or closed without saving, when the whole document is replaced, when Git HEAD changes, when the window regains focus and on startup
- **Fallback relocation** when the bookmarked line itself was changed or moved: identical line with matching surroundings, same offset inside the same function, or a similar line nearby. Very short or common lines (`}`, `pass`, `return`) need matching surroundings
- Bookmarks that cannot be found, or that fall inside a **merge conflict**, are marked *needs checking* (greyed out with a warning icon). Conflict bookmarks come back automatically once the conflict is resolved
- **Edits that replace several lines with several lines** — Cursor applying an AI change to a whole function, pasting over a selection, moving lines with Alt+↑/↓ — are now matched by content instead of shifting by line number, so a bookmark inside the replaced block stays on its line (previously it was treated as deleted and moved to the next line)
- Tested against simulated Cursor AI edits on a real Django view: direct disk writes, streaming partial writes, write-to-temp-then-rename, reload of an open file, block-by-block edits in the editor, moving and deleting functions, several files at once
- **Move Bookmark to Cursor**: put a bookmark back on the right line (side bar context menu, inline button on bookmarks that need checking, or the Command Palette)
- **Import from Bookmarks (alefragnani)**: reads `.vscode/bookmarks.json` (turn on `bookmarks.saveBookmarksInProject` in that extension first); labels are kept, lines that already have a bookmark are skipped

## 0.2.3 (unreleased)

- **Renaming a function in code no longer breaks its bookmark**: when a function's name changes (in the editor or from outside, e.g. `git pull`), its bookmark, display name, note and tags move to the new name. Matched by the last known line (same line first, then within 3 lines) and kind; only when there is exactly one candidate. Renaming a class carries over its methods too
- Rename and notes now require the function to be bookmarked first: the hover shows only *☆ Add bookmark* until then, the side bar menu hides *Rename* / *Edit Note*, and the editor commands offer to add the bookmark. Existing display names and notes stay editable
- "Toggle Bookmark" is now labeled **Add / Remove Bookmark**

## 0.2.2 (unreleased)

- **Hover a function name** to get a popup with **☆ Add bookmark / ★ Remove bookmark**, **Rename** and **Note** — no extra line above the code. The note is shown in the same popup. Turn off with `functionBookmarks.hover.enabled`
- Removed the *☆ Add bookmark* line above functions (CodeLens) added in 0.2.1

## 0.2.0 (unreleased) — bookmarks and favorites merged

- **One kind of bookmark, two targets**: favorites are now *function bookmarks* and live in the same **Bookmarks** section as line bookmarks, sorted by line within each file. Grouping by file or by tag includes both
- `Ctrl+Alt+B` on the name line of a function, class, block or heading toggles a **function bookmark** (follows the name, never drifts); on any other line it toggles a line bookmark
- Function bookmarks can have **tags**; rename, notes, preview, remove and clear work the same for both kinds
- Next / previous bookmark and Search Bookmarks include function bookmarks
- **Line number context menu**: right-click a line number to toggle a bookmark or add one with a name
- Gutter: one teal bookmark icon; function bookmarks show a star
- The *Show favorites only* filter and favorites grouping options are merged into *Show bookmarks only* and *Group bookmarks by file / tag*
- Existing favorites keep working — no data migration needed
- Fixed: after clicking a bookmark, following the cursor moved the side bar selection to the nearest function

## 0.1.0 (unreleased) — line bookmarks (M3)

- **Line bookmarks**: toggle with `Ctrl+Alt+B` (multi-cursor toggles every line), or `Ctrl+Alt+Shift+B` to add one with a name — suggested from the selection, the word under the cursor, the enclosing function or the line text
- **Bookmarks section** in the side bar, grouped by file or by tag; rename, tags (`#auth #todo`), multi-line Markdown notes with preview, remove, clear file / clear all (with confirmation)
- **Show bookmarks only** filter
- **Next / previous bookmark** across files (`Ctrl+Alt+.` / `Ctrl+Alt+,`), wrapping around
- **Search bookmarks and favorites** (`Ctrl+Alt+/`) by name, tag, file, function or line text
- Teal gutter icon and overview-ruler mark on bookmarked lines; hovering a bookmarked line with a note shows the note
- **Bookmarks follow edits** made in the editor: inserting or deleting lines above, pressing Enter at the start of the line. `functionBookmarks.bookmarks.onLineDelete` decides what happens when the line itself is deleted (`moveToNext`, `markLost`, `remove`)
- Bookmarks in an **open** file also follow changes made outside the editor (e.g. `git pull`), because VS Code / Cursor reload the file as a precise diff. Files that are not open will be handled by the git-based tracking in M4
- Each bookmark stores an anchor (line text, surrounding lines, enclosing function), refreshed on save, for the upcoming git / fallback relocation
- Hovers show Mermaid blocks as source code

## 0.0.8 (unreleased)

- **Mermaid in Markdown previews**: the built-in Markdown preview (VS Code and Cursor) now renders ```` ```mermaid ```` diagrams — for notes and for any `.md` file. Skipped automatically when *Markdown Preview Mermaid Support* is installed
- Note editing opens the built-in preview side by side again: it shows the rendered view right away and **scrolls with the editor**. In Cursor the note is edited as `.markdown` so the left side stays a plain text editor
- Hovers show Mermaid blocks as source code
- Bundles mermaid 12.3.0 (MIT, see ThirdPartyNotices.md)

## 0.0.6

- **Note preview**: editing a note opens VS Code's / Cursor's Markdown preview side by side; both tabs close when you save
- **Preview Note** (right-click, or *Open in preview* in the hover) shows the note in a full Markdown preview — images, tables and code highlighting included

## 0.0.5

- **Markdown outline**: headings (`#` … `######` and `===` / `---` underlines) are listed as a nested table of contents; `#` inside code blocks, HTML comments and front matter is ignored. Headings can be favorited, renamed and noted like functions
- Clicking a favorite no longer moves the side bar selection to the same function under Current file, and following the cursor no longer expands a section you collapsed
- Fixed: favorites could disappear briefly when the bookmarks file was read while being written

## 0.0.4

- **Notes**: write a multi-line Markdown note for any function (right-click → Edit Note). It opens in an editor tab; save (Ctrl+S) to apply and close, save empty to delete
- Notes are shown on hover only: in the side bar tooltip and when hovering the function name in the editor. Functions with notes get a blue icon in the side bar and a note icon next to the line number
- Search Functions also shows the first line of the note

## 0.0.3

- **Event listeners**: jQuery `.on()` / `.click()` and friends, `addEventListener`, `el.onclick = …`, `$(document).ready`, and HTML `onclick="…"` attributes are listed with readable names such as `#toggleBtn click`
- **Requests**: `$.ajax`, `$.get`, `$.post`, `fetch` and `axios` are listed as `GET /do_action`; their `success` / `error` callbacks are no longer listed separately
- **Gutter icon** next to the line number of favorited functions
- The side bar remembers which nodes you expanded or collapsed, per file, across file switches and restarts; the current file stays listed while focus is in a terminal or settings page
- **Whole project**: files without functions have no expand arrow and open on click
- Fixed: `setTimeout(function () {…})`, `$(function () {…})` were detected as methods
- Fixed: favorites could revert when toggled quickly (late file-change notification)
- Detection rules: new `nameTemplate`, `matchRaw`, `hideChildren` and `body: "call"`

## 0.0.2

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
