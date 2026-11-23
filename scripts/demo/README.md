# Demo GIF Recording Scripts

Automated recording pipeline for the 3 README demo GIFs in `images/`:

- `images/function-bookmarks.gif` — Function list, function bookmark (`Ctrl+Alt+B`), custom display name (`Rename`), and cross-file jump
- `images/line-bookmarks.gif` — Line bookmark, named bookmark with faint end-of-line label & tags, tracking across inserted lines, and next/previous jump (`Ctrl+Alt+.` / `Ctrl+Alt+,`)
- `images/markdown-notes.gif` — Side-by-side Markdown note editing & live preview, save, and rendered hover tooltip

## Prerequisites

- Windows with VS Code installed (default: `%LOCALAPPDATA%/Programs/Microsoft VS Code/Code.exe`, override via `--vscode=...` or `VSCODE_EXECUTABLE`)
- `ffmpeg` and `ffprobe` (default: `C:/Program Files/FFMPEG/bin/ffmpeg.exe`, override via `--ffmpeg=...` or `FFMPEG_PATH`)
- Node.js (the project's existing dependencies; no extra packages required)

## Re-recording

Record all 3 GIFs (automatically runs `npm run compile` first):

```powershell
node scripts/demo/record.mjs
```

Record only specific scene(s):

```powershell
node scripts/demo/record.mjs --only=function-bookmarks
node scripts/demo/record.mjs --only=line-bookmarks,markdown-notes
```

Useful options:

- `--skip-compile` — Skip `npm run compile`
- `--keep-temp` — Keep `%TEMP%\fb-demo-*` (raw `.mp4`, temp workspace, VS Code profile) for inspection
- `--gif-width=960` — Output GIF width in pixels (default: `960`)
- `--fps=12` — Capture & output frame rate (default: `12`)
- `--crop-top=36` — Pixels cropped from top of window to exclude the title bar (default: `36`)

## Files

- `record.mjs` — Orchestrator: prepares temp VS Code profile/workspace in `%TEMP%`, launches VS Code, captures frames via Win32 `PrintWindow (PW_RENDERFULLCONTENT)` piped to `ffmpeg`, converts MP4 to optimized GIF (`palettegen`/`paletteuse`), and cleans up
- `driver.js` — VS Code extension host driver (`--extensionTestsPath`) that executes the timed steps for each scene
- `win32.ps1` — PowerShell/Win32 helper for positioning/topmosting the VS Code window and streaming `PrintWindow` BGRA frames to `ffmpeg`
- `sample-project/` — Small TypeScript demo project (`orders.ts`, `cart.ts`) copied to `%TEMP%` before each recording
