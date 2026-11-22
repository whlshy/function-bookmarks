import * as vscode from 'vscode';

/** vscode.git 擴充 API 中用到的部分。 */
interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { commit?: string; name?: string };
    onDidChange: vscode.Event<void>;
  };
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}

/**
 * Git HEAD 變動（pull、切換分支、rebase、merge、reset）時通知。
 * 檔案變更通知可能漏掉（大量檔案、被 files.watcherExclude 排除），HEAD 變動時再全部檢查一次。
 * 沒有 Git 擴充（被停用）時不做任何事。
 */
export function watchGitHead(onChange: () => void): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  let disposed = false;
  const watchRepo = (repo: GitRepository) => {
    let last = headOf(repo);
    disposables.push(
      repo.state.onDidChange(() => {
        const now = headOf(repo);
        if (now !== last) {
          last = now;
          onChange();
        }
      }),
    );
  };
  void (async () => {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
      if (!ext) {
        return;
      }
      const exports = ext.isActive ? ext.exports : await ext.activate();
      if (disposed) {
        return;
      }
      const api = exports.getAPI(1);
      api.repositories.forEach(watchRepo);
      disposables.push(api.onDidOpenRepository(watchRepo));
    } catch {
      // Git 擴充沒有啟用或版本不同：只靠檔案變更通知
    }
  })();
  return new vscode.Disposable(() => {
    disposed = true;
    disposables.forEach((d) => d.dispose());
  });
}

function headOf(repo: GitRepository): string {
  const h = repo.state.HEAD;
  return `${h?.name ?? ''}@${h?.commit ?? ''}`;
}
