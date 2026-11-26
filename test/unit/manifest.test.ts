import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const nlsEn = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8')) as Record<string, string>;
const nlsZh = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.zh-tw.json'), 'utf8')) as Record<string, string>;
const l10nZh = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n/bundle.l10n.zh-tw.json'), 'utf8')) as Record<string, string>;

type CommandDecl = { command: string; title: string; category?: string; icon?: string };
type MenuItem = { command: string; when?: string; group?: string };
type KeybindingDecl = { command: string; key: string; mac?: string; when?: string; args?: { number?: number } };

describe('package.json、package.nls 與 l10n 一致性', () => {
  it('指令宣告、圖示與命令選擇區分類一致（無無效 Codicon，所有快捷鍵與選單指令皆已宣告）', () => {
    const cmds = pkg.contributes.commands as CommandDecl[];
    const declared = new Set(cmds.map((c) => c.command));
    assert.strictEqual(declared.size, cmds.length, '不應有重複宣告的指令');
    assert.ok(cmds.every((c) => c.category), '每個指令都應有 category');

    // toggleFavorite 不可使用不存在的 $(star)
    const toggleFav = cmds.find((c) => c.command === 'functionBookmarks.toggleFavorite');
    assert.notStrictEqual(toggleFav?.icon, '$(star)');
    assert.strictEqual(toggleFav?.icon, '$(star-empty)');

    // 排序切換按鈕應有圖示與標題
    const byId = new Map(cmds.map((c) => [c.command, c]));
    assert.ok(byId.get('functionBookmarks.sortFileBookmarksByTitle')?.icon, '依標題排序應有圖示');
    assert.ok(byId.get('functionBookmarks.sortFileBookmarksByCreated')?.title, '依建立時間排序應有標題');
    assert.ok(byId.get('functionBookmarks.sortFileBookmarksByCreated')?.icon, '依建立時間排序應有圖示');
    assert.ok(byId.get('functionBookmarks.sortFileBookmarksByLine')?.icon, '依行號排序應有圖示');

    // 所有快捷鍵與選單引用的指令都必須宣告在 contributes.commands
    const keys = pkg.contributes.keybindings as KeybindingDecl[];
    for (const kb of keys) {
      assert.ok(declared.has(kb.command), `快捷鍵指令未宣告在 contributes.commands：${kb.command}`);
    }
    const menus = pkg.contributes.menus as Record<string, MenuItem[]>;
    for (const [menu, items] of Object.entries(menus)) {
      for (const it of items) {
        assert.ok(declared.has(it.command), `選單 ${menu} 的指令未宣告在 contributes.commands：${it.command}`);
      }
    }
  });

  it('選單條件與排序一致：排除廢棄 fbFavorite、moveBookmarkToCursor 排除函式書籤、行號／編輯器／排序選單正確', () => {
    const menus = pkg.contributes.menus as Record<string, MenuItem[]>;
    const itemMenu = menus['view/item/context'];

    // 不殘留已廢棄的 fbFavorite
    assert.strictEqual(
      itemMenu.some((m) => m.when?.includes('fbFavorite')),
      false,
      'view/item/context 不應殘留已廢棄的 fbFavorite',
    );

    // 整個 package.json 的 when 條件都不得使用 VS Code 不支援的 `!~` 運算子
    const allWhen: { where: string; value: string }[] = [];
    const collectWhen = (obj: unknown, where: string) => {
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => collectWhen(v, `${where}[${i}]`));
        return;
      }
      if (!obj || typeof obj !== 'object') {
        return;
      }
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'when' && typeof v === 'string') {
          allWhen.push({ where: `${where}.${k}`, value: v });
        } else {
          collectWhen(v, `${where}.${k}`);
        }
      }
    };
    collectWhen(pkg, 'package.json');
    assert.ok(allWhen.length > 0, '應找到 when 條件');
    for (const w of allWhen) {
      assert.strictEqual(w.value.includes('!~'), false, `${w.where} 不得使用不支援的 !~ 運算子：${w.value}`);
    }

    // moveBookmarkToCursor 必須排除函式書籤（fbBookmark:fn），且不得匹配非書籤列
    const viewItemRegex = (when: string | undefined): RegExp => {
      const m = when?.match(/viewItem\s*=~\s*\/(.+)\/([a-z]*)/);
      assert.ok(m, `缺少 viewItem =~ /.../ 條件：${when}`);
      return new RegExp(m[1], m[2]);
    };
    const moveItems = itemMenu.filter((m) => m.command === 'functionBookmarks.moveBookmarkToCursor');
    assert.strictEqual(moveItems.length, 2);
    const moveInline = moveItems.find((m) => m.group?.startsWith('inline'));
    const moveCtx = moveItems.find((m) => !m.group?.startsWith('inline'));
    const moveInlineRe = viewItemRegex(moveInline?.when);
    const moveCtxRe = viewItemRegex(moveCtx?.when);
    assert.strictEqual(moveInlineRe.test('fbBookmark:lost'), true);
    assert.strictEqual(moveInlineRe.test('fbBookmark:note:lost:branchOnly'), true);
    assert.strictEqual(moveInlineRe.test('fbBookmark'), false);
    assert.strictEqual(moveInlineRe.test('fbBookmark:fn:ok'), false);
    assert.strictEqual(moveInlineRe.test('fbBookmark:fn:lost'), false);
    assert.strictEqual(moveCtxRe.test('fbBookmark'), true);
    assert.strictEqual(moveCtxRe.test('fbBookmark:note:lost:branchOnly:foreign'), true);
    assert.strictEqual(moveCtxRe.test('fbBookmark:fn:ok'), false);
    assert.strictEqual(moveCtxRe.test('fbBookmark:fn:note:missing'), false);
    for (const nonBookmark of ['fbSearch', 'fbSearch:active', 'fbBmFile', 'fbBmTag', 'fbBmSource:foreign', 'fbSymbol:nofav', 'fbSymbol:fav', 'fbSection.bookmarks']) {
      assert.strictEqual(moveInlineRe.test(nonBookmark), false, `inline move 不應出現在 ${nonBookmark}`);
      assert.strictEqual(moveCtxRe.test(nonBookmark), false, `右鍵 move 不應出現在 ${nonBookmark}`);
    }

    // setBookmarkBranchOnly 只出現在非函式且尚未限定分支的行號書籤
    const branchOnlyItem = itemMenu.find((m) => m.command === 'functionBookmarks.setBookmarkBranchOnly');
    const branchOnlyRe = viewItemRegex(branchOnlyItem?.when);
    assert.strictEqual(branchOnlyRe.test('fbBookmark'), true);
    assert.strictEqual(branchOnlyRe.test('fbBookmark:note:lost:foreign'), true);
    assert.strictEqual(branchOnlyRe.test('fbBookmark:branchOnly'), false);
    assert.strictEqual(branchOnlyRe.test('fbBookmark:note:lost:branchOnly:foreign'), false);
    assert.strictEqual(branchOnlyRe.test('fbBookmark:fn:ok'), false);
    assert.strictEqual(branchOnlyRe.test('fbSymbol:nofav'), false);
    assert.strictEqual(branchOnlyRe.test('fbSearch'), false);

    // 側邊欄預覽備註不重複比對書籤
    const previewRules = itemMenu.filter((m) => m.command === 'functionBookmarks.previewNote');
    const forBookmark = previewRules.filter((r) => r.when?.includes('fbBookmark'));
    const forSymbol = previewRules.filter((r) => !r.when?.includes('fbBookmark'));
    assert.strictEqual(forBookmark.length, 1);
    assert.strictEqual(forSymbol.length, 1);
    assert.ok(forSymbol[0].when?.includes('^fbSymbol'), `不應重複比對 fbBookmark：${forSymbol[0].when}`);

    // 檔案列 inline 排序按鈕（預設→標題、標題／建立時間→行號）、右鍵 1_sort（顯示沒在用的兩種）與匯出／清除
    const matchViewItem = (when: string | undefined, value: string): boolean => {
      assert.ok(when, '缺少 when 條件');
      const eq = when.match(/viewItem\s*==\s*([^\s&|]+)/);
      if (eq) {
        return value === eq[1];
      }
      return viewItemRegex(when).test(value);
    };
    const toTitleInline = itemMenu.find((m) => m.command === 'functionBookmarks.sortFileBookmarksByTitle' && m.group?.startsWith('inline'));
    const toLineInline = itemMenu.find((m) => m.command === 'functionBookmarks.sortFileBookmarksByLine' && m.group?.startsWith('inline'));
    assert.strictEqual(toTitleInline?.when, 'view == functionBookmarks.tree && viewItem == fbBmFile');
    assert.strictEqual(matchViewItem(toLineInline?.when, 'fbBmFile'), false);
    assert.strictEqual(matchViewItem(toLineInline?.when, 'fbBmFile:byTitle'), true);
    assert.strictEqual(matchViewItem(toLineInline?.when, 'fbBmFile:byCreated'), true);
    assert.strictEqual(matchViewItem(toLineInline?.when, 'fbBookmark'), false);

    const sortMenu = itemMenu.filter((m) => m.group?.startsWith('1_sort'));
    const visibleSortCommands = (viewItem: string) =>
      sortMenu
        .filter((m) => matchViewItem(m.when, viewItem))
        .map((m) => m.command)
        .sort();
    assert.deepStrictEqual(visibleSortCommands('fbBmFile'), [
      'functionBookmarks.sortFileBookmarksByCreated',
      'functionBookmarks.sortFileBookmarksByTitle',
    ]);
    assert.deepStrictEqual(visibleSortCommands('fbBmFile:byTitle'), [
      'functionBookmarks.sortFileBookmarksByCreated',
      'functionBookmarks.sortFileBookmarksByLine',
    ]);
    assert.deepStrictEqual(visibleSortCommands('fbBmFile:byCreated'), [
      'functionBookmarks.sortFileBookmarksByLine',
      'functionBookmarks.sortFileBookmarksByTitle',
    ]);
    for (const nonFile of ['fbSearch', 'fbBmTag', 'fbBmSource:foreign', 'fbBookmark', 'fbFile', 'fbSymbol:fav']) {
      assert.deepStrictEqual(visibleSortCommands(nonFile), [], `1_sort 不應出現在 ${nonFile}`);
    }
    assert.ok(itemMenu.find((m) => m.command === 'functionBookmarks.exportFileBookmarks')?.when?.includes('/^fbBmFile/'));

    // 標題列（…）的指令會收到選取中的樹節點，無法分辨是從標題列還是項目右鍵執行：同一個指令不能兩邊都放
    const titleCommands = new Set((pkg.contributes.menus['view/title'] as { command: string }[]).map((m) => m.command));
    const both = [...new Set(itemMenu.map((m) => m.command))].filter((c) => titleCommands.has(c));
    assert.deepStrictEqual(both, [], `同時在標題列與項目右鍵：${both.join(', ')}`);
    assert.ok(itemMenu.find((m) => m.command === 'functionBookmarks.clearBookmarksInFile')?.when?.includes('/^fbBmFile/'));

    // view/title 的 2_bookmarks 分組中，非互斥項目不共用相同 @order
    const bmTitleItems = menus['view/title'].filter((m) => m.group?.startsWith('2_bookmarks@'));
    const orderMap = new Map<string, string[]>();
    for (const m of bmTitleItems) {
      const list = orderMap.get(m.group!) ?? [];
      list.push(m.command);
      orderMap.set(m.group!, list);
    }
    const allowedMutuallyExclusive = new Set([
      'functionBookmarks.hideNotOnBranch,functionBookmarks.showNotOnBranch',
      'functionBookmarks.hideBookmarkIcons,functionBookmarks.showBookmarkIcons',
    ]);
    for (const [group, list] of orderMap) {
      if (list.length > 1) {
        assert.ok(allowedMutuallyExclusive.has([...list].sort().join(',')), `view/title 群組 ${group} 有非互斥重複排序：${list.join(', ')}`);
      }
    }

    // editor/context 順序不重複，且依游標書籤顯示 renameBookmark（不含重複的 renameDisplayName）
    const editorCtx = menus['editor/context'];
    const editorGroups = editorCtx.map((m) => m.group);
    assert.strictEqual(new Set(editorGroups).size, editorGroups.length, 'editor/context 不應有重複的 group 排序');
    const renameCtx = editorCtx.find((m) => m.command === 'functionBookmarks.renameBookmark');
    assert.strictEqual(renameCtx?.when, 'editorTextFocus && functionBookmarks.cursorHasBookmark');
    assert.strictEqual(editorCtx.some((m) => m.command === 'functionBookmarks.renameDisplayName'), false);

    // 行號右鍵選單五項與順序
    const lineMenu = menus['editor/lineNumber/context'];
    assert.deepStrictEqual(
      lineMenu.map((m) => [m.command, m.group]),
      [
        ['functionBookmarks.toggleBookmark', 'functionBookmarks@1'],
        ['functionBookmarks.addLabeledBookmark', 'functionBookmarks@2'],
        ['functionBookmarks.setBookmarkNumber', 'functionBookmarks@3'],
        ['functionBookmarks.setBookmarkColor', 'functionBookmarks@4'],
        ['functionBookmarks.editNote', 'functionBookmarks@5'],
      ],
    );

    // 命令選擇區開放游標操作指令，隱藏內部與側邊欄專用指令
    const hidden = new Set(menus.commandPalette.filter((m) => m.when === 'false').map((m) => m.command));
    for (const openCmd of ['functionBookmarks.renameBookmark', 'functionBookmarks.editBookmarkTags', 'functionBookmarks.removeBookmark']) {
      assert.strictEqual(hidden.has(openCmd), false, `${openCmd} 應在命令選擇區開放`);
    }
    for (const hideCmd of [
      'functionBookmarks.renameDisplayName',
      'functionBookmarks.sortFileBookmarksByTitle',
      'functionBookmarks.sortFileBookmarksByCreated',
      'functionBookmarks.sortFileBookmarksByLine',
      'functionBookmarks.searchClearAndClose',
      'functionBookmarks.searchToList',
    ]) {
      assert.strictEqual(hidden.has(hideCmd), true, `${hideCmd} 應在命令選擇區隱藏`);
    }
  });

  it('預設快捷鍵使用 Alt+Shift+B／macOS Ctrl+Shift+B 前綴（無 Ctrl+Alt 衝突），18 個數字快捷鍵完整', () => {
    const keys = pkg.contributes.keybindings as KeybindingDecl[];
    for (const kb of keys) {
      assert.ok(!kb.key.toLowerCase().includes('ctrl+alt'), `不應含 ctrl+alt：${kb.command} -> ${kb.key}`);
      assert.ok(!kb.mac?.toLowerCase().includes('cmd+alt'), `mac 不應含 cmd+alt：${kb.command} -> ${kb.mac}`);
    }
    const renameInEditor = keys.find((k) => k.command === 'functionBookmarks.renameBookmark');
    assert.strictEqual(renameInEditor?.key, 'alt+shift+b r');
    assert.strictEqual(renameInEditor?.mac, 'ctrl+shift+b r');
    assert.strictEqual(renameInEditor?.when, 'editorTextFocus');

    const f2SideBar = keys.find((k) => k.command === 'functionBookmarks.renameDisplayName');
    assert.strictEqual(f2SideBar?.key, 'f2');
    assert.strictEqual(f2SideBar?.when, 'focusedView == functionBookmarks.tree');

    for (let n = 1; n <= 9; n++) {
      const go = keys.find((k) => k.command === 'functionBookmarks.goToNumberedBookmark' && k.args?.number === n);
      const set = keys.find((k) => k.command === 'functionBookmarks.toggleNumberedBookmark' && k.args?.number === n);
      assert.strictEqual(go?.key, `alt+shift+b ${n}`);
      assert.strictEqual(go?.mac, `ctrl+shift+b ${n}`);
      assert.strictEqual(set?.key, `alt+shift+b shift+${n}`);
      assert.strictEqual(set?.mac, `ctrl+shift+b shift+${n}`);
    }
  });

  it('設定 Schema 分類有 order、涵蓋 optionalBody，側邊欄字型圖示存在且為有效 WOFF', () => {
    const groups = pkg.contributes.configuration as {
      title: string;
      properties: Record<string, { order?: number; items?: { properties?: Record<string, { type?: string }> } }>;
    }[];
    assert.ok(Array.isArray(groups) && groups.length >= 4);
    for (const group of groups) {
      for (const [k, v] of Object.entries(group.properties)) {
        assert.strictEqual(typeof v.order, 'number', `${k} 沒有 order`);
      }
    }
    const allProps = Object.assign({}, ...groups.map((g) => g.properties));
    for (const k of ['functionBookmarks.bookmarks.autoNumber', 'functionBookmarks.bookmarks.showLabelAtLineEnd', 'functionBookmarks.statusBar.enabled']) {
      assert.ok(k in allProps, k);
    }
    assert.strictEqual(
      allProps['functionBookmarks.detection.rules']?.items?.properties?.optionalBody?.type,
      'boolean',
      'detection.rules Schema 應包含 optionalBody',
    );

    assert.strictEqual(pkg.contributes.viewsContainers.activitybar[0].icon, '$(function-bookmarks-logo)');
    const font = pkg.contributes.icons['function-bookmarks-logo'].default as { fontPath: string; fontCharacter: string };
    assert.strictEqual(font.fontCharacter.length, 5, 'fontCharacter 應為反斜線加 4 碼');
    const bytes = fs.readFileSync(path.join(ROOT, font.fontPath));
    assert.strictEqual(bytes.subarray(0, 4).toString('latin1'), 'wOFF');
  });

  it('package.nls 英文與繁體中文鍵值完全對齊、無多餘或遺漏鍵；bundle.l10n 佔位符一致', () => {
    const rawPkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const referenced = new Set([...rawPkg.matchAll(/%([a-zA-Z0-9._-]+)%/g)].map((m) => m[1]));
    const enKeys = new Set(Object.keys(nlsEn));
    const zhKeys = new Set(Object.keys(nlsZh));

    for (const k of referenced) {
      assert.ok(enKeys.has(k), `package.nls.json 缺少鍵：${k}`);
      assert.ok(zhKeys.has(k), `package.nls.zh-tw.json 缺少鍵：${k}`);
    }
    for (const k of enKeys) {
      assert.ok(referenced.has(k), `package.nls.json 有未使用的鍵：${k}`);
      assert.ok(zhKeys.has(k), `package.nls.zh-tw.json 缺少鍵：${k}`);
    }
    for (const k of zhKeys) {
      assert.ok(enKeys.has(k), `package.nls.zh-tw.json 有多餘的鍵：${k}`);
    }

    assert.strictEqual(nlsEn.displayName, 'Function Bookmarks');
    assert.strictEqual(nlsZh.displayName, 'Function Bookmarks 函式書籤');
    assert.strictEqual(nlsEn['container.title'], nlsEn['view.tree.name']);
    assert.strictEqual(nlsZh['container.title'], nlsZh['view.tree.name']);

    for (const [en, zh] of Object.entries(l10nZh)) {
      const enPh = [...new Set(en.match(/\{\d+\}/g) ?? [])].sort();
      const zhPh = [...new Set(zh.match(/\{\d+\}/g) ?? [])].sort();
      assert.deepStrictEqual(zhPh, enPh, `l10n 佔位符不一致：${en} => ${zh}`);
    }
  });
});
