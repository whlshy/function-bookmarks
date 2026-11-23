'use strict';

const http = require('http');
const path = require('path');
const vscode = require('vscode');

const CONTROL_URL = process.env.FB_DEMO_CONTROL_URL;
const SCENE = process.env.FB_DEMO_SCENE || 'function-bookmarks';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function control(endpoint, body = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.startsWith('/') ? endpoint : `/${endpoint}`, CONTROL_URL);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Control ${endpoint} failed (${res.statusCode}): ${raw}`));
            return;
          }
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            resolve({ raw });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function log(msg) {
  await control('/log', { message: `[driver:${SCENE}] ${msg}` }).catch(() => undefined);
}

function findLine(doc, needle) {
  for (let i = 0; i < doc.lineCount; i++) {
    if (doc.lineAt(i).text.includes(needle)) {
      return i;
    }
  }
  throw new Error(`Line containing "${needle}" not found in ${doc.uri.fsPath}`);
}

async function openWorkspaceFile(relPath) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder open');
  }
  const uri = vscode.Uri.file(path.join(folder.uri.fsPath, relPath));
  const doc = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(doc, { preview: false });
}

function setCursor(editor, line, col = 0, revealType = vscode.TextEditorRevealType.InCenterIfOutsideViewport) {
  const pos = new vscode.Position(line, col);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), revealType);
}

async function typeInEditor(editor, text, delayMs = 45) {
  for (const ch of text) {
    const pos = editor.selection.active;
    await editor.edit(
      (eb) => {
        eb.insert(pos, ch);
      },
      { undoStopBefore: false, undoStopAfter: false },
    );
    const nextPos = ch === '\n' ? new vscode.Position(pos.line + 1, 0) : new vscode.Position(pos.line, pos.character + ch.length);
    editor.selection = new vscode.Selection(nextPos, nextPos);
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
}

async function animateInputBox({ title, prompt, initialValue = '', finalText, charDelayMs = 65 }) {
  const box = vscode.window.createInputBox();
  box.title = title;
  box.prompt = prompt;
  box.value = initialValue;
  box.ignoreFocusOut = true;
  box.show();
  await sleep(550);
  for (let i = 1; i <= finalText.length; i++) {
    box.value = finalText.slice(0, i);
    await sleep(charDelayMs);
  }
  await sleep(350);
  box.hide();
  box.dispose();
}

async function waitFor(predicate, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function findFavoriteNode(api, nameSubstr) {
  const groups = await api.provider.getChildren(api.provider.sections.bookmarks);
  for (const g of groups) {
    const items = await api.provider.getChildren(g);
    for (const item of items) {
      if (item.type === 'favorite') {
        const label = item.fav.mark.alias || item.fav.mark.path;
        if (label.includes(nameSubstr)) {
          return item;
        }
      }
    }
  }
  return undefined;
}

async function prepareCleanUi(api, initialFile) {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closePanel').then(undefined, () => undefined);
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
  await vscode.commands.executeCommand('workbench.view.extension.functionBookmarks');
  await sleep(300);

  const editor = await openWorkspaceFile(initialFile);
  await api.refreshNow();
  await waitFor(() => api.provider.currentSymbolNodes.length > 0, 10000);
  await api.gutter.update();

  // Clear any startup notifications or hover widgets
  await vscode.commands.executeCommand('notifications.clearAll').then(undefined, () => undefined);
  await vscode.commands.executeCommand('editor.action.hideHover').then(undefined, () => undefined);
  await sleep(300);
  return editor;
}

/**
 * Scene A: Function bookmarks
 * - Current file lists functions in sidebar
 * - Move cursor to processCheckout and add function bookmark (Ctrl+Alt+B)
 * - Bookmarks section & star gutter icon appear
 * - Rename display name via InputBox -> "Checkout entry"
 * - Switch to cart.ts, then jump back via the sidebar bookmark
 */
async function sceneFunctionBookmarks(api) {
  const ordersEditor = await prepareCleanUi(api, 'orders.ts');
  const validateLine = findLine(ordersEditor.document, 'export function validateOrder');
  const checkoutLine = findLine(ordersEditor.document, 'export async function processCheckout');
  const checkoutCol = ordersEditor.document.lineAt(checkoutLine).text.indexOf('processCheckout');

  // Position viewport nicely so all 4 functions are visible
  setCursor(ordersEditor, validateLine, 16, vscode.TextEditorRevealType.AtTop);
  ordersEditor.revealRange(new vscode.Range(validateLine, 0, ordersEditor.document.lineCount - 1, 0), vscode.TextEditorRevealType.InCenter);
  await api.refreshNow();
  api.followCursor();
  await sleep(400);

  await control('/ready');
  await sleep(300);
  await control('/start-recording', { name: 'function-bookmarks' });

  // 1. Show initial Current file function list
  await sleep(1100);

  // 2. Move cursor to processCheckout
  setCursor(ordersEditor, checkoutLine, checkoutCol);
  api.followCursor();
  await sleep(750);

  // 3. Add function bookmark (Ctrl+Alt+B on function name line)
  await log('toggling bookmark');
  await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
  await api.refreshNow();
  await api.gutter.update();
  await sleep(1200);

  // 4. Reveal bookmark in Bookmarks section and rename display name
  await log('revealing favorite node');
  const favNode = await waitFor(() => findFavoriteNode(api, 'processCheckout'), 5000);
  await api.treeView.reveal(favNode, { select: true, focus: true, expand: true });
  await sleep(500);

  await log('opening rename InputBox');
  await animateInputBox({
    title: 'Display name',
    prompt: 'Original: processCheckout — leave empty to use the original name',
    initialValue: 'processCheckout',
    finalText: 'Checkout entry',
    charDelayMs: 65,
  });
  await api.commands.rename(favNode, 'Checkout entry');
  await log('rename finished');
  await api.refreshNow();
  await api.gutter.update();
  await sleep(1200);

  // 5. Switch to cart.ts
  await log('opening cart.ts');
  const cartEditor = await openWorkspaceFile('cart.ts');
  const subtotalLine = findLine(cartEditor.document, 'export function calcSubtotal');
  setCursor(cartEditor, subtotalLine, 16);
  await api.refreshNow();
  api.followCursor();
  await sleep(1500);

  // 6. Select renamed bookmark in sidebar and jump back to orders.ts
  await log('jumping back via sidebar bookmark');
  const renamedNode = await waitFor(() => findFavoriteNode(api, 'Checkout entry'), 5000);
  await api.treeView.reveal(renamedNode, { select: true, focus: true, expand: true });
  await sleep(700);
  await vscode.commands.executeCommand('functionBookmarks.openFavorite', renamedNode.fav);
  await api.refreshNow();
  await sleep(1900);

  await control('/stop-recording');
}

/**
 * Scene B: Line bookmarks
 * - Add a plain line bookmark inside calculateTotal
 * - Add a named bookmark via Add Bookmark with Name (faint label at line end) + tags
 * - Insert lines above the bookmarks and show them following the code
 * - Jump between bookmarks with nextBookmark / previousBookmark
 */
async function sceneLineBookmarks(api) {
  const editor = await prepareCleanUi(api, 'orders.ts');
  const validateLine = findLine(editor.document, 'export function validateOrder');
  const calcLine = findLine(editor.document, 'export function calculateTotal');
  const discountLine = findLine(editor.document, 'const discount =');
  const taxLine = findLine(editor.document, 'const tax =');

  // Frame orders.ts from validateOrder downward so calculateTotal + processCheckout fit comfortably
  editor.revealRange(new vscode.Range(validateLine, 0, editor.document.lineCount - 1, 0), vscode.TextEditorRevealType.InCenter);
  setCursor(editor, discountLine, 2);
  await api.refreshNow();
  api.followCursor();
  await sleep(400);

  await control('/ready');
  await sleep(300);
  await control('/start-recording', { name: 'line-bookmarks' });

  // 1. Add plain line bookmark on discount line
  await sleep(800);
  await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
  await api.gutter.update();
  await sleep(1000);

  // 2. Move to tax line & Add Bookmark with Name
  setCursor(editor, taxLine, 2);
  await sleep(550);
  await animateInputBox({
    title: 'Bookmark name',
    prompt: `Line ${taxLine + 1}`,
    initialValue: 'calculateTotal',
    finalText: 'Tax rounding',
    charDelayMs: 65,
  });
  await api.bookmarks.addLabeled('Tax rounding');
  await api.gutter.update();
  await sleep(950);

  // 3. Add tags to that bookmark
  await animateInputBox({
    title: 'Tags',
    prompt: 'Separate with spaces or commas, e.g. #auth #todo',
    initialValue: '',
    finalText: '#billing #review',
    charDelayMs: 60,
  });
  await api.bookmarks.editTags(undefined, '#billing #review');
  await api.gutter.update();
  await sleep(1000);

  // 4. Insert 3 lines above the bookmarks and watch them follow their code lines
  const calcHeaderEnd = editor.document.lineAt(calcLine).range.end;
  setCursor(editor, calcHeaderEnd.line, calcHeaderEnd.character);
  await sleep(450);

  const snippet = "\n  if (order.taxRate < 0) {\n    throw new Error('Negative tax rate');\n  }";
  await typeInEditor(editor, snippet, 28);
  await editor.document.save();
  await api.gutter.update();
  await sleep(1100);

  // 5. Jump between bookmarks (next / next / previous / next)
  setCursor(editor, validateLine, 0);
  await sleep(450);

  await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
  await sleep(750);
  await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
  await sleep(750);
  await vscode.commands.executeCommand('functionBookmarks.previousBookmark');
  await sleep(750);
  await vscode.commands.executeCommand('functionBookmarks.nextBookmark');
  await sleep(1700);

  await control('/stop-recording');
}

/**
 * Scene C: Markdown notes
 * - Start with processCheckout bookmarked
 * - Run Edit Note -> opens note editor + side-by-side Markdown preview
 * - Type Markdown (heading, list, bold, inline code, fenced code block) char-by-char
 * - Save -> tabs close, return to orders.ts
 * - Show hover on processCheckout -> formatted Markdown note visible in hover
 */
async function sceneMarkdownNotes(api) {
  const editor = await prepareCleanUi(api, 'orders.ts');
  const validateLine = findLine(editor.document, 'export function validateOrder');
  const checkoutLine = findLine(editor.document, 'export async function processCheckout');
  const checkoutCol = editor.document.lineAt(checkoutLine).text.indexOf('processCheckout');

  // Pre-bookmark processCheckout so the scene focuses on Markdown notes
  setCursor(editor, checkoutLine, checkoutCol);
  await vscode.commands.executeCommand('functionBookmarks.toggleBookmark');
  await api.refreshNow();
  await api.gutter.update();
  editor.revealRange(new vscode.Range(validateLine, 0, editor.document.lineCount - 1, 0), vscode.TextEditorRevealType.InCenter);
  setCursor(editor, checkoutLine, checkoutCol + 3);
  api.followCursor();
  await sleep(500);

  await control('/ready');
  await sleep(300);
  await control('/start-recording', { name: 'markdown-notes' });

  // 1. Brief pause showing bookmarked function
  await sleep(1000);

  // 2. Open Edit Note (opens note editor + live preview to side)
  const favNode = await waitFor(() => findFavoriteNode(api, 'processCheckout'), 5000);
  await vscode.commands.executeCommand('functionBookmarks.editNote', favNode);

  const noteEditor = await waitFor(() => {
    const ed = vscode.window.activeTextEditor;
    return ed && api.notes.isNoteDocument(ed.document.uri) ? ed : undefined;
  }, 8000);
  await sleep(1100); // let Markdown preview webview finish initial paint

  // 3. Type concise Markdown with heading, list, bold, inline code, and code block
  const markdown = [
    '## Checkout flow',
    '',
    '- Validates **order items** first',
    '- Calls `chargeCard()` on payment',
    '',
    '```ts',
    'await chargeCard(order.id, total);',
    '```',
  ].join('\n');

  await typeInEditor(noteEditor, markdown, 42);
  await sleep(1100); // let viewer read completed note + live preview

  // 4. Save -> applies note and closes both note editor & preview
  await noteEditor.document.save();
  await waitFor(() => {
    const ed = vscode.window.activeTextEditor;
    return ed && ed.document.uri.fsPath.endsWith('orders.ts');
  }, 8000);
  await api.refreshNow();
  await api.gutter.update();
  await sleep(700);

  // 5. Show hover on processCheckout function name
  const backEditor = vscode.window.activeTextEditor;
  const backLine = findLine(backEditor.document, 'export async function processCheckout');
  const backCol = backEditor.document.lineAt(backLine).text.indexOf('processCheckout') + 4;
  // Position processCheckout slightly below top so the hover popup fits completely without clipping
  backEditor.revealRange(new vscode.Range(Math.max(0, backLine - 16), 0, backLine + 6, 0), vscode.TextEditorRevealType.InCenter);
  setCursor(backEditor, backLine, backCol);
  await sleep(450);

  await vscode.commands.executeCommand('editor.action.showHover');
  await sleep(2500);

  await control('/stop-recording');
}

async function run() {
  if (!CONTROL_URL) {
    throw new Error('FB_DEMO_CONTROL_URL env var is required');
  }
  await log(`Starting scene "${SCENE}"`);
  const ext = vscode.extensions.getExtension('whlshy.function-bookmarks');
  if (!ext) {
    throw new Error('Extension whlshy.function-bookmarks not found');
  }
  const api = await ext.activate();

  if (SCENE === 'function-bookmarks') {
    await sceneFunctionBookmarks(api);
  } else if (SCENE === 'line-bookmarks') {
    await sceneLineBookmarks(api);
  } else if (SCENE === 'markdown-notes') {
    await sceneMarkdownNotes(api);
  } else {
    throw new Error(`Unknown scene: ${SCENE}`);
  }
  await log(`Finished scene "${SCENE}"`);
}

exports.run = run;
