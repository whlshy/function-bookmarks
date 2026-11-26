import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 20000 });
  // 只跑部分測試：MOCHA_GREP=關鍵字（開發時用）
  if (process.env.MOCHA_GREP) {
    mocha.grep(process.env.MOCHA_GREP);
  }
  for (const f of fs.readdirSync(__dirname)) {
    if (f.endsWith('.test.js')) {
      mocha.addFile(path.join(__dirname, f));
    }
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} 項測試失敗`)) : resolve()));
  });
}
