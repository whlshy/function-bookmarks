import * as assert from 'assert';
import { applicableRules, DEFAULT_PROJECT_INCLUDE, projectGlobsFrom, ruleAppliesTo, settingsFrom } from '../../src/core/settings';
import { parseSettingsJson, readerFromSettings, stripJsonc } from '../../src/core/settingsFile';
import { DetectionRule } from '../../src/detection/types';

describe('共用核心：設定', () => {
  it('settings.json：去掉註解與結尾逗號，字串裡的 // 與 /* 不動', () => {
    const text = [
      '﻿{',
      '  // 註解',
      '  "a": "http://x/*y*/", /* 區塊註解 */',
      '  "b": "say \\"hi\\" // not comment",',
      '  "c": [1, 2,],',
      '}',
    ].join('\n');
    assert.deepStrictEqual(JSON.parse(stripJsonc(text.slice(1))), { a: 'http://x/*y*/', b: 'say "hi" // not comment', c: [1, 2] });
    assert.deepStrictEqual(parseSettingsJson(text), { a: 'http://x/*y*/', b: 'say "hi" // not comment', c: [1, 2] }, '開頭 BOM 也能讀');
    assert.deepStrictEqual(
      parseSettingsJson('{ "p": "^[A-Z_]{3,}\\\\s*=", "q": "a,]", "r": [1, /* x */ 2, // y\n ], }'),
      { p: '^[A-Z_]{3,}\\s*=', q: 'a,]', r: [1, 2] },
      '字串裡的 ,} 與 ,] 不是結尾逗號；逗號後接註解再接 ] 才是',
    );
    assert.strictEqual(parseSettingsJson('{ oops'), undefined);
    assert.strictEqual(parseSettingsJson('[1]'), undefined);
  });

  it('平鋪與巢狀兩種寫法都讀得到，沒設定時用預設值', () => {
    const flat = readerFromSettings({ 'functionBookmarks.project.include': '**/*.py', 'editor.tabSize': 2 });
    const nested = readerFromSettings({ functionBookmarks: { project: { include: '**/*.py' } } });
    for (const get of [flat, nested]) {
      assert.strictEqual(get('project.include', 'x'), '**/*.py');
      assert.strictEqual(get('project.exclude', 'none'), 'none');
    }
    assert.strictEqual(readerFromSettings(undefined)('followCursor', true), true);
  });

  it('規則：內建＋自訂、停用、模板 glob 佔位字換成設定值；格式不對時用預設', () => {
    const custom: DetectionRule = { id: 'my-rule', languages: ['python'], pattern: '^def (?<name>\\w+)', kind: 'function' } as DetectionRule;
    const s = settingsFrom(
      readerFromSettings({
        'functionBookmarks.detection.rules': [custom],
        'functionBookmarks.detection.disabledRules': ['py-def'],
        'functionBookmarks.detection.templateFiles': ['**/views/**'],
        'functionBookmarks.detection.source': 'nonsense',
      }),
    );
    assert.ok(s.rules.some((r) => r.id === 'my-rule'));
    assert.strictEqual(s.source, 'rules', '不認得的 source 當成 rules');
    const templated = s.rules.filter((r) => r.include?.includes('**/views/**'));
    assert.ok(templated.length > 0, '模板規則的 include 換成設定的 glob');

    const broken = settingsFrom(readerFromSettings({ 'functionBookmarks.detection.rules': 'oops', 'functionBookmarks.detection.templateFiles': 3 }));
    assert.ok(broken.rules.length > 0, '自訂規則格式不對時仍有內建規則');
    assert.deepStrictEqual(projectGlobsFrom(readerFromSettings({ 'functionBookmarks.project.include': '' })).include, DEFAULT_PROJECT_INCLUDE);
  });

  it('規則適用範圍：沒有 include 一律適用；相對路徑或完整路徑符合其一即可', () => {
    const base = { id: 'r', languages: ['python'], pattern: 'x', kind: 'function' } as DetectionRule;
    assert.ok(ruleAppliesTo(base, 'a.py', '/w/a.py'));
    const scoped = { ...base, include: ['app/**'] };
    assert.ok(ruleAppliesTo(scoped, 'app/x.py', '/w/app/x.py'));
    assert.ok(!ruleAppliesTo(scoped, 'lib/x.py', '/w/lib/x.py'));
    assert.deepStrictEqual(
      applicableRules([scoped, { ...base, id: 'off', enabled: false }, { ...base, id: 'js', languages: ['javascript'] }], 'python', 'app/x.py', '/w/app/x.py').map((r) => r.id),
      ['r'],
    );
  });
});
