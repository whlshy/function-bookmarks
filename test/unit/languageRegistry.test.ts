import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { BUILTIN_RULES, EXT_LANGUAGE, LANGUAGES, PROJECT_EXTENSIONS, syntaxForLanguage } from '../../src/detection/languages';
import { detect } from './helpers';

describe('語言清單（detection/languages）', () => {
  it('package.json 的「整個專案」預設副檔名和各語言的設定一致', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
    const props = (pkg.contributes.configuration as { properties: Record<string, { default?: unknown }> }[])
      .map((c) => c.properties['functionBookmarks.project.include'])
      .find(Boolean);
    assert.strictEqual(props?.default, `**/*.{${PROJECT_EXTENSIONS.join(',')}}`);
    // Python 型別檔與 Django／Jinja 模板也列在「整個專案」
    for (const ext of ['pyi', 'djhtml', 'jinja', 'jinja2', 'j2']) {
      assert.ok(PROJECT_EXTENSIONS.includes(ext), ext);
    }
  });

  it('每個語言：副檔名對到的語言有遮罩設定或規則；「整個專案」的副檔名都認得', () => {
    for (const lang of LANGUAGES) {
      for (const id of Object.values(lang.extensions)) {
        assert.ok(id in lang.syntax, `${id} 沒有遮罩設定`);
      }
      for (const ext of lang.projectExtensions) {
        // 副檔名查表一律用小寫（.R 與 .r 都是 R）
        assert.ok(EXT_LANGUAGE[`.${ext.toLowerCase()}`], `.${ext} 沒有對到語言`);
      }
    }
    assert.strictEqual(new Set(PROJECT_EXTENSIONS).size, PROJECT_EXTENSIONS.length, '副檔名重複');
    assert.strictEqual(syntaxForLanguage('plaintext'), 'none');
  });

  it('內建規則 id 不重複、每條規則的語言都有登記，且所有語言的規則皆能無錯誤編譯', () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    const known = new Set(LANGUAGES.flatMap((l) => Object.keys(l.syntax)));
    for (const r of BUILTIN_RULES) {
      for (const l of [...r.languages, ...(r.embeddedLanguage ? [r.embeddedLanguage] : [])]) {
        assert.ok(known.has(l), `${r.id}：${l}`);
      }
    }
    for (const lang of known) {
      assert.deepStrictEqual(detect('', lang).errors, [], lang);
    }
  });
});
