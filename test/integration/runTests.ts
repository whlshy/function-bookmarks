import * as fs from 'fs';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * 整合測試：在真正的 VS Code 中載入套件。
 * - 設定環境變數 VSCODE_EXECUTABLE 可改用本機已安裝的 VS Code（不必下載）
 * - 設定 VSCODE_VERSION 可指定下載的版本，例如 1.90.0（驗證最低版本相容性）
 */
async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  const workspace = path.join(root, 'test', 'fixtures', 'workspace');
  const exe = process.env.VSCODE_EXECUTABLE;
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index'),
      launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
      ...(exe && fs.existsSync(exe) ? { vscodeExecutablePath: exe } : { version: process.env.VSCODE_VERSION ?? 'stable' }),
    });
  } catch (err) {
    console.error('整合測試失敗', err);
    process.exit(1);
  }
}

void main();
