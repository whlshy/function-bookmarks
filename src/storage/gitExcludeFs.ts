import * as path from 'path';
import * as vscode from 'vscode';
import { isCovered, parseGitDirFile, withExcludeEntry } from './gitExclude';

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function resolveGitDir(folder: vscode.Uri): Promise<vscode.Uri | undefined> {
  const dotGit = vscode.Uri.joinPath(folder, '.git');
  try {
    const stat = await vscode.workspace.fs.stat(dotGit);
    if (stat.type & vscode.FileType.Directory) {
      return dotGit;
    }
    const target = parseGitDirFile((await readText(dotGit)) ?? '');
    if (!target) {
      return undefined;
    }
    return path.isAbsolute(target) ? folder.with({ path: vscode.Uri.file(target).path }) : vscode.Uri.joinPath(folder, target);
  } catch {
    return undefined;
  }
}

/**
 * 確保書籤檔不會被 git 追蹤：已被 `.gitignore` 或 `.git/info/exclude` 涵蓋就不動，
 * 否則加進 `.git/info/exclude`。不是 git 專案時什麼都不做。
 * 由儲存層第一次寫入書籤檔時呼叫（M2）。
 */
export async function ensureBookmarksFileExcluded(folder: vscode.Uri): Promise<'already' | 'added' | 'notGit'> {
  const gitDir = await resolveGitDir(folder);
  if (!gitDir) {
    return 'notGit';
  }
  if (isCovered(await readText(vscode.Uri.joinPath(folder, '.gitignore')))) {
    return 'already';
  }
  const exclude = vscode.Uri.joinPath(gitDir, 'info', 'exclude');
  const next = withExcludeEntry(await readText(exclude));
  if (next === undefined) {
    return 'already';
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(gitDir, 'info'));
  await vscode.workspace.fs.writeFile(exclude, new TextEncoder().encode(next));
  return 'added';
}
