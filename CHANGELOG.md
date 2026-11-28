# Changelog

## 0.11.0 (2026-11-28) — AI assistants can read and add your bookmarks

- **Set Up AI Assistant Skill…** (side bar `…` menu): puts a skill (`SKILL.md`) and a small command-line tool in the project's `.cursor`, `.claude` or `.agents` skills folder. Cursor, Claude Code, Codex and other AI assistants can then list your bookmarks with their names, tags and notes, read a bookmark with its code, add or change bookmarks when you ask, and print a walkthrough of the numbered bookmarks. Asked where some code lives, the assistant checks your bookmarks first
- The tool uses the same detection rules as the extension and works out current positions even when the editor is closed; its changes show up in the side bar right away. It needs Node.js, stays on your computer (added to `.git/info/exclude`) and is updated together with the extension
- Exported bookmark files keep **bookmark numbers and colors**, and the tag colors they use. On import, a number you already use is not taken over, and the message says how many were skipped
- Walkthrough documents, Markdown tables and CSV exports mark bookmarks that *need checking*, are *not on this branch*, or whose function or file is gone, instead of quoting unrelated code from their old line
- Fix: going to a numbered bookmark, stepping through the tour, clicking a bookmark in the side bar and picking one in search no longer open a deleted file; the tour skips such steps and the status bar says the file is gone
- Going to a bookmark that *needs checking* shows a hint in the status bar on how to put it back
- Fix: a function bookmark whose function was gone was exported with the code now on its old line, so importing it put it on an unrelated line. It is now marked *needs checking* unless its remembered code is found
- Internal: the logic that does not depend on the editor moved into a shared core used by both the extension and the command-line tool

## 0.10.0 (2026-11-27) — eight more languages built in, and Simplified Chinese, Japanese and Korean

- **Built-in detection for Lua, Dart, Scala, Elixir, PowerShell, R, Haskell and Zig**: their functions, classes and methods are listed without a language extension (before, these used the language server and showed nothing without one). This includes Scala 3 indentation syntax, Dart constructors, Elixir functions with several clauses (shown as one), a Haskell type signature with its equations (shown as one), R6 classes, Zig generic types and `test` blocks, and ExUnit `describe` / `test`
- *Whole Project* also lists `.lua`, `.dart`, `.scala`, `.sc`, `.ex`, `.exs`, `.ps1`, `.psm1`, `.R`, `.hs` and `.zig` files. If you set `functionBookmarks.project.include` yourself, your setting is kept
- **Simplified Chinese, Japanese and Korean** user interface; the extension follows the display language of VS Code / Cursor
- Your own detection rules can use two new `body` values, `indentBlock` and `braceOrIndent`, and `mergeClauses` to show adjacent clauses with the same name as one symbol
- **Next / Previous Bookmark settings**: `functionBookmarks.bookmarks.navigationScope` can limit them to the current file, and turning off `functionBookmarks.bookmarks.navigationWrap` makes them stop at the last / first bookmark instead of wrapping around (the status bar says so). The defaults keep the old behavior
- README: a list of the supported languages
- Fix: pressing `Enter` after the indentation of a bookmarked line now moves the bookmark down with the code (it used to stay on the line left with only spaces)
- Fix: *Next / Previous Bookmark* skips bookmarks in files that were deleted, instead of getting stuck on them or opening a deleted file
- Fix: a `.vscode/function-bookmarks.json` saved with a BOM (for example by Notepad or PowerShell) is read again instead of being treated as broken; imported files with a BOM work too

## 0.9.2 (2026-11-27) — undo puts bookmarks back, sort by created time and fixes found with the mouse

- **Undo puts a bookmark back**: delete the line a bookmark is on, press `Ctrl+Z`, and the bookmark is on that line again (it no longer stays on the next line). This also works for a deleted block, for several undos in a row, and when `functionBookmarks.bookmarks.onLineDelete` is `remove`
- New tests check that bookmarks stay with their code when you move lines (`Alt+↑` / `Alt+↓`), join lines with `Backspace`, and when a formatter such as Prettier rewraps code
- **Sort by created time**: right-click a file in the bookmarks view and choose *Sort by Created Time* (oldest first; older bookmarks without a time come last). Side bar tooltips and function bookmark hovers show when a bookmark was created
- Jumping to a bookmark keeps you in a diff editor (either side), and uses the split that already shows the file instead of opening it again in the current one
- Fix: *Set Bookmark Number…* from the line number context menu no longer saves a broken number (the gutter icon showed `ct O`), and *Set Bookmark Color…* there opens the color list again
- Fix: *Move Bookmark to Cursor* and *Show Only on This Branch* no longer appear on every row of the side bar
- Fix: with the file still open, switching to a branch without that file now marks its bookmarks *not on this branch*
- Fix: a note with an unclosed code block no longer swallows the *Open in preview* link in hovers
- Fix: after a note is saved and closed, the status bar no longer keeps saying the note is being edited

## 0.9.1 (2026-11-26) — side bar menu fix and more project files

- Fix: commands in the bookmarks view's `…` menu no longer act on the item selected in the side bar. With a bookmark or file selected, *Import Bookmarks…* failed with *This is not valid JSON*, *Choose Bookmark Storage for This Workspace…* could save an invalid choice, *Export Bookmarks…* exported only the selected file, and *Set Tag Color…* skipped choosing the tag. Right-clicking a file row to export that file, and the color button on a tag row, work as before
- *Whole Project* also lists Python stub files (`.pyi`) and Django / Jinja templates (`.djhtml`, `.jinja`, `.jinja2`, `.j2`). If you set `functionBookmarks.project.include` yourself, your setting is kept
- README: version, CI and license badges, and a Ko-fi link for anyone who wants to support the extension
- Internal: the largest source files are split into smaller modules, with more unit tests

## 0.9.0 (2026-11-26) — new shortcuts, storage per workspace, importing a bookmarks file and many fixes

### Keyboard shortcuts have changed

All default shortcuts now start with `Alt+Shift+B` (`Ctrl+Shift+B` on macOS, instead of `Cmd+Alt`), then one more key. The old `Ctrl+Alt` shortcuts clashed with built-in VS Code / Cursor shortcuts and with AltGr characters on some keyboard layouts. If you set your own shortcuts, they are kept.

| Action | Before (Win / Linux) | Now (Win / Linux) | Now (macOS) |
| --- | --- | --- | --- |
| Add / remove a bookmark | `Ctrl+Alt+B` | `Alt+Shift+B B` | `Ctrl+Shift+B B` |
| Add a named bookmark | `Ctrl+Alt+Shift+B` | `Alt+Shift+B Shift+B` | `Ctrl+Shift+B Shift+B` |
| Rename the bookmark at the cursor | — | `Alt+Shift+B R` | `Ctrl+Shift+B R` |
| Next / previous bookmark | `Ctrl+Alt+.` / `Ctrl+Alt+,` | `Alt+Shift+B .` / `Alt+Shift+B ,` | `Ctrl+Shift+B .` / `Ctrl+Shift+B ,` |
| Search bookmarks | `Ctrl+Alt+/` | `Alt+Shift+B /` | `Ctrl+Shift+B /` |
| Focus bookmark search bar | `Ctrl+Alt+F` | `Alt+Shift+B F` | `Ctrl+Shift+B F` |
| Go to bookmark 1–9 | `Ctrl+Alt+1`–`9` | `Alt+Shift+B 1`–`9` | `Ctrl+Shift+B 1`–`9` |
| Set / remove number 1–9 | `Ctrl+Alt+Shift+1`–`9` | `Alt+Shift+B Shift+1`–`9` | `Ctrl+Shift+B Shift+1`–`9` |

Messages and hovers that mention a shortcut now show the one for your platform.

### Side bar and editing

- **Rename Bookmark** (`Alt+Shift+B R`, also in the editor context menu when the cursor is on a bookmark): renames the line bookmark on the cursor line, or the function bookmark there. `F2` in the side bar still renames the selected bookmark; clicking a bookmark in the side bar puts the focus back in the code, so `F2` there renames the code symbol as usual
- *Edit Tags*, *Rename Bookmark* and *Remove Bookmark* are in the Command Palette and work on the bookmark at the cursor, so everything can be done from the keyboard
- The side bar title is shorter (*Bookmarks*), so the current branch name is visible next to it
- In a multi-root workspace, files with the same name show their folder name
- With more than 30 bookmarks or 6 groups, the bookmark groups start collapsed, so *Current File* and *Whole Project* stay within reach
- While editing a note, *Current File* keeps showing the code file the note belongs to
- *Move Bookmark to Cursor* is no longer offered for function bookmarks (they follow their function)
- The `…` menu of the bookmarks view is in a clearer order
- Importing a file that is not a bookmarks file now just says it does not match the Function Bookmarks format

### Storage per workspace, and importing a bookmarks file

- **Choose Bookmark Storage for This Workspace**: keep one project's bookmarks in `.vscode/function-bookmarks.json` and another's in the editor's workspace storage. The choice is saved by the editor, not in the project; *Follow setting* goes back to `functionBookmarks.storage`, which is now the default for every workspace without a choice of its own. In the Command Palette and the bookmarks view's `…` menu
- If the current storage has no bookmarks but the other one does (for example, the *Copy bookmarks?* notification was closed after changing the storage), you are asked again at startup. *Keep empty* stops asking. The check runs in the background and does not slow down startup
- **Import → From a file** accepts a `.vscode/function-bookmarks.json` file: its bookmarks become your own (bookmarks from other sources in it are kept), merged with or replacing what you have, and relocated against your files. Picking the file the workspace is already using says so instead of showing an error
- *Choose Bookmark Storage* and the storage prompts mark which place is *current* and which one is *in effect*
- Changing the storage no longer clears the bookmarks saved for other branches
- After clearing all your bookmarks, you are no longer asked to copy them back from the other storage

### Fixes

- Cancelling a note and opening it again right away no longer shows a deleted tab and an empty preview
- Pressing `Esc` while setting a number or color on a line without a bookmark no longer leaves an empty bookmark behind
- In a file that had just been opened, the first edit that rewrote a bookmarked line could delete the bookmark or mark it as *needs checking*; the bookmark now stays on its line
- *Export Bookmarks…* from a file row in the side bar exports only that file
- Saving is queued, so quick changes can no longer overwrite each other, and closing the window waits for pending saves
- In a multi-root workspace, *Clean Up Records of Deleted Branches* no longer removes another folder's records
- The bookmarks file is kept out of git (`.git/info/exclude`) in git worktrees and in projects opened from a subfolder of a repository
- Pressing `Esc` during *Search Functions* no longer leaves the search running in the background

### Faster

- Typing in a file with bookmarks only rechecks the lines you changed
- Moving bookmarks by line no longer rechecks every function bookmark
- Files over 2 MB are skipped when looking for renamed files

## 0.8.3 (2026-11-25) — sort a file's bookmarks by title

- **Sort by title, per file**: when bookmarks are grouped by file, each file row has a sort button (also in its context menu). Click it to list that file's bookmarks by title — natural order, so `item2` comes before `item10`, ignoring case — and click again to go back to line order. Each file remembers its choice after a restart, and a file sorted by title shows *by title* next to its name. Next / Previous Bookmark, tours, search and export keep line order

## 0.8.2 (2026-11-24) — faster startup, guided tours and smaller fixes

- **Faster startup**: the side bar lists your bookmarks almost immediately after the window opens. Projects with a bookmark file start the extension right away instead of waiting for every other extension, and checking function bookmarks, the current file and changes made while the editor was closed now run in the background — startup no longer waits for language servers (TypeScript, Pylance…). Startup timings are written to the *Function Bookmarks* output channel
- **Tour: Next / Previous Numbered Bookmark**: step through bookmarks 1–9 in order, across files and folders. The status bar shows *Tour 2/5: name*, and the hover with the note opens by itself. In the Command Palette and the bookmarks view's `…` menu (no default shortcut)
- **Export → Walkthrough document (Markdown)**: numbered bookmarks first, then the rest by file and line; each with its location, a code snippet (the function body up to 30 lines, or 3 lines around a line bookmark) and its note. *Without code* leaves the snippets out
- *Search Bookmarks* (`Ctrl+Alt+/`) shows the first line of the note and searches the whole note, `#tag` and `@source` work there too, bookmarks that *need checking* or are *not on this branch* are marked (and hidden when *Hide Bookmarks Not on This Branch* is on), and in a multi-root workspace the folder name is shown
- Editing tags suggests the tags used by all bookmarks, function bookmarks included; adding a function bookmark by giving it a tag follows `bookmarks.autoNumber`
- New setting `notes.closeOnSave` (default `true`): set it to `false` to keep the note tab open after saving
- Changing `functionBookmarks.storage` asks whether to copy your bookmarks to the new place (or merge / replace when it already has some), so they do not seem to disappear
- macOS shortcuts for numbered bookmarks: `Cmd+Alt+1`–`9` jumps, `Cmd+Alt+Shift+1`–`9` sets a number; the note editor's status bar message shows `Cmd+S` on macOS
- The language server fallback also lists interfaces, structs, enums, modules and namespaces
- Leftover note editor files from a crash are cleaned up at startup
- **Edit Note** in the line number context menu: right-click a line number to edit the note of the bookmark on that line; a line without a bookmark gets one first (a function bookmark on a function's name line, otherwise a line bookmark)
- Fix: *Edit Note* from the Command Palette edits the note of the line bookmark under the cursor instead of looking for a function
- Fix: *Preview Note* appeared twice in the side bar context menu of a bookmark with a note

## 0.8.1 (2026-11-24) — bookmark fixes and demo GIFs

- Fix: after typing above a bookmark in a file that had just been opened or saved, saving right away (within about 0.3 s) could leave the bookmark on its old line number for good. The first edit of a clean file was mistaken for a reload from disk; it is now handled like any other edit
- Fix: deleting a bookmarked line as the first edit of a clean file now follows `bookmarks.onLineDelete` (`remove`, `markLost`, `moveToNext`) every time
- A bookmark that *needs checking* shows a grey bookmark with a question mark in the gutter (and the overview ruler), instead of its normal color; hover the line to see why
- Setting a tag color in a multi-root workspace no longer creates an empty bookmark file in folders that have no bookmarks; clearing a color removes it from every folder that has it
- README: short GIFs of function bookmarks, line bookmarks and Markdown notes

## 0.8.0 (2026-11-23) — search bar, more languages, bug fixes and performance

- **Search** from the first row of the side bar (or `Ctrl+Alt+F`): type to filter the bookmarks right away — by name, tag, file, function, the code on the line or the note. Matches are highlighted, groups with no match are hidden, and the title shows *N of M match*. `#tag` searches tags only, `@source` shows only that person's bookmarks. `Enter` opens the first match, `↓` moves to the list, `Esc` clears; the ✕ on the row clears too. The text is kept after a restart. The drop-down *Search Bookmarks* (`Ctrl+Alt+/`) is still there

- **Protocol Buffers**: `service` with its `rpc`s, nested `message`s, `enum`, `oneof` and `extend` (works with or without a proto extension)
- **Vue and Svelte**: functions in `<script>`, `<script setup>`, `<script lang="ts">` and `<script lang="jsx">`; a `<script>` commented out in the template is not listed
- **Shell** (sh, bash, zsh): `name() {}` and `function name {}`; comments, strings, heredocs and `case` patterns do not break range detection
- **SQL**: `CREATE FUNCTION`, `PROCEDURE`, `TRIGGER`, `VIEW` and Oracle `PACKAGE`, each up to the end of its statement — `;`, `GO` (SQL Server), `/` (Oracle) or MySQL's `DELIMITER`; PostgreSQL `$$` bodies are handled. In a file split by `GO`, a missing `GO` before the next `CREATE VIEW` / `PROCEDURE` does not stretch the previous one. New rule body type `statement` for your own rules
- *Whole Project* includes `.proto`, `.vue`, `.svelte`, `.sh`, `.bash`, `.zsh` and `.sql` files
- Internal: each language now lives in its own file (comment and string handling, file extensions and rules together), so adding a language touches one place

- Fix: **Filter by Source…** now also hides your own function bookmarks when *Mine* is unchecked — in the side bar and its count, the gutter, next / previous, search and the status bar (a hidden function bookmark with a note no longer shows a note icon instead)
- Fix: a bookmark that is *not on this branch* is no longer removed when you press `Ctrl+Alt+B` on the line where it happens to sit, and is not deleted or marked as *needs checking* when that line is deleted (`bookmarks.onLineDelete`). Actions on the cursor line (toggle, rename, tags, note, number, color, move) only see the bookmarks shown in the gutter
- *Clear Bookmarks in File* and *Clear All Bookmarks* only clear the bookmarks you can see; bookmarks from other branches and hidden sources are kept
- Adding a bookmark while *Mine* is hidden by the source filter keeps your filter and shows a message with a *Show* button. A hidden bookmark of yours on that line is not removed or duplicated
- Fix: when grouping bookmarks by source, each bookmark shows its file name (as when grouping by tag)
- Fix: switching tabs quickly could leave the side bar or gutter showing the previous file's functions
- Fix: with Windows line endings (CRLF), a string continued with a backslash at the end of a line (JavaScript, C family, Python) hid every function after it; Markdown sections no longer include the blank line before the next heading
- The *Add bookmark* / *Remove bookmark* link in the hover closes the hover (it cannot update while open) and shows the result in the status bar
- Fix: Mermaid diagrams in a note (or any Markdown preview) were only drawn after the text was changed, not when the preview first opened
- Fix: the Mermaid preview could miss an update while it was still drawing
- Faster: the Markdown preview loads Mermaid (about 5 MB) only when the page has a Mermaid block
- Faster: one shared file watcher instead of three; changes inside `.git` are ignored, and *Whole Project* rescans only the affected workspace folder when a matching file is added or deleted
- Faster: *Whole Project* shows a folder's files right away and counts their functions in the background
- Less memory when relocating bookmarks after large changes to big files
- Function detection for the same file version is shared between the side bar, gutter and hover, and the cache drops the least recently used files instead of clearing everything
- Clearer wording in the settings, messages, README and Traditional Chinese translation; the example detection rule in the README no longer overrides the built-in Go rule

## 0.7.0 (2026-11-22) — more languages

- Functions, classes and methods are detected in **C / C++, Rust, Go, Java, C#, Kotlin, Swift, PHP and Ruby** without any language extension: C++ `Class::method`, namespaces and templates; Rust `impl` blocks (`Display for Point`), traits, `mod` and `macro_rules!`; Go methods shown as `Server.Start`; Java / C# annotations, attributes, constructors and `=>` bodies; Kotlin data classes and `= expression` functions; PHP only inside `<?php ?>`; Ruby `def` … `end` by indentation
- Declarations without a body (prototypes, abstract and interface methods) are not listed; comments and strings of each language (raw strings, Rust lifetimes, C# verbatim strings, heredocs, text blocks) are ignored
- Whole Project and Search Functions include these files; `target`, `vendor`, `obj`, `.gradle` and `Pods` folders are excluded by default
- Files the editor opens as plain text (for example Kotlin without a Kotlin extension) are detected by their file extension
- New rule body type `end` for your own rules (languages that end blocks with `end`)
- Checked against a real project (React front end, Python back end, Markdown docs) and compared with the TypeScript and Python parsers. Fixes: Python functions no longer end early when a multi-line string starts or ends at column 0 (embedded JS, Jira text); a class or def whose body is only a docstring covers the whole docstring; `const el = (<Tag …/>)` and `const v = (() => …)()` are no longer listed as functions; arrow functions with calls in default parameters and `useCallback(` with the function on the next line are found; a BOM at the start of a file no longer hides the first heading or `def`
- **React / JSX**: components wrapped in `memo`, `forwardRef` or `observer` and functions in `useCallback` are listed; text and attribute values inside JSX (`<p>Don't</p>`, `</a>`) no longer confuse brace matching in `.js`, `.jsx` and `.tsx` files
- Shorter extension description: bookmarks on functions and lines with your own names
- README: shorter introduction; examples use a fictional name
- The side bar icon is now an icon font, so it is as bright as the built-in icons (image icons were drawn dimmer in Cursor's toolbar)

## 0.6.0 (2026-11-22) — everyday comfort (M7) and Marketplace preparation (M8)

- **Numbered bookmarks**: `Ctrl+Alt+Shift+1`–`9` sets (or removes) a number on the current line — adding a bookmark there if needed — and `Ctrl+Alt+1`–`9` jumps to it, across files and workspace folders. Also *Set Bookmark Number…* in the context menus and *Go to Numbered Bookmark…*. Asks before moving a number that is already used. New setting `functionBookmarks.bookmarks.autoNumber` gives new bookmarks the next free number
- **Colors**: *Set Bookmark Color…* and *Set Tag Color…* (also on a tag when grouping by tag). A bookmark uses its own color, otherwise its first colored tag. The gutter icon, overview ruler and side bar follow
- The gutter icon shows the bookmark number
- **Bookmark name at the end of the line** (faint); setting `functionBookmarks.bookmarks.showLabelAtLineEnd`
- **Hide Bookmark Icons Temporarily** (side bar `…` menu), e.g. to set breakpoints
- **Status bar**: bookmarks in the current file, plus the source filter and hidden-icon state; click to search. Setting `functionBookmarks.statusBar.enabled`
- **Test Detection Rules on This File**: highlights what each rule finds, with the rule id at the end and details on hover; updates while you edit
- Settings are grouped (Bookmarks, Function Detection, Whole Project, Storage and Sharing) and every command has the *Function Bookmarks* category in the Command Palette
- Extension icon, English and Traditional Chinese README, release workflow for the Marketplace and Open VSX
- Fix: in a project with only line bookmarks (no function bookmarks), `.vscode/function-bookmarks.json` was never created, so the bookmarks were lost after reopening
- Tested in a multi-root workspace

## 0.5.1 (unreleased)

- **Import Bookmarks…** also recognizes the `.vscode/bookmarks.json` of the Bookmarks extension (alefragnani) and adds them as your own bookmarks; the file dialog opens there when the file exists. The separate *Import from Bookmarks (alefragnani)* command is removed

## 0.5.0 (unreleased) — share bookmarks (M6)

- **Export Bookmarks…**: all, by tag, the current file, chosen bookmarks, or a file / folder from the Explorer context menu. Line and function bookmarks. Save as `*.fbookmarks.json` or copy to the clipboard (both can be imported), or export a **Markdown table** / **CSV file**
- A warning before exporting that the export contains code, with a *Without code* option
- **Import Bookmarks…** from a file or the clipboard: enter a source note (defaults to the exporter, e.g. `alex.chen`), preview, and **replace** or **merge** when the same source was imported before. Warns when the export comes from another repository
- Imported bookmarks land on the right lines even if your copy of the file is different: the export carries a hash of every line of the bookmarked files, compared with your files (no git needed — works when the other person has not pushed yet). Function bookmarks are found by name
- **Filter by Source…**: check which sources to show (mine, alex.chen, …); hidden sources disappear from the side bar, gutter, next / previous and search. **Group Bookmarks by Source**
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
