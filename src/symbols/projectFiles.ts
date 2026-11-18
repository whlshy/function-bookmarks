import * as vscode from 'vscode';
import { uriKey } from '../util/uris';
import { relativeUnder } from '../util/paths';
import { projectGlobs, SECTION } from '../config';
import { buildDirTree, DirTree } from './projectTree';

const MAX_FILES = 20000;

export interface FolderFiles {
  folder: vscode.WorkspaceFolder;
  rels: string[];
  tree: DirTree;
  truncated: boolean;
}

/** 「整個專案」區塊與搜尋用的檔案清單，依設定的 include／exclude 掃描並快取。 */
export class ProjectFiles implements vscode.Disposable {
  private cache = new Map<string, Promise<FolderFiles>>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', true, true, false);
    const invalidate = () => {
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(() => {
        this.cache.clear();
        this.changed.fire();
      }, 500);
    };
    this.disposables.push(
      watcher,
      watcher.onDidDelete(invalidate),
      vscode.workspace.onDidCreateFiles(invalidate),
      vscode.workspace.onDidRenameFiles(invalidate),
      vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration(`${SECTION}.project`) && invalidate()),
    );
    // 磁碟上新增檔案（例如 git pull）不會觸發 onDidCreateFiles，另外監看
    const created = vscode.workspace.createFileSystemWatcher('**/*', false, true, true);
    this.disposables.push(created, created.onDidCreate(invalidate));
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    [...this.disposables, this.changed].forEach((d) => d.dispose());
  }

  list(folder: vscode.WorkspaceFolder): Promise<FolderFiles> {
    const key = uriKey(folder.uri);
    let p = this.cache.get(key);
    if (!p) {
      p = this.scan(folder);
      this.cache.set(key, p);
    }
    return p;
  }

  async all(): Promise<FolderFiles[]> {
    return Promise.all((vscode.workspace.workspaceFolders ?? []).map((f) => this.list(f)));
  }

  private async scan(folder: vscode.WorkspaceFolder): Promise<FolderFiles> {
    const { include, exclude } = projectGlobs(folder.uri);
    const excludeGlob = exclude.length ? `{${exclude.join(',')}}` : undefined;
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, include), excludeGlob, MAX_FILES + 1);
    const rels = uris
      .slice(0, MAX_FILES)
      .map((u) => relativeUnder(folder.uri.path, u.path))
      .filter((r): r is string => !!r);
    return { folder, rels, tree: buildDirTree(rels), truncated: uris.length > MAX_FILES };
  }
}
