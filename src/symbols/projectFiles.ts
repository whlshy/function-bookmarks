import * as vscode from 'vscode';
import { uriKey } from '../util/uris';
import { matchesAny, relativeUnder } from '../util/paths';
import { projectGlobs, SECTION } from '../config';
import { FileEvents } from '../util/fileEvents';
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
  /** 掃描完成的清單（判斷刪除的是不是清單裡的資料夾）。 */
  private resolved = new Map<string, Set<string>>();
  /** 有符合 include 的檔案新增或刪除、等著重新掃描的工作區資料夾。 */
  private dirty = new Set<string>();
  /** 曾輕量檢查為空專案；之後新增符合條件的檔案時需觸發更新讓「整個專案」恢復展開箭頭。 */
  private emptyProbed = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(files: FileEvents) {
    const all = () => {
      for (const key of this.cache.keys()) {
        this.dirty.add(key);
      }
      this.flushSoon();
    };
    this.disposables.push(
      // 磁碟上新增檔案（例如 git pull）不會觸發 onDidCreateFiles，所以也看檔案監看器
      files.onDidCreate((uri) => void this.touched(uri, false)),
      files.onDidDelete((uri) => void this.touched(uri, true)),
      vscode.workspace.onDidCreateFiles((e) => e.files.forEach((uri) => void this.touched(uri, false))),
      vscode.workspace.onDidDeleteFiles((e) => e.files.forEach((uri) => void this.touched(uri, true))),
      vscode.workspace.onDidRenameFiles((e) =>
        e.files.forEach(({ oldUri, newUri }) => {
          void this.touched(oldUri, true);
          void this.touched(newUri, false);
        }),
      ),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.cache.clear();
        this.resolved.clear();
        this.flushSoon();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration(`${SECTION}.project`) && all()),
    );
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    [...this.disposables, this.changed].forEach((d) => d.dispose());
  }

  /**
   * 檔案新增或刪除：只有符合 include（且不在 exclude）的檔案，或清單裡的檔案所在的資料夾，
   * 才重新掃描那個工作區資料夾（.git、node_modules、建置輸出的變動不影響）。
   */
  private async touched(uri: vscode.Uri, removed: boolean): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return;
    }
    const key = uriKey(folder.uri);
    const rel = relativeUnder(folder.uri.path, uri.path);
    if (!rel || (!this.cache.has(key) && !(this.emptyProbed && !removed)) || this.dirty.has(key)) {
      return;
    }
    const { include, exclude } = projectGlobs(folder.uri);
    if (matchesAny(exclude, rel)) {
      return;
    }
    let affects = matchesAny([include], rel);
    if (!affects && removed) {
      // 刪除或改名的是資料夾：清單裡有它底下的檔案才算
      const rels = this.resolved.get(key);
      affects = !rels || [...rels].some((r) => r.startsWith(`${rel}/`));
    } else if (!affects) {
      // 新增的可能是整個資料夾（例如搬進來、切換分支）
      affects = await vscode.workspace.fs.stat(uri).then(
        (s) => (s.type & vscode.FileType.Directory) !== 0,
        () => false,
      );
    }
    if (affects) {
      this.dirty.add(key);
      this.flushSoon();
    }
  }

  private flushSoon(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const key of this.dirty) {
        this.cache.delete(key);
        this.resolved.delete(key);
      }
      this.dirty.clear();
      this.changed.fire();
    }, 500);
  }

  list(folder: vscode.WorkspaceFolder): Promise<FolderFiles> {
    const key = uriKey(folder.uri);
    let p = this.cache.get(key);
    if (!p) {
      p = this.scan(folder);
      this.cache.set(key, p);
      const scanning = p;
      void p.then(
        (r) => {
          if (this.cache.get(key) === scanning) {
            this.resolved.set(key, new Set(r.rels));
          }
        },
        () => undefined,
      );
    }
    return p;
  }

  async all(): Promise<FolderFiles[]> {
    return Promise.all((vscode.workspace.workspaceFolders ?? []).map((f) => this.list(f)));
  }

  /** 輕量檢查工作區是否有至少一個符合 include 的檔案（空專案時讓「整個專案」不顯示展開箭頭）。 */
  async hasAny(): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const key = uriKey(folder.uri);
      const cached = this.dirty.has(key) ? undefined : this.resolved.get(key);
      if (cached) {
        if (cached.size > 0) {
          return true;
        }
        continue;
      }
      const { include, exclude } = projectGlobs(folder.uri);
      const excludeGlob = exclude.length ? `{${exclude.join(',')}}` : undefined;
      const hit = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, include), excludeGlob, 1);
      if (hit.length > 0) {
        this.emptyProbed = false;
        return true;
      }
    }
    this.emptyProbed = true;
    return false;
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
