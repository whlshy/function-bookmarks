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
  // 切換分支的測試會在工作區裡建立臨時 git 專案；上次中斷留下的先刪掉
  fs.rmSync(path.join(workspace, '.git'), { recursive: true, force: true });
  const exe = process.env.VSCODE_EXECUTABLE;
  const run = (target: string, suite: string) =>
    runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, suite, 'index'),
      // Cursor 的登入依賴內建擴充，停用擴充會讀不到已存的登入；KEEP_EXTENSIONS=1 時不停用
      launchArgs: [
        target,
        ...(process.env.KEEP_EXTENSIONS ? [] : ['--disable-extensions']),
        '--skip-welcome',
        '--skip-release-notes',
      ],
      ...(exe && fs.existsSync(exe) ? { vscodeExecutablePath: exe } : { version: process.env.VSCODE_VERSION ?? 'stable' }),
    });
  try {
    await run(workspace, 'suite');
    // 多資料夾工作區（workspace + workspace2）
    await run(path.join(root, 'test', 'fixtures', 'multi.code-workspace'), 'multi');
  } catch (err) {
    console.error('整合測試失敗', err);
    process.exit(1);
  }
}

void main();
