import * as vscode from 'vscode';
import { uriKey } from '../util/uris';
import { BranchState, findGitDir, listBranches, readBranch } from './branch';

export interface BranchChange {
  folder: vscode.WorkspaceFolder;
  from: BranchState | undefined;
  to: BranchState | undefined;
}

/**
 * 每個工作區資料夾目前的 git 分支。不是 git 專案時為 undefined（不使用分支功能）。
 * 偵測：監看 .git/HEAD、Git 擴充的 HEAD 變動通知（由外部呼叫 refresh）、視窗回到前景。
 */
export class BranchService implements vscode.Disposable {
  private states = new Map<string, BranchState | undefined>();
  private gitDirs = new Map<string, string | undefined>();
  private watchers = new Map<string, vscode.Disposable>();
  private readonly changed = new vscode.EventEmitter<BranchChange>();
  readonly onDidChange = this.changed.event;
  private disposables: vscode.Disposable[] = [];
  private refreshing: Promise<void> | undefined;
  private again = false;

  constructor() {
    this.disposables.push(
      this.changed,
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
      vscode.window.onDidChangeWindowState((s) => s.focused && void this.refresh()),
    );
  }

  dispose(): void {
    this.watchers.forEach((w) => w.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  /** 目前分支（快取）。 */
  current(folder: vscode.WorkspaceFolder | undefined): BranchState | undefined {
    return folder ? this.states.get(uriKey(folder.uri)) : undefined;
  }

  /** 目前分支名稱（detached HEAD、不是 git 專案時為 undefined）。 */
  name(folder: vscode.WorkspaceFolder | undefined): string | undefined {
    return this.current(folder)?.name;
  }

  /** 重新讀取所有資料夾的分支；同時只跑一次，期間又被呼叫就再跑一次。 */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          await this.refreshFolder(folder);
        }
      } while (this.again);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** 讀取一個資料夾目前的分支（不用快取），有變就發出通知。 */
  async read(folder: vscode.WorkspaceFolder): Promise<BranchState | undefined> {
    return this.refreshFolder(folder);
  }

  private async refreshFolder(folder: vscode.WorkspaceFolder): Promise<BranchState | undefined> {
    if (folder.uri.scheme !== 'file') {
      return undefined;
    }
    const key = uriKey(folder.uri);
    if (!this.gitDirs.has(key)) {
      const dir = await findGitDir(folder.uri.fsPath);
      this.gitDirs.set(key, dir);
      if (dir) {
        this.watchHead(key, dir);
      }
    }
    const dir = this.gitDirs.get(key);
    const next = dir ? await readBranch(dir) : undefined;
    const prev = this.states.get(key);
    this.states.set(key, next);
    if (prev?.id !== next?.id && this.statesKnown.has(key)) {
      this.changed.fire({ folder, from: prev, to: next });
    }
    this.statesKnown.add(key);
    return next;
  }

  /** 重新尋找各資料夾的 git 目錄（資料夾裡新增或刪除了 git 專案；測試用）。 */
  async rescan(): Promise<void> {
    this.watchers.forEach((w) => w.dispose());
    this.watchers.clear();
    this.gitDirs.clear();
    const before = new Map(this.states);
    this.states.clear();
    this.statesKnown.clear();
    await this.refresh();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const key = uriKey(folder.uri);
      const from = before.get(key);
      const to = this.states.get(key);
      if (from?.id !== to?.id) {
        this.changed.fire({ folder, from, to });
      }
    }
  }

  /** 資料夾所在的 git 目錄；不是 git 專案時為 undefined。 */
  async gitDirOf(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    if (!this.gitDirs.has(uriKey(folder.uri))) {
      await this.refreshFolder(folder);
    }
    return this.gitDirs.get(uriKey(folder.uri));
  }

  /** 本機現有的分支名稱；不是 git 專案時為 undefined。 */
  async existingBranches(folder: vscode.WorkspaceFolder): Promise<string[] | undefined> {
    if (!this.gitDirs.has(uriKey(folder.uri))) {
      await this.refreshFolder(folder);
    }
    const dir = this.gitDirs.get(uriKey(folder.uri));
    return dir ? listBranches(dir) : undefined;
  }

  /** 第一次讀到之前不算「切換」。 */
  private statesKnown = new Set<string>();

  private watchHead(key: string, gitDir: string): void {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(gitDir), 'HEAD'));
    const on = () => void this.refresh();
    w.onDidChange(on);
    w.onDidCreate(on);
    this.watchers.set(key, w);
  }
}
