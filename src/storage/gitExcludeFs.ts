import * as path from 'path';
import * as vscode from 'vscode';
import { relativeUnder } from '../util/paths';
import { uriKey } from '../util/uris';
import { BOOKMARKS_FILE, isCovered, parseGitDirFile, withExcludeEntry } from './gitExclude';

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

function parentUri(uri: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme === 'file') {
    const cur = path.resolve(uri.fsPath);
    const parent = path.dirname(cur);
    return parent === cur ? undefined : vscode.Uri.file(parent);
  }
  const p = path.posix.dirname(uri.path);
  return p === uri.path ? undefined : uri.with({ path: p });
}

function resolveRelativeUri(base: vscode.Uri, target: string): vscode.Uri {
  if (base.scheme === 'file') {
    return vscode.Uri.file(path.resolve(base.fsPath, target));
  }
  const normalized = target.replace(/\\/g, '/');
  return normalized.startsWith('/')
    ? base.with({ path: path.posix.normalize(normalized) })
    : base.with({ path: path.posix.resolve(base.path, normalized) });
}

interface ResolvedGitRepo {
  /** 找到 `.git` 的專案根目錄（worktree 時為 worktree 根目錄）。 */
  repoRoot: vscode.Uri;
  /** 寫入 `info/exclude` 的共用 git 目錄（worktree 會跟隨 commondir 指向主 repo 的 `.git`）。 */
  commonGitDir: vscode.Uri;
}

/** 往上層目錄尋找 `.git`（支援 monorepo 子資料夾），並解析 worktree 的 `commondir`。 */
async function resolveGitRepo(folder: vscode.Uri): Promise<ResolvedGitRepo | undefined> {
  let cur: vscode.Uri | undefined = folder;
  while (cur) {
    const dotGit = vscode.Uri.joinPath(cur, '.git');
    try {
      const stat = await vscode.workspace.fs.stat(dotGit);
      let gitDir: vscode.Uri | undefined;
      if (stat.type & vscode.FileType.Directory) {
        gitDir = dotGit;
      } else if (stat.type & vscode.FileType.File) {
        const target = parseGitDirFile((await readText(dotGit)) ?? '');
        if (target) {
          gitDir = resolveRelativeUri(cur, target);
        }
      }
      if (gitDir) {
        const common = (await readText(vscode.Uri.joinPath(gitDir, 'commondir')))?.trim();
        const commonGitDir = common ? resolveRelativeUri(gitDir, common) : gitDir;
        return { repoRoot: cur, commonGitDir };
      }
    } catch {
      // 這一層沒有 .git，繼續往上找
    }
    cur = parentUri(cur);
  }
  return undefined;
}

/**
 * 確保書籤檔不會被 git 追蹤：已被 `.gitignore`（含上層至 repo 根目錄）或共用 `.git/info/exclude` 涵蓋就不動，
 * 否則把相對於 repo 根目錄的路徑加進共用 `.git/info/exclude`。不是 git 專案時什麼都不做。
 * 由儲存層第一次寫入書籤檔時呼叫（M2）。
 */
export async function ensureBookmarksFileExcluded(folder: vscode.Uri, fileInFolder = BOOKMARKS_FILE): Promise<'already' | 'added' | 'notGit'> {
  const repo = await resolveGitRepo(folder);
  if (!repo) {
    return 'notGit';
  }
  // 由工作區資料夾往上檢查至 repo 根目錄的 .gitignore
  let cur: vscode.Uri | undefined = folder;
  while (cur) {
    const relFromCur = uriKey(cur) === uriKey(folder) ? '' : relativeUnder(cur.path, folder.path)?.replace(/\/+$/, '');
    const entryFromCur = relFromCur ? `${relFromCur}/${fileInFolder}` : fileInFolder;
    if (isCovered(await readText(vscode.Uri.joinPath(cur, '.gitignore')), entryFromCur)) {
      return 'already';
    }
    if (uriKey(cur) === uriKey(repo.repoRoot)) {
      break;
    }
    cur = parentUri(cur);
  }
  const relFromRoot = uriKey(repo.repoRoot) === uriKey(folder) ? '' : relativeUnder(repo.repoRoot.path, folder.path)?.replace(/\/+$/, '');
  const entry = relFromRoot ? `${relFromRoot}/${fileInFolder}` : fileInFolder;
  const exclude = vscode.Uri.joinPath(repo.commonGitDir, 'info', 'exclude');
  const next = withExcludeEntry(await readText(exclude), entry);
  if (next === undefined) {
    return 'already';
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(repo.commonGitDir, 'info'));
  await vscode.workspace.fs.writeFile(exclude, new TextEncoder().encode(next));
  return 'added';
}
