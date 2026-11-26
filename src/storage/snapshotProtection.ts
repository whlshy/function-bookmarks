import * as vscode from 'vscode';

/**
 * 分支快照保護：切換存放位置、或等待使用者決定是否從另一端複製書籤時，
 * 這些檔案（uriKey）的書籤暫時是空的，但分支快照不能被外部監看清掉，
 * 否則書籤複製回來後就找不回在其他分支的位置。
 *
 * 啟動時另一端存放的背景檢查完成前，沒有書籤資料的資料夾也一律先保護。
 */
export class SnapshotProtection implements vscode.Disposable {
  private files = new Set<string>();
  /** 啟動時的另一端存放檢查尚未完成。 */
  private startupCheckPending = false;
  private readonly changed = new vscode.EventEmitter<void>();
  /** 保護範圍縮小了（例如啟動檢查結束或使用者點了「保持空白」）：讓外部監看補清理不再需要的快照。 */
  readonly onDidChange = this.changed.event;

  /** `hasData`：資料夾目前有沒有書籤資料（啟動檢查期間，沒有資料的資料夾一律保護）。 */
  constructor(private readonly hasData: (folder: vscode.WorkspaceFolder) => boolean) {}

  dispose(): void {
    this.changed.dispose();
  }

  /** 這個檔案（uriKey）是否暫時不可清除其分支快照。 */
  isProtected(fileUriKey: string): boolean {
    if (this.files.has(fileUriKey)) {
      return true;
    }
    if (!this.startupCheckPending) {
      return false;
    }
    const folder = folderOfFileKey(fileUriKey);
    return !folder || !this.hasData(folder);
  }

  /** 啟動時：有空白資料夾就先保護，等背景檢查結束（finishStartupCheck）。 */
  beginStartupCheck(pending: boolean): void {
    this.startupCheckPending = pending;
  }

  get startupPending(): boolean {
    return this.startupCheckPending;
  }

  /** 背景檢查結束：檢查開始時或現在仍在保護中的話，解除並通知。 */
  finishStartupCheck(wasPending: boolean): void {
    if (wasPending || this.startupCheckPending) {
      this.startupCheckPending = false;
      this.changed.fire();
    }
  }

  /** 整組換成新的保護清單（範圍縮小時通知）。 */
  set(next: Set<string>): void {
    const shrank = [...this.files].some((k) => !next.has(k));
    this.files = next;
    if (shrank) {
      this.changed.fire();
    }
  }

  add(keys: Set<string>): void {
    for (const k of keys) {
      this.files.add(k);
    }
  }

  /** 解除保護（有解除任何一個時通知）。 */
  release(keys: Set<string>): void {
    let removed = false;
    for (const k of keys) {
      if (this.files.delete(k)) {
        removed = true;
      }
    }
    if (removed) {
      this.changed.fire();
    }
  }
}

function folderOfFileKey(fileUriKey: string): vscode.WorkspaceFolder | undefined {
  try {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(fileUriKey));
  } catch {
    return undefined;
  }
}
