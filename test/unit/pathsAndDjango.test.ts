import * as assert from 'assert';
import { collectBlocks, extendsTarget, findOverrides, findPartial, pickClosest, splitTemplateTarget } from '../../src/django/templates';
import { DetectedSymbol } from '../../src/detection/types';
import { languageForPath, matchesAny, normalizeDrive, relativeUnder } from '../../src/util/paths';
import { detect, lines } from './helpers';

describe('路徑工具', () => {
  it('依副檔名判斷語言', () => {
    assert.strictEqual(languageForPath('a/b/views.py'), 'python');
    assert.strictEqual(languageForPath('x.TSX'), 'typescriptreact');
    assert.strictEqual(languageForPath('templates/a.html'), 'html');
    assert.strictEqual(languageForPath('Makefile'), undefined);
    assert.strictEqual(languageForPath('a.go'), undefined);
  });

  it('Windows 磁碟代號大小寫不同也能算出相對路徑', () => {
    assert.strictEqual(normalizeDrive('/D:/a/b'), '/d:/a/b');
    assert.strictEqual(normalizeDrive('/home/x'), '/home/x');
    assert.strictEqual(relativeUnder('/D:/proj', '/d:/proj/app/views.py'), 'app/views.py');
    assert.strictEqual(relativeUnder('/d:/proj/', '/D:/proj/a.py'), 'a.py');
    assert.strictEqual(relativeUnder('/d:/proj', '/d:/project/a.py'), undefined);
    assert.strictEqual(relativeUnder('/d:/proj', '/d:/proj'), undefined);
    assert.strictEqual(relativeUnder('/home/u/p', '/home/u/p/x/y.ts'), 'x/y.ts');
  });

  it('glob 比對相對路徑', () => {
    assert.ok(matchesAny(['**/templates/**'], 'app/templates/app/login.html'));
    assert.ok(matchesAny(['**/templates/**'], 'templates/base.html'));
    assert.ok(!matchesAny(['**/templates/**'], 'static/plain.html'));
    assert.ok(matchesAny(['**/node_modules/**'], 'web\\node_modules\\x\\index.js'));
    assert.ok(matchesAny(['**/*.{ts,py}'], 'a/.hidden/b.py'));
  });
});

describe('Django template 工具', () => {
  it('拆開 template#partial', () => {
    assert.deepStrictEqual(splitTemplateTarget('partials/card.html#card'), { file: 'partials/card.html', partial: 'card' });
    assert.deepStrictEqual(splitTemplateTarget('base.html'), { file: 'base.html' });
  });

  it('extends 目標、block 收集、partial 查找', () => {
    const r = detect(
      lines('{% extends "base.html" %}', '{% block a %}{% block b %}{% endblock %}{% endblock %}', '{% partialdef card %}{% endpartialdef %}'),
      'html',
    );
    assert.strictEqual(extendsTarget(r.symbols), 'base.html');
    assert.deepStrictEqual([...collectBlocks(r.symbols).keys()], ['a', 'b']);
    assert.strictEqual(findPartial(r.symbols, 'card')?.name, 'card');
  });

  it('多個候選時挑同一個 app 的 template', () => {
    assert.strictEqual(
      pickClosest('shop/templates/shop/list.html', ['blog/templates/base.html', 'shop/templates/base.html', 'templates/base.html']),
      'shop/templates/base.html',
    );
    assert.strictEqual(pickClosest('x/a.html', ['templates/base.html', 'b/templates/base.html']), 'templates/base.html');
    assert.strictEqual(pickClosest('x', []), undefined);
  });

  it('沿 extends 鏈找出每個 block 最近的祖先定義，並避免循環', async () => {
    const files: Record<string, string> = {
      'child.html': '{% extends "mid.html" %}{% block content %}{% endblock %}{% block title %}{% endblock %}{% block own %}{% endblock %}',
      'mid.html': '{% extends "base.html" %}{% block content %}{% endblock %}',
      'base.html': '{% extends "child.html" %}{% block title %}{% endblock %}{% block content %}{% endblock %}',
    };
    const load = async (target: string) =>
      files[target] ? { template: target, key: target, symbols: detect(files[target], 'html').symbols as DetectedSymbol[] } : undefined;
    const r = await findOverrides(detect(files['child.html'], 'html').symbols, load, 'child.html');
    assert.deepStrictEqual(
      [...r.entries()].map(([k, v]) => `${k}<-${v.template}`).sort(),
      ['content<-mid.html', 'title<-base.html'],
    );
  });
});
