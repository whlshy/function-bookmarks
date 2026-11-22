/**
 * 讀取目前的 git 分支（直接讀 .git/HEAD，不呼叫 git 指令，也不必等 Git 擴充的通知）。
 * 解析的部分是純函式，方便單元測試。
 */
import * as fs from 'fs/promises';
import * as path from 'path';

export interface BranchState {
  /** 分支名稱；detached HEAD 時為 undefined。 */
  name?: string;
  /** 用來判斷「是否切換了」：分支名稱，detached 時為 `@<commit>`。 */
  id: string;
  /** git 正在改檔（index.lock 存在），稍後再處理比較安全。 */
  busy: boolean;
  gitDir: string;
}

/** 解析 HEAD 檔案內容：`ref: refs/heads/main` → main；commit 雜湊 → detached。 */
export function parseHead(content: string): { name?: string; commit?: string } {
  const s = content.trim();
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(s);
  if (m) {
    return { name: m[1].trim() };
  }
  if (/^[0-9a-f]{7,64}$/i.test(s)) {
    return { commit: s.toLowerCase() };
  }
  return {};
}

/** 解析 worktree／submodule 的 `.git` 檔案：`gitdir: ../.git/worktrees/x`。 */
export function parseGitFile(content: string, dir: string): string | undefined {
  const m = /^gitdir:\s*(.+)$/m.exec(content.trim());
  return m ? path.resolve(dir, m[1].trim()) : undefined;
}

/** rebase 進行中時 HEAD 是 detached，從 head-name 取得正在 rebase 的分支（`refs/heads/x` → x）。 */
export function parseHeadName(content: string): string | undefined {
  const m = /^refs\/heads\/(.+)$/.exec(content.trim());
  return m ? m[1].trim() : undefined;
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

/** 從資料夾往上找 git 目錄。 */
export async function findGitDir(dir: string): Promise<string | undefined> {
  let cur = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(cur, '.git');
    try {
      const st = await fs.stat(dotGit);
      if (st.isDirectory()) {
        return dotGit;
      }
      if (st.isFile()) {
        const target = parseGitFile((await readText(dotGit)) ?? '', cur);
        if (target) {
          return target;
        }
      }
    } catch {
      // 這一層沒有 .git，往上找
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return undefined;
    }
    cur = parent;
  }
}

export async function readBranch(gitDir: string): Promise<BranchState | undefined> {
  const head = await readText(path.join(gitDir, 'HEAD'));
  if (head === undefined) {
    return undefined;
  }
  const parsed = parseHead(head);
  let name = parsed.name;
  if (!name) {
    // rebase 進行中：仍算是原本的分支，避免中間的每一步都被當成切換分支
    for (const d of ['rebase-merge', 'rebase-apply']) {
      const hn = await readText(path.join(gitDir, d, 'head-name'));
      if (hn) {
        name = parseHeadName(hn);
        if (name) {
          break;
        }
      }
    }
  }
  const busy = await exists(path.join(gitDir, 'index.lock'));
  return { name, id: name ?? `@${parsed.commit ?? 'unknown'}`, busy, gitDir };
}

/** 解析 packed-refs，取出本機分支名稱。 */
export function parsePackedRefs(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^[0-9a-f]{7,64}\s+refs\/heads\/(.+)$/i.exec(line.trim());
    if (m) {
      out.push(m[1]);
    }
  }
  return out;
}

async function listRefDir(dir: string, prefix: string, out: Set<string>): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await listRefDir(path.join(dir, e.name), name, out);
    } else if (e.isFile()) {
      out.add(name);
    }
  }
}

/** 本機所有分支名稱（refs/heads 與 packed-refs；worktree 會到共用的 git 目錄找）。 */
export async function listBranches(gitDir: string): Promise<string[]> {
  const common = (await readText(path.join(gitDir, 'commondir')))?.trim();
  const base = common ? path.resolve(gitDir, common) : gitDir;
  const out = new Set<string>();
  await listRefDir(path.join(base, 'refs', 'heads'), '', out);
  parsePackedRefs((await readText(path.join(base, 'packed-refs'))) ?? '').forEach((b) => out.add(b));
  return [...out].sort();
}

/** 解析 git 設定檔（.git/config、~/.gitconfig），鍵為 `section.key` 或 `section.sub.key`（小寫）。 */
export function parseGitConfig(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let section = '';
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const sec = /^\[\s*([^\s\]"]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
    if (sec) {
      section = sec[2] !== undefined ? `${sec[1].toLowerCase()}.${sec[2]}` : sec[1].toLowerCase();
      continue;
    }
    const kv = /^([A-Za-z][\w-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (kv && section) {
      let v = (kv[2] ?? 'true').trim();
      if (/^".*"$/.test(v)) {
        v = v.slice(1, -1);
      }
      out.set(`${section}.${kv[1].toLowerCase()}`, v);
    }
  }
  return out;
}

async function commonDir(gitDir: string): Promise<string> {
  const common = (await readText(path.join(gitDir, 'commondir')))?.trim();
  return common ? path.resolve(gitDir, common) : gitDir;
}

/** 目前的 commit（HEAD 指向的分支 → refs/heads 或 packed-refs）。 */
export async function readHeadCommit(gitDir: string): Promise<string | undefined> {
  const head = parseHead((await readText(path.join(gitDir, 'HEAD'))) ?? '');
  if (head.commit) {
    return head.commit;
  }
  if (!head.name) {
    return undefined;
  }
  const base = await commonDir(gitDir);
  const loose = (await readText(path.join(base, 'refs', 'heads', ...head.name.split('/'))))?.trim();
  if (loose && /^[0-9a-f]{7,64}$/i.test(loose)) {
    return loose.toLowerCase();
  }
  for (const line of ((await readText(path.join(base, 'packed-refs'))) ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{7,64})\s+refs\/heads\/(.+)$/i.exec(line.trim());
    if (m && m[2] === head.name) {
      return m[1].toLowerCase();
    }
  }
  return undefined;
}

/** origin（沒有就第一個）remote 的網址。 */
export async function readRemoteUrl(gitDir: string): Promise<string | undefined> {
  const cfg = parseGitConfig((await readText(path.join(await commonDir(gitDir), 'config'))) ?? '');
  if (cfg.has('remote.origin.url')) {
    return cfg.get('remote.origin.url');
  }
  for (const [k, v] of cfg) {
    if (/^remote\..+\.url$/.test(k)) {
      return v;
    }
  }
  return undefined;
}

/** git 的 user.name：專案設定優先，其次 ~/.gitconfig。 */
export async function readUserName(gitDir: string | undefined, home: string): Promise<string | undefined> {
  if (gitDir) {
    const local = parseGitConfig((await readText(path.join(await commonDir(gitDir), 'config'))) ?? '').get('user.name');
    if (local) {
      return local;
    }
  }
  for (const f of [path.join(home, '.gitconfig'), path.join(home, '.config', 'git', 'config')]) {
    const v = parseGitConfig((await readText(f)) ?? '').get('user.name');
    if (v) {
      return v;
    }
  }
  return undefined;
}
