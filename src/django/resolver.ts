import * as path from 'path';
import { uriKey } from '../util/uris';
import { normalizeDrive, relativeUnder } from '../util/paths';
import * as vscode from 'vscode';
import { projectGlobs, templateDirs } from '../config';
import { DetectedSymbol } from '../detection/types';
import { SymbolService } from '../symbols/symbolService';
import { findOverrides, pickClosest, splitTemplateTarget } from './templates';

export interface OverrideInfo {
  /** 被覆寫的祖先 template。 */
  uri: vscode.Uri;
  label: string;
  symbol: DetectedSymbol;
}

function escapeGlob(s: string): string {
  return s.replace(/[[\]{}()*?!]/g, (c) => `[${c}]`);
}

/** 把 `{% extends %}`／`{% include %}` 的目標解析成實際檔案。 */
export class TemplateResolver implements vscode.Disposable {
  private cache = new Map<string, Promise<vscode.Uri | undefined>>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly service: SymbolService) {
    const w = vscode.workspace.createFileSystemWatcher('**/*.{html,htm,djhtml,jinja,jinja2,j2,txt}', false, true, false);
    const clear = () => this.cache.clear();
    this.disposables.push(w, w.onDidCreate(clear), w.onDidDelete(clear), vscode.workspace.onDidRenameFiles(clear));
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  resolve(target: string, from: vscode.Uri): Promise<vscode.Uri | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(from);
    const { file } = splitTemplateTarget(target);
    const key = `${folder ? uriKey(folder.uri) : ''}|${file}|${path.posix.dirname(normalizeDrive(from.path))}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.lookup(file, from, folder);
      this.cache.set(key, p);
    }
    return p;
  }

  private async lookup(file: string, from: vscode.Uri, folder: vscode.WorkspaceFolder | undefined): Promise<vscode.Uri | undefined> {
    if (!file || file.includes('..')) {
      return undefined;
    }
    const folders = folder ? [folder, ...(vscode.workspace.workspaceFolders ?? []).filter((f) => f !== folder)] : vscode.workspace.workspaceFolders ?? [];
    // 1. 設定的 template 資料夾（相對於工作區資料夾）
    for (const f of folders) {
      for (const dir of templateDirs(f.uri)) {
        const uri = vscode.Uri.joinPath(f.uri, ...dir.split(/[\\/]/).filter(Boolean), ...file.split('/'));
        if (await vscode.workspace.fs.stat(uri).then(() => true, () => false)) {
          return uri;
        }
      }
    }
    // 2. 任何名為 templates 的資料夾（Django 預設的 APP_DIRS 慣例）
    for (const f of folders) {
      const { exclude } = projectGlobs(f.uri);
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(f, `**/templates/${escapeGlob(file)}`),
        exclude.length ? `{${exclude.join(',')}}` : undefined,
        50,
      );
      if (found.length) {
        const rels = found.map((u) => relativeUnder(f.uri.path, u.path) ?? u.path);
        const fromRel = relativeUnder(f.uri.path, from.path) ?? from.path;
        const pick = pickClosest(fromRel, rels);
        return found[rels.indexOf(pick!)];
      }
    }
    return undefined;
  }

  /** 找出目前 template 的每個 block 覆寫了哪個祖先 template 的同名 block。 */
  async overrides(uri: vscode.Uri, symbols: DetectedSymbol[]): Promise<Map<string, OverrideInfo>> {
    const found = await findOverrides<vscode.Uri>(
      symbols,
      async (target, parent) => {
        const resolved = await this.resolve(target, parent ?? uri);
        if (!resolved) {
          return undefined;
        }
        const file = await this.service.getForUri(resolved);
        return file ? { template: resolved, key: uriKey(resolved), symbols: file.symbols } : undefined;
      },
      uriKey(uri),
    );
    const out = new Map<string, OverrideInfo>();
    for (const [name, a] of found) {
      out.set(name, { uri: a.template, label: vscode.workspace.asRelativePath(a.template, false), symbol: a.symbol });
    }
    return out;
  }
}
