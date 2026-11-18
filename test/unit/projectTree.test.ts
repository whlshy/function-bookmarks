import * as assert from 'assert';
import { findByPath } from '../../src/detection/engine';
import { buildDirTree, DirTree } from '../../src/symbols/projectTree';
import { detect, lines } from './helpers';

function show(t: DirTree): unknown {
  return { [t.name || '/']: [...t.dirs.map(show), ...t.files] };
}

describe('整個專案的資料夾樹', () => {
  it('依資料夾分組、排序，單一路徑的資料夾合併顯示', () => {
    const t = buildDirTree(['manage.py', 'app/views.py', 'app/templates/app/login.html', 'app/templates/app/base.html', 'core/a/b/c.py']);
    assert.deepStrictEqual(show(t), {
      '/': [
        { app: [{ 'templates/app': ['app/templates/app/base.html', 'app/templates/app/login.html'] }, 'app/views.py'] },
        { 'core/a/b': ['core/a/b/c.py'] },
        'manage.py',
      ],
    });
    assert.strictEqual(t.dirs[0].dirs[0].path, 'app/templates/app');
  });

  it('空清單', () => {
    assert.deepStrictEqual(show(buildDirTree([])), { '/': [] });
  });
});

describe('findByPath', () => {
  const r = detect(lines('class C:', '    def m(self):', '        pass', 'def m():', '    pass'), 'python');

  it('路徑＋種類都相同優先', () => {
    assert.strictEqual(findByPath(r.symbols, 'C.m', 'method')?.nameLine, 1);
    assert.strictEqual(findByPath(r.symbols, 'm', 'function')?.nameLine, 3);
  });

  it('種類不同時退而求其次只比路徑', () => {
    assert.strictEqual(findByPath(r.symbols, 'C.m', 'function')?.nameLine, 1);
    assert.strictEqual(findByPath(r.symbols, 'nope'), undefined);
  });
});
