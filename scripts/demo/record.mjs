import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SAMPLE_SRC = path.join(__dirname, 'sample-project');
const DRIVER_PATH = path.join(__dirname, 'driver.js');
const WIN32_PS1 = path.join(__dirname, 'win32.ps1');
const IMAGES_DIR = path.join(REPO_ROOT, 'images');

const ALL_SCENES = ['function-bookmarks', 'line-bookmarks', 'markdown-notes'];

function parseArgs(argv) {
  const opts = {
    scenes: [...ALL_SCENES],
    keepTemp: false,
    skipCompile: false,
    vscode: process.env.VSCODE_EXECUTABLE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Microsoft VS Code', 'Code.exe'),
    ffmpeg: process.env.FFMPEG_PATH || 'C:/Program Files/FFMPEG/bin/ffmpeg.exe',
    width: 1280,
    height: 800,
    gifWidth: 960,
    fps: 12,
    titleBarCrop: 36,
    windowX: 120,
    windowY: 80,
  };
  for (const arg of argv) {
    if (arg === '--keep-temp') opts.keepTemp = true;
    else if (arg === '--skip-compile') opts.skipCompile = true;
    else if (arg.startsWith('--only=')) {
      opts.scenes = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--vscode=')) opts.vscode = arg.slice('--vscode='.length);
    else if (arg.startsWith('--ffmpeg=')) opts.ffmpeg = arg.slice('--ffmpeg='.length);
    else if (arg.startsWith('--gif-width=')) opts.gifWidth = Number(arg.slice('--gif-width='.length));
    else if (arg.startsWith('--fps=')) opts.fps = Number(arg.slice('--fps='.length));
    else if (arg.startsWith('--crop-top=')) opts.titleBarCrop = Number(arg.slice('--crop-top='.length));
  }
  return opts;
}

function runWin32(action, extraArgs = []) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN32_PS1, '-Action', action, ...extraArgs];
  const out = execFileSync('powershell.exe', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.trim();
}

function makeSettingsJson() {
  return {
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.welcomePage.walkthroughs.openOnInstall': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.layoutControl.enabled': false,
    'workbench.editor.enablePreview': false,
    'workbench.statusBar.visible': true,
    'window.commandCenter': false,
    'window.menuBarVisibility': 'hidden',
    'window.titleBarStyle': 'custom',
    'window.restoreWindows': 'none',
    'window.newWindowDimensions': 'default',
    'editor.fontSize': 15,
    'editor.lineHeight': 23,
    'editor.minimap.enabled': false,
    'editor.scrollbar.verticalScrollbarSize': 10,
    'editor.hover.delay': 300,
    'editor.hover.sticky': true,
    'editor.quickSuggestions': { other: false, comments: false, strings: false },
    'editor.parameterHints.enabled': false,
    'editor.suggestOnTriggerCharacters': false,
    'editor.inlineSuggest.enabled': false,
    'editor.codeLens': false,
    'editor.lightbulb.enabled': 'off',
    'editor.stickyScroll.enabled': false,
    'breadcrumbs.enabled': false,
    'update.mode': 'none',
    'extensions.ignoreRecommendations': true,
    'telemetry.telemetryLevel': 'off',
    'chat.disableAIFeatures': true,
    'chat.commandCenter.enabled': false,
    'security.workspace.trust.enabled': false,
    'markdown.preview.fontSize': 14,
    'markdown.preview.breaks': false,
    'functionBookmarks.storage': 'file',
  };
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startWindowCapture(ffmpegPath, windowInfo, outFile, stopFile, fps, cropTop) {
  if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile);
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', WIN32_PS1,
    '-Action', 'capture',
    '-Hwnd', String(windowInfo.hwnd),
    '-FfmpegPath', ffmpegPath,
    '-OutFile', outFile,
    '-StopFile', stopFile,
    '-Fps', String(fps),
    '-CropTop', String(cropTop),
  ];
  console.log(`  [capture] PrintWindow(PW_RENDERFULLCONTENT) hwnd=${windowInfo.hwnd} @ ${fps}fps (cropTop=${cropTop}) -> ${path.basename(outFile)}`);
  const proc = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout.on('data', (c) => { stdoutBuf += c.toString('utf8'); });
  proc.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });
  return { proc, stopFile, getStdout: () => stdoutBuf.trim(), getStderr: () => stderrBuf.trim() };
}

async function stopWindowCapture(capture) {
  if (!capture) return;
  const { proc, stopFile, getStdout, getStderr } = capture;
  fs.writeFileSync(stopFile, 'stop', 'utf8');
  if (proc.exitCode === null) {
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    const timeout = sleep(15000).then(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    });
    await Promise.race([exited, timeout]);
  }
  const out = getStdout();
  const err = getStderr();
  if (out) console.log(`  [capture] ${out}`);
  if (err) console.error(`  [capture:err] ${err}`);
}

function convertToGif(ffmpegPath, inputMp4, outputGif, palettePng, gifWidth, fps) {
  const vfCommon = `fps=${fps},scale=${gifWidth}:-1:flags=lanczos`;
  execFileSync(
    ffmpegPath,
    ['-y', '-i', inputMp4, '-vf', `${vfCommon},palettegen=stats_mode=diff:max_colors=256`, palettePng],
    { stdio: 'pipe' },
  );
  execFileSync(
    ffmpegPath,
    [
      '-y',
      '-i', inputMp4,
      '-i', palettePng,
      '-lavfi', `${vfCommon} [x]; [x][1:v] paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
      '-loop', '0',
      outputGif,
    ],
    { stdio: 'pipe' },
  );
}

function probeMedia(ffmpegPath, filePath) {
  const ffprobePath = path.join(path.dirname(ffmpegPath), 'ffprobe.exe');
  const out = execFileSync(
    ffprobePath,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,duration', '-show_entries', 'format=duration,size', '-of', 'json', filePath],
    { encoding: 'utf8' },
  );
  const info = JSON.parse(out);
  const stream = info.streams?.[0] || {};
  const format = info.format || {};
  let fpsVal = 0;
  if (stream.r_frame_rate && stream.r_frame_rate.includes('/')) {
    const [n, d] = stream.r_frame_rate.split('/').map(Number);
    fpsVal = d ? +(n / d).toFixed(2) : 0;
  }
  return {
    width: stream.width,
    height: stream.height,
    fps: fpsVal,
    durationSec: +(Number(format.duration || stream.duration || 0)).toFixed(2),
    sizeBytes: Number(format.size || fs.statSync(filePath).size),
  };
}

function createControlServer(handlers) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const body = raw ? JSON.parse(raw) : {};
          const fn = handlers[req.url];
          if (!fn) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: `Unknown endpoint ${req.url}` }));
            return;
          }
          const result = (await fn(body)) ?? { ok: true };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`  [control error] ${req.url}:`, err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function recordScene(scene, opts, tempRoot) {
  console.log(`\n=== Recording scene: ${scene} ===`);
  const sceneDir = path.join(tempRoot, scene);
  const workspaceDir = path.join(sceneDir, `shop-demo-${scene}`);
  const userDataDir = path.join(sceneDir, 'user-data');
  const extensionsDir = path.join(sceneDir, 'extensions');
  const rawMp4 = path.join(sceneDir, `${scene}.mp4`);
  const stopFile = path.join(sceneDir, `${scene}.stop`);
  const palettePng = path.join(sceneDir, `${scene}-palette.png`);
  const outputGif = path.join(IMAGES_DIR, `${scene}.gif`);

  copyDir(SAMPLE_SRC, workspaceDir);
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'User', 'settings.json'),
    JSON.stringify(makeSettingsJson(), null, 2),
    'utf8',
  );

  let windowInfo = null;
  let capture = null;

  const { server, url } = await createControlServer({
    '/log': ({ message }) => {
      console.log(`  ${message}`);
      return { ok: true };
    },
    '/ready': async () => {
      const titleMatch = path.basename(workspaceDir);
      const raw = runWin32('focus-and-position', [
        '-TitleMatch', titleMatch,
        '-X', String(opts.windowX),
        '-Y', String(opts.windowY),
        '-Width', String(opts.width),
        '-Height', String(opts.height),
      ]);
      windowInfo = JSON.parse(raw);
      console.log(`  [win32] hwnd=${windowInfo.hwnd} fg=${windowInfo.isForeground} rect=${windowInfo.left},${windowInfo.top} ${windowInfo.width}x${windowInfo.height}`);
      return windowInfo;
    },
    '/start-recording': async () => {
      if (!windowInfo) throw new Error('Window not positioned before start-recording');
      capture = startWindowCapture(opts.ffmpeg, windowInfo, rawMp4, stopFile, opts.fps, opts.titleBarCrop);
      // Give PowerShell + Add-Type a moment to compile and start grabbing frames
      await sleep(1600);
      return { ok: true };
    },
    '/stop-recording': async () => {
      console.log('  [capture] stopping capture');
      await stopWindowCapture(capture);
      capture = null;
      return { ok: true };
    },
    '/type-text': ({ text, delayMs = 55, pressEnter = false }) => {
      console.log(`  [win32] type-text "${text}" (enter=${pressEnter})`);
      const extra = ['-Text', text, '-DelayMs', String(delayMs)];
      if (windowInfo?.hwnd) extra.push('-Hwnd', String(windowInfo.hwnd));
      if (pressEnter) extra.push('-PressEnter');
      runWin32('type-text', extra);
      return { ok: true };
    },
    '/press-key': ({ key }) => {
      const extra = ['-Key', key];
      if (windowInfo?.hwnd) extra.push('-Hwnd', String(windowInfo.hwnd));
      runWin32('press-key', extra);
      return { ok: true };
    },
  });

  // Strip ELECTRON_RUN_AS_NODE before spawning VS Code
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.FB_DEMO_CONTROL_URL = url;
  env.FB_DEMO_SCENE = scene;

  const codeArgs = [
    workspaceDir,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    `--extensionDevelopmentPath=${REPO_ROOT}`,
    `--extensionTestsPath=${DRIVER_PATH}`,
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    '--new-window',
  ];

  let codeProc = null;
  try {
    codeProc = spawn(opts.vscode, codeArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    codeProc.stdout.on('data', (d) => {
      const s = d.toString('utf8').trim();
      if (s && /error|fail|driver/i.test(s)) console.log(`  [vscode:out] ${s}`);
    });
    codeProc.stderr.on('data', (d) => {
      const s = d.toString('utf8').trim();
      if (s && /error|fail|exception/i.test(s)) console.log(`  [vscode:err] ${s}`);
    });

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Scene "${scene}" timed out after 90s`)), 90000);
      codeProc.once('error', (e) => { clearTimeout(timer); reject(e); });
      codeProc.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });

    if (exitCode !== 0) {
      throw new Error(`VS Code exited with code ${exitCode} for scene "${scene}"`);
    }
  } finally {
    await stopWindowCapture(capture).catch(() => undefined);
    if (windowInfo?.hwnd) {
      try {
        runWin32('untopmost', ['-Hwnd', String(windowInfo.hwnd)]);
      } catch {
        // Window already closed
      }
    }
    if (codeProc && codeProc.exitCode === null && codeProc.pid) {
      spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(codeProc.pid)], { stdio: 'ignore' });
    }
    server.close();
  }

  if (!fs.existsSync(rawMp4)) {
    throw new Error(`Recording file missing: ${rawMp4}`);
  }
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  convertToGif(opts.ffmpeg, rawMp4, outputGif, palettePng, opts.gifWidth, opts.fps);
  const stats = probeMedia(opts.ffmpeg, outputGif);
  console.log(
    `  [gif] ${path.relative(REPO_ROOT, outputGif)}: ${stats.width}x${stats.height}, ${stats.fps} fps, ${stats.durationSec}s, ${(stats.sizeBytes / 1024).toFixed(1)} KB`,
  );
  return { scene, outputGif, ...stats };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.vscode)) {
    throw new Error(`VS Code executable not found: ${opts.vscode}`);
  }
  if (!fs.existsSync(opts.ffmpeg)) {
    throw new Error(`ffmpeg executable not found: ${opts.ffmpeg}`);
  }

  if (!opts.skipCompile) {
    console.log('Compiling extension (npm run compile)...');
    const r = spawnSync('npm.cmd', ['run', 'compile'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      throw new Error(`npm run compile failed with exit code ${r.status}`);
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-demo-'));
  console.log(`Temp workspace root: ${tempRoot}`);
  const results = [];
  try {
    for (const scene of opts.scenes) {
      results.push(await recordScene(scene, opts, tempRoot));
    }
  } finally {
    if (!opts.keepTemp) {
      // Brief pause so VS Code child processes release file locks before deletion
      await sleep(800);
      fs.rmSync(tempRoot, { recursive: true, force: true });
      console.log(`Cleaned up temp folder: ${tempRoot}`);
    } else {
      console.log(`Kept temp folder (--keep-temp): ${tempRoot}`);
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(
      `- ${path.relative(REPO_ROOT, r.outputGif)}: ${r.width}x${r.height}, ${r.fps} fps, ${r.durationSec}s, ${(r.sizeBytes / 1024).toFixed(1)} KB (${(r.sizeBytes / (1024 * 1024)).toFixed(2)} MB)`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
