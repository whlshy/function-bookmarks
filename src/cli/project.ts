/**
 * CLI：在編輯器外讀寫專案的書籤（找專案根目錄、讀設定、讀寫 .vscode/function-bookmarks.json、讀程式檔）。
 * 只用 Node 的 fs，不依賴編輯器；判讀與計算都交給共用核心（src/core）。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { visibleOnBranch } from '../bookmarks/model';
import { splitLines } from '../bookmarks/relocate';
import { checkLineBookmarks, detectWithRules, FavoriteStatus, resolveFavorite, rulesCover } from '../core/resolve';
import { ConfigReader, Settings, settingsFrom } from '../core/settings';
import { parseSettingsJson, readerFromSettings } from '../core/settingsFile';
import { BOOKMARKS_FILE, decodeStoreText, storeTextToWrite } from '../core/storeFile';
import { DetectedSymbol } from '../detection/types';
import { findGitDir, readBranch } from '../git/branch';
import { withExcludeEntry } from '../storage/gitExclude';
import { favorites, StoreData, SymbolMark } from '../storage/marks';
import { LineBookmark } from '../bookmarks/model';
import { stripBom } from '../util/bom';
import { languageForPath } from '../util/paths';

/** 使用者看得懂、AI 也能照著處理的錯誤（CLI 印出訊息並以非 0 結束）。 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

async function readText(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 找專案根目錄：從 start 往上找最近一個有 .vscode 或 .git 的資料夾；都沒有就用 start。
 * 不再往更上層找別的書籤檔，避免子專案的指令改到上層專案的書籤。
 */
export async function findProjectRoot(start: string): Promise<string> {
  let cur = path.resolve(start);
  for (;;) {
    if ((await exists(path.join(cur, '.vscode'))) || (await exists(path.join(cur, '.git')))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return path.resolve(start);
    }
    cur = parent;
  }
}

/**
 * 「設定 AI 助理」複製到專案裡的 CLI（<root>/.cursor/skills/function-bookmarks/scripts/fb.js 等）：
 * 由自己的位置得知屬於哪個專案，不受執行時所在資料夾影響。不是這種位置時回傳 undefined。
 */
export function rootFromScriptPath(script: string | undefined): string | undefined {
  if (!script) {
    return undefined;
  }
  const parts = path.resolve(script).split(path.sep);
  const n = parts.length;
  const ok =
    n >= 6 &&
    parts[n - 1] === 'fb.js' &&
    parts[n - 2] === 'scripts' &&
    parts[n - 3] === 'function-bookmarks' &&
    parts[n - 4] === 'skills' &&
    ['.cursor', '.claude', '.agents'].includes(parts[n - 5]);
  return ok ? parts.slice(0, n - 5).join(path.sep) || path.sep : undefined;
}

/** 一筆書籤目前的狀態（行號為 0 起算）。 */
export interface ResolvedLine {
  kind: 'line';
  ref: string;
  file: string;
  line: number;
  status?: 'lost' | 'notOnBranch';
  bookmark: LineBookmark;
}

export interface ResolvedFunction {
  kind: 'function';
  ref: string;
  file: string;
  line: number;
  status?: Exclude<FavoriteStatus, 'ok'>;
  /** 這種檔案沒有內建規則（編輯器裡會改用語言伺服器）：CLI 無法確認位置，沿用記錄的行號。 */
  unverified?: boolean;
  mark: SymbolMark;
  symbol?: DetectedSymbol;
}

export type ResolvedItem = ResolvedLine | ResolvedFunction;

export interface SourceFile {
  text: string;
  lines: string[];
  languageId?: string;
  symbols: DetectedSymbol[];
  /** 內建或自訂規則能偵測這個檔案。 */
  covered: boolean;
}

export function functionRef(file: string, path: string): string {
  return `${file}#${path}`;
}

export class Project {
  private sources = new Map<string, SourceFile | undefined>();

  private constructor(
    readonly root: string,
    readonly config: ConfigReader,
    readonly settings: Settings,
    readonly branch: string | undefined,
  ) {}

  static async open(root: string): Promise<Project> {
    const settingsText = await readText(path.join(root, '.vscode', 'settings.json'));
    const config = readerFromSettings(settingsText === undefined ? undefined : parseSettingsJson(settingsText));
    const gitDir = await findGitDir(root);
    const branch = gitDir ? (await readBranch(gitDir))?.name : undefined;
    return new Project(root, config, settingsFrom(config), branch);
  }

  get name(): string {
    return path.basename(this.root);
  }

  get storeFile(): string {
    return path.join(this.root, BOOKMARKS_FILE);
  }

  /** 書籤是否設定成存在編輯器內部（這時 CLI 讀不到，也不能寫）。 */
  get storedInEditor(): boolean {
    return this.config<string>('storage', 'file') === 'workspaceState';
  }

  /**
   * 把使用者給的路徑轉成相對專案根目錄、以 / 分隔的路徑。
   * 可以是相對目前資料夾、相對專案根目錄或完整路徑；不在專案裡時丟出錯誤。
   */
  async relPath(input: string, cwd: string): Promise<string> {
    const candidates = path.isAbsolute(input) ? [input] : [path.resolve(cwd, input), path.resolve(this.root, input)];
    for (const abs of candidates) {
      const rel = path.relative(this.root, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        continue;
      }
      const posix = rel.split(path.sep).join('/');
      if (candidates.length === 1 || (await exists(abs))) {
        return posix;
      }
    }
    const first = candidates[0];
    const rel = path.relative(this.root, first);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new CliError(`${input} is outside the project (${this.root}).`);
    }
    return rel.split(path.sep).join('/');
  }

  /** 讀書籤檔；內容壞掉時丟出錯誤（不要在壞掉的檔案上寫入）。 */
  async readStore(): Promise<{ data: StoreData; exists: boolean }> {
    const text = await readText(this.storeFile);
    const decoded = decodeStoreText(text === undefined ? undefined : stripBom(text));
    if (decoded.kind === 'broken') {
      throw new CliError(`${BOOKMARKS_FILE} is not valid JSON. Fix or delete it in the editor first.`, 2);
    }
    return { data: decoded.data, exists: text !== undefined };
  }

  /**
   * 讀出最新內容、套用修改、寫回（先寫暫存檔再改名，避免編輯器讀到寫一半的檔案）。
   * 第一次建立書籤檔時加進 .git/info/exclude（個人書籤不提交，與套件的做法相同）。
   */
  async updateStore(mutate: (data: StoreData) => StoreData): Promise<StoreData> {
    if (this.storedInEditor) {
      throw new CliError(
        'Bookmarks of this project are stored inside the editor (functionBookmarks.storage = workspaceState), so the CLI cannot change them. Switch the storage to the project file in the editor first.',
        3,
      );
    }
    const { data, exists: had } = await this.readStore();
    const next = mutate(data);
    if (next === data) {
      return data;
    }
    const text = storeTextToWrite(next, had);
    if (text === undefined) {
      return next;
    }
    await fs.mkdir(path.dirname(this.storeFile), { recursive: true });
    const tmp = `${this.storeFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    try {
      await renameWithRetry(tmp, this.storeFile);
    } catch {
      // 改名一直失敗（例如防毒軟體鎖住）：改成直接覆寫
      await fs.rm(tmp, { force: true });
      await fs.writeFile(this.storeFile, text, 'utf8');
    }
    if (!had) {
      await this.excludeFromGit().catch(() => undefined);
    }
    return next;
  }

  private async excludeFromGit(): Promise<void> {
    const gitDir = await findGitDir(this.root);
    if (!gitDir) {
      return;
    }
    const common = (await readText(path.join(gitDir, 'commondir')))?.trim();
    const shared = common ? path.resolve(gitDir, common) : gitDir;
    const repoRoot = path.dirname(gitDir.endsWith(`${path.sep}.git`) ? gitDir : shared);
    const entry = path.relative(repoRoot, this.storeFile).split(path.sep).join('/');
    const excludeFile = path.join(shared, 'info', 'exclude');
    const next = withExcludeEntry(await readText(excludeFile), entry.startsWith('..') ? BOOKMARKS_FILE : entry);
    if (next !== undefined) {
      await fs.mkdir(path.dirname(excludeFile), { recursive: true });
      await fs.writeFile(excludeFile, next, 'utf8');
    }
  }

  /** 讀程式檔並偵測函式（同一個檔案只讀一次）；讀不到時回傳 undefined。 */
  async source(file: string): Promise<SourceFile | undefined> {
    if (this.sources.has(file)) {
      return this.sources.get(file);
    }
    const full = path.join(this.root, ...file.split('/'));
    const raw = await readText(full);
    let src: SourceFile | undefined;
    if (raw !== undefined) {
      const text = stripBom(raw);
      const languageId = languageForPath(file);
      const posixFull = full.split(path.sep).join('/');
      const covered = rulesCover(this.settings, languageId, file, posixFull);
      const symbols = covered && languageId ? detectWithRules(text, languageId, this.settings, file, posixFull).symbols : [];
      src = { text, lines: splitLines(text), languageId, symbols, covered };
    }
    this.sources.set(file, src);
    return src;
  }

  /** 列出目前分支看得到的所有書籤與它們現在的位置（不改書籤檔）。 */
  async resolveAll(data: StoreData): Promise<ResolvedItem[]> {
    const out: ResolvedItem[] = [];
    const bookmarks = (data.bookmarks ?? []).filter((b) => visibleOnBranch(b, this.branch));
    const stored = (b: LineBookmark) => (b.status === 'lost' || b.status === 'notOnBranch' ? b.status : undefined);
    for (const file of [...new Set(bookmarks.map((b) => b.file))]) {
      const inFile = bookmarks.filter((b) => b.file === file);
      const src = await this.source(file);
      const checked = src ? new Map(checkLineBookmarks(inFile.filter((b) => !stored(b)), src.lines, src.symbols).map((r) => [r.id, r])) : undefined;
      for (const b of inFile) {
        const c = checked?.get(b.id);
        out.push({
          kind: 'line',
          ref: b.id,
          file,
          line: c?.line ?? b.line,
          // 編輯器已判定的狀態優先；檔案讀不到時一律需確認
          status: stored(b) ?? (src ? c?.status : 'lost'),
          bookmark: b,
        });
      }
    }
    for (const mark of favorites(data)) {
      const src = await this.source(mark.file);
      if (src && !src.covered) {
        out.push({ kind: 'function', ref: functionRef(mark.file, mark.path), file: mark.file, line: mark.line ?? 0, unverified: true, mark });
        continue;
      }
      const r = resolveFavorite(mark, src?.symbols);
      out.push({
        kind: 'function',
        ref: functionRef(mark.file, mark.path),
        file: mark.file,
        line: r.symbol?.nameLine ?? mark.line ?? 0,
        status: r.status === 'ok' ? undefined : r.status,
        mark,
        symbol: r.symbol,
      });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      if (i >= 4) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}
