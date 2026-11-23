import * as vscode from 'vscode';

/** `.git` 資料夾裡的檔案（index、refs、logs…）：git 操作時大量變動，沒有模組需要。 */
export function isInsideGitDir(uri: vscode.Uri): boolean {
  return /\/\.git(\/|$)/.test(uri.path);
}

/**
 * 整個套件共用的檔案監看器（磁碟上的新增、修改、刪除）。
 * 原本外部變動、函式書籤、整個專案各自建立監看整個工作區的監看器；合併成一個，先排除 `.git` 內部的檔案再分送。
 */
export class FileEvents implements vscode.Disposable {
  private readonly created = new vscode.EventEmitter<vscode.Uri>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly deleted = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidCreate = this.created.event;
  readonly onDidChange = this.changed.event;
  readonly onDidDelete = this.deleted.event;
  private readonly disposables: vscode.Disposable[];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const forward = (emitter: vscode.EventEmitter<vscode.Uri>) => (uri: vscode.Uri) => {
      if (!isInsideGitDir(uri)) {
        emitter.fire(uri);
      }
    };
    this.disposables = [
      watcher,
      watcher.onDidCreate(forward(this.created)),
      watcher.onDidChange(forward(this.changed)),
      watcher.onDidDelete(forward(this.deleted)),
      this.created,
      this.changed,
      this.deleted,
    ];
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
