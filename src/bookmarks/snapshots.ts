import * as vscode from 'vscode';

const STATE_KEY = 'snapshots:v2';
const LEGACY_STATE_KEY = 'snapshots:v1';
/** 每個檔案最多記住幾個分支的內容。 */
const MAX_BRANCH_SNAPSHOTS = 10;
/** 變動後延後多久寫入 workspaceState。 */
const PERSIST_DELAY_MS = 2000;

interface PersistedState {
  known?: Record<string, number[]>;
  branch?: Record<string, string>;
  snaps?: Record<string, Record<string, number[]>>;
}

/**
 * 外部改檔換算用的檔案內容快照（以檔案 uriKey 為鍵），存在 workspaceState：
 * - 記住的內容：書籤行號所對應的行雜湊
 * - 記住的內容屬於哪個分支（分支 id）
 * - 各分支最後記住的內容（分支名稱 → 行雜湊），切回該分支時用來換算
 *
 * 每次變動都延後寫入；停用擴充套件時呼叫 flush() 立刻寫入。
 */
export class FileSnapshots implements vscode.Disposable {
  private known = new Map<string, number[]>();
  private knownBranch = new Map<string, string>();
  private snaps = new Map<string, Map<string, number[]>>();
  private persistTimer: NodeJS.Timeout | undefined;
  private persisting: Promise<void> | undefined;

  constructor(private readonly state: vscode.Memento) {
    this.load();
  }

  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      void this.persist();
    }
  }

  /** 立刻把延後中的快照寫入 workspaceState，並等待進行中的寫入完成。 */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      await this.persist();
    }
    if (this.persisting) {
      await this.persisting;
    }
  }

  has(key: string): boolean {
    return this.known.has(key);
  }

  /** 記住的內容（行雜湊）。 */
  content(key: string): number[] | undefined {
    return this.known.get(key);
  }

  /** 記住的內容屬於哪個分支（分支 id）。 */
  branchOf(key: string): string | undefined {
    return this.knownBranch.get(key);
  }

  /** 記住內容與所屬分支；`branchId` 為 undefined 時保留原本的分支。 */
  remember(key: string, hashes: number[], branchId: string | undefined): void {
    this.known.set(key, hashes);
    if (branchId !== undefined) {
      this.knownBranch.set(key, branchId);
    }
    this.persistSoon();
  }

  /** 只更新所屬分支（內容不變，或保留離開分支的內容供切回時換算）。 */
  setBranch(key: string, branchId: string): void {
    this.knownBranch.set(key, branchId);
    this.persistSoon();
  }

  /** 某分支最後記住的內容。 */
  branchSnapshot(key: string, branch: string): number[] | undefined {
    return this.snaps.get(key)?.get(branch);
  }

  /** 記下某分支的內容（最新的排最後，超過上限丟掉最舊的）。 */
  saveBranch(key: string, branch: string, hashes: number[]): void {
    const m = this.snaps.get(key) ?? new Map<string, number[]>();
    m.delete(branch);
    m.set(branch, hashes);
    while (m.size > MAX_BRANCH_SNAPSHOTS) {
      m.delete(m.keys().next().value as string);
    }
    this.snaps.set(key, m);
    this.persistSoon();
  }

  /** 這個檔案記住了哪些分支的內容。 */
  branches(key: string): string[] {
    return [...(this.snaps.get(key)?.keys() ?? [])];
  }

  /** 清掉指定分支記住的內容；給定 inScope 時只處理符合的檔案。 */
  forgetBranches(names: string[], inScope?: (key: string) => boolean): void {
    let changed = false;
    for (const [k, m] of this.snaps) {
      if (inScope && !inScope(k)) {
        continue;
      }
      for (const n of names) {
        if (m.delete(n)) {
          changed = true;
        }
      }
    }
    if (changed) {
      this.persistSoon();
    }
  }

  /** 所有記住內容的分支名稱；給定 inScope 時只看符合的檔案。 */
  rememberedBranches(inScope?: (key: string) => boolean): string[] {
    const out = new Set<string>();
    for (const [k, m] of this.snaps) {
      if (inScope && !inScope(k)) {
        continue;
      }
      for (const n of m.keys()) {
        out.add(n);
      }
    }
    return [...out];
  }

  /** 檔案改名：內容、所屬分支與分支快照都改記在新的鍵。 */
  move(fromKey: string, toKey: string): void {
    const content = this.known.get(fromKey);
    if (content) {
      this.known.set(toKey, content);
      this.known.delete(fromKey);
    }
    const b = this.knownBranch.get(fromKey);
    if (b !== undefined) {
      this.knownBranch.set(toKey, b);
      this.knownBranch.delete(fromKey);
    }
    const s = this.snaps.get(fromKey);
    if (s) {
      this.snaps.set(toKey, s);
      this.snaps.delete(fromKey);
    }
    this.persistSoon();
  }

  /** 所有有記錄（內容或分支快照）的檔案鍵。 */
  keys(): Set<string> {
    return new Set([...this.known.keys(), ...this.snaps.keys()]);
  }

  /** 不再記住這個檔案（不會自動寫入，處理完一批後呼叫 persistSoon）。 */
  forget(key: string): void {
    this.known.delete(key);
    this.knownBranch.delete(key);
    this.snaps.delete(key);
  }

  persistSoon(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, PERSIST_DELAY_MS);
  }

  private load(): void {
    const saved = this.state.get<PersistedState>(STATE_KEY);
    const known = saved?.known ?? this.state.get<Record<string, number[]>>(LEGACY_STATE_KEY) ?? {};
    for (const [k, v] of Object.entries(known)) {
      if (Array.isArray(v)) {
        this.known.set(k, v);
      }
    }
    for (const [k, v] of Object.entries(saved?.branch ?? {})) {
      if (typeof v === 'string') {
        this.knownBranch.set(k, v);
      }
    }
    for (const [k, v] of Object.entries(saved?.snaps ?? {})) {
      if (v && typeof v === 'object') {
        this.snaps.set(k, new Map(Object.entries(v).filter(([, h]) => Array.isArray(h))));
      }
    }
  }

  private persist(): Promise<void> {
    const data: PersistedState = {
      known: Object.fromEntries(this.known),
      branch: Object.fromEntries(this.knownBranch),
      snaps: Object.fromEntries([...this.snaps].map(([k, m]) => [k, Object.fromEntries(m)])),
    };
    const p = Promise.resolve(this.state.update(STATE_KEY, data)).then(
      () => undefined,
      () => undefined,
    );
    this.persisting = p;
    void p.finally(() => {
      if (this.persisting === p) {
        this.persisting = undefined;
      }
    });
    return p;
  }
}
