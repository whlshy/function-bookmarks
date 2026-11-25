/**
 * 檔案在編輯器外被修改（git pull、切換分支、其他工具、AI 改檔）時，換算行號書籤的新位置。
 * 全部是純函式，不依賴 VS Code。
 *
 * 做法：比對「上次記住的檔案內容」與「現在的內容」（行的雜湊），得到差異區塊，
 * 書籤所在的行沒被改動就依差異平移；被改動或找不到時，再用 anchor（該行內容、前後文、所在函式）後備定位。
 */
import { BookmarkAnchor, BranchPosition, LineBookmark } from './model';

/** 一段差異：舊檔 [oldStart, oldEnd) 被換成新檔 [newStart, newEnd)。 */
export interface Hunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** 行內容的雜湊（FNV-1a 32 位元），忽略行尾空白與 \r。 */
export function hashLine(line: string): number {
  const s = line.replace(/\s+$/, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function hashLines(text: string): number[] {
  return splitLines(text).map(hashLine);
}

/** 一次編輯：舊文件中從 startLine 到 endLine（含）被換成 text。 */
export interface LineHashEdit {
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * 依編輯內容局部更新每行雜湊（只重算被改到的行），避免每打一個字就把整份檔案重新雜湊。
 * `edits` 是同一次變動事件的所有編輯（座標都相對於編輯前的文件、互不重疊）；`lineAt` 讀取編輯後文件的某一行。
 * 遇到無法確定的情況（同一行有多處編輯、行數對不上）回傳 undefined，呼叫端改用整份重算。
 */
export function updateLineHashes(
  old: readonly number[],
  edits: readonly LineHashEdit[],
  newLineCount: number,
  lineAt: (line: number) => string,
): number[] | undefined {
  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine);
  const out: number[] = [];
  let oldPos = 0;
  let delta = 0;
  for (const e of sorted) {
    if (e.startLine < oldPos || e.endLine < e.startLine || e.endLine >= old.length) {
      return undefined;
    }
    const added = splitLines(e.text).length;
    for (let i = oldPos; i < e.startLine; i++) {
      out.push(old[i]);
    }
    const newStart = e.startLine + delta;
    for (let i = 0; i < added; i++) {
      out.push(hashLine(lineAt(newStart + i)));
    }
    oldPos = e.endLine + 1;
    delta += added - (e.endLine - e.startLine + 1);
  }
  for (let i = oldPos; i < old.length; i++) {
    out.push(old[i]);
  }
  return out.length === newLineCount ? out : undefined;
}

/** 差異太大時不再細算，整段視為被取代（交給後備定位）。 */
const MAX_EDIT_DISTANCE = 4000;

/**
 * Myers 差異演算法（先去掉頭尾相同的部分）。回傳依舊檔位置排序的差異區塊。
 */
export function diffLines(a: number[], b: number[]): Hunk[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const n = A.length;
  const m = B.length;
  if (n === 0 && m === 0) {
    return [];
  }
  if (n === 0 || m === 0) {
    return [{ oldStart: start, oldEnd: endA, newStart: start, newEnd: endB }];
  }
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  // 第 d 步開始前的 v：回溯時只會用到 k ∈ [-d, d]，只存這 2d+1 個（存整條在大檔大改時會配置上百 MB）
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && d <= MAX_EDIT_DISTANCE; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) {
      break;
    }
  }
  if (!found) {
    return [{ oldStart: start, oldEnd: endA, newStart: start, newEnd: endB }];
  }
  // 回溯出相同的行（對角線），再反推差異區塊
  const matches: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    // trace[d][i] 對應 v[offset + i - d]
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[d + k - 1] < vd[d + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = d > 0 ? vd[d + prevK] : 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([x, y]);
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  matches.reverse();
  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [mx, my] of [...matches, [n, m] as [number, number]]) {
    if (mx > ai || my > bi) {
      hunks.push({ oldStart: start + ai, oldEnd: start + mx, newStart: start + bi, newEnd: start + my });
    }
    ai = mx + 1;
    bi = my + 1;
  }
  return hunks;
}

/** 依差異區塊換算舊行號；落在被修改或刪除的範圍內時 changed = true（新位置為該區塊的開頭）。 */
export function mapLine(line: number, hunks: Hunk[]): { line: number; changed: boolean } {
  let delta = 0;
  for (const h of hunks) {
    if (line < h.oldStart) {
      break;
    }
    if (line < h.oldEnd) {
      return { line: h.newStart, changed: true };
    }
    delta += h.newEnd - h.newStart - (h.oldEnd - h.oldStart);
  }
  return { line: line + delta, changed: false };
}

/** 合併衝突的範圍（<<<<<<< 到 >>>>>>>，含頭尾），以行號表示。 */
export function conflictRegions(lines: string[]): [number, number][] {
  const out: [number, number][] = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^<{7}(\s|$)/.test(lines[i])) {
      open = i;
    } else if (open >= 0 && /^>{7}(\s|$)/.test(lines[i])) {
      out.push([open, i]);
      open = -1;
    }
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** 兩行內容的相似度（0～1），去掉頭尾空白後比較，超過 200 字只比前 200 字。 */
export function similarity(a: string, b: string): number {
  const x = a.trim().slice(0, 200);
  const y = b.trim().slice(0, 200);
  if (!x && !y) {
    return 1;
  }
  const max = Math.max(x.length, y.length);
  return 1 - levenshtein(x, y) / max;
}

function contextScore(lines: string[], i: number, anchor: BookmarkAnchor): number {
  const at = (j: number) => (j >= 0 && j < lines.length ? lines[j].trim() : undefined);
  let score = 0;
  const pairs: [string | undefined, string | undefined][] = [
    [anchor.before[1], at(i - 1)],
    [anchor.before[0], at(i - 2)],
    [anchor.after[0], at(i + 1)],
    [anchor.after[1], at(i + 2)],
  ];
  for (const [want, got] of pairs) {
    if (want && got !== undefined && want === got) {
      score++;
    }
  }
  return score;
}

/** 常見、到處都會出現的關鍵字行（去掉符號後比較）。 */
const COMMON_WORDS = new Set([
  'pass', 'else', 'elif', 'break', 'except', 'raise', 'yield', 'begin', 'then', 'return', 'continue', 'finally', 'default', 'endblock', 'endfor', 'endif', 'endwith', 'endpartialdef',
  'endcomment', 'endverbatim', 'document', 'script', 'template', 'endmacro',
]);

/** 內容太短、只有符號或是常見關鍵字（例如 `}`、`pass`、`else:`、`{% endblock %}`）時，光靠該行內容不可靠，需要前後文佐證。 */
function isTrivial(text: string): boolean {
  const words = text.replace(/[\W_]+/g, '').toLowerCase();
  return words.length < 4 || COMMON_WORDS.has(words);
}

/**
 * 後備定位：在新內容中找書籤原本那一行。
 * 1. 內容完全相同的行，依前後文吻合度、離預期位置的距離挑一個
 * 2. 同一個函式內相同偏移的位置，內容相似度 ≥ 0.6
 * 3. 預期位置上下 30 行內內容相似（≥ 0.75 且至少一行前後文吻合、≥ 0.5 且至少兩行前後文吻合，
 *    或內容夠長且 ≥ 0.9）
 * 都找不到回傳 undefined。
 * `allowed`：限定候選行（有差異資料時只考慮新增或修改過的行，沒動過的行原本就是別的行）。
 */
export function relocate(
  lines: string[],
  anchor: BookmarkAnchor,
  expected: number,
  symbolStartLine?: number,
  allowed: (i: number) => boolean = () => true,
): number | undefined {
  const text = anchor.text;
  if (text) {
    let best: number | undefined;
    let bestScore = -Infinity;
    for (let i = 0; i < lines.length; i++) {
      if (!allowed(i) || lines[i].trim() !== text) {
        continue;
      }
      const ctx = contextScore(lines, i, anchor);
      if (isTrivial(text) && ctx < 2) {
        continue;
      }
      const score = ctx * 1000 - Math.abs(i - expected);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best !== undefined) {
      return best;
    }
  }
  if (symbolStartLine !== undefined && anchor.symbolOffset !== undefined) {
    const j = symbolStartLine + anchor.symbolOffset;
    if (j >= 0 && j < lines.length && allowed(j) && similarity(lines[j], text) >= 0.6) {
      return j;
    }
  }
  if (text && !isTrivial(text)) {
    let best: number | undefined;
    let bestScore = 0;
    for (let i = Math.max(0, expected - 30); i <= Math.min(lines.length - 1, expected + 30); i++) {
      if (!allowed(i)) {
        continue;
      }
      const sim = similarity(lines[i], text);
      const ctx = contextScore(lines, i, anchor);
      if (!((sim >= 0.75 && ctx >= 1) || (sim >= 0.5 && ctx >= 2) || (sim >= 0.9 && text.length >= 20))) {
        continue;
      }
      const score = sim * 10 + ctx - Math.abs(i - expected) / 100;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }
  return undefined;
}

export interface RelocateResult {
  id: string;
  line: number;
  status?: 'lost';
}

/**
 * 依新內容重新定位一個檔案的行號書籤。
 * - `oldHashes`：上次記住的內容（行雜湊）；沒有時只能用 anchor 檢查與後備定位
 * - `symbolStart`：依函式名稱路徑查目前的函式開頭行（給函式相對定位用）
 * 書籤所在的行落在合併衝突範圍內時標成需確認（lost）。
 */
export function relocateBookmarks(
  bookmarks: Pick<LineBookmark, 'id' | 'line' | 'anchor' | 'status'>[],
  oldHashes: number[] | undefined,
  newLines: string[],
  symbolStart?: (path: string) => number | undefined,
): RelocateResult[] {
  const hunks = oldHashes ? diffLines(oldHashes, newLines.map(hashLine)) : [];
  let allowed: ((i: number) => boolean) | undefined;
  if (oldHashes) {
    const fresh = new Uint8Array(newLines.length);
    for (const h of hunks) {
      fresh.fill(1, h.newStart, h.newEnd);
    }
    allowed = (i) => fresh[i] === 1;
  }
  const conflicts = conflictRegions(newLines);
  const last = Math.max(0, newLines.length - 1);
  return bookmarks.map((b) => {
    let line = b.line;
    let changed = false;
    if (oldHashes) {
      const r = mapLine(b.line, hunks);
      line = r.line;
      changed = r.changed;
    }
    line = Math.min(Math.max(0, line), last);
    const a = b.anchor;
    let ok = !changed && (!a || newLines[line]?.trim() === a.text);
    if (!ok && a) {
      const sym = a.symbolPath !== undefined ? symbolStart?.(a.symbolPath) : undefined;
      const found = relocate(newLines, a, line, sym, allowed);
      if (found !== undefined) {
        line = found;
        ok = true;
      }
    }
    if (ok && conflicts.some(([s, e]) => line >= s && line <= e)) {
      ok = false;
    }
    return ok ? { id: b.id, line } : { id: b.id, line, status: 'lost' as const };
  });
}

export interface BranchRelocateResult {
  id: string;
  line: number;
  status?: 'lost' | 'notOnBranch';
  /** 有變更時才有：離開分支時記下的位置。 */
  positions?: Record<string, BranchPosition>;
}

export interface BranchRelocateInput {
  /** `hidden`：只屬於別的分支、在目前分支隱藏的書籤，只記位置不換算。 */
  bookmarks: (Pick<LineBookmark, 'id' | 'line' | 'anchor' | 'status' | 'positions'> & { hidden?: boolean })[];
  /** 上次記住的內容（屬於 `prevBranch`，或沒切換分支時就是目前分支）。 */
  oldHashes: number[];
  newLines: string[];
  /** 這次內容變動是不是因為切換了分支。 */
  switched: boolean;
  /** 離開的分支名稱（detached HEAD 時為 undefined，不記錄位置）。 */
  prevBranch?: string;
  /** 目前的分支名稱。 */
  curBranch?: string;
  /** 上次離開 `curBranch` 時記住的內容。 */
  curSnapshot?: number[];
  symbolStart?: (path: string) => number | undefined;
}

/**
 * 依新內容重新定位書籤，並處理切換分支：
 * - 離開的分支：記下每個書籤在那裡的位置（positions），切回去時用那時的內容換算，來回切換不會累積誤差
 * - 回到之前去過的分支：從記住的位置與內容換算；沒去過：從上一個分支的內容換算
 * - 切換分支後找不到：不在此分支（notOnBranch），保留原本的 anchor，切回去自動恢復
 */
export function relocateOnBranch(input: BranchRelocateInput): BranchRelocateResult[] {
  const { switched, prevBranch, curBranch, curSnapshot } = input;
  const save = (b: BranchRelocateInput['bookmarks'][number]): Record<string, BranchPosition> | undefined => {
    if (!switched || !prevBranch) {
      return undefined;
    }
    const pos: BranchPosition = { line: b.line };
    if (b.status === 'lost' || b.status === 'notOnBranch') {
      pos.status = b.status;
    }
    return { ...b.positions, [prevBranch]: pos };
  };
  const fromSnapshot = input.bookmarks.filter((b) => !b.hidden && switched && curBranch && curSnapshot && b.positions?.[curBranch]);
  const fromOld = input.bookmarks.filter((b) => !b.hidden && !fromSnapshot.includes(b));
  const found = new Map<string, RelocateResult>();
  for (const r of relocateBookmarks(
    fromSnapshot.map((b) => ({ ...b, line: b.positions![curBranch!].line })),
    curSnapshot,
    input.newLines,
    input.symbolStart,
  )) {
    found.set(r.id, r);
  }
  for (const r of relocateBookmarks(fromOld, input.oldHashes, input.newLines, input.symbolStart)) {
    found.set(r.id, r);
  }
  return input.bookmarks.map((b) => {
    const positions = save(b);
    const r = found.get(b.id);
    const out: BranchRelocateResult = r ? { id: b.id, line: r.line } : { id: b.id, line: b.line };
    if (!r) {
      // 隱藏的書籤：狀態不變
      if (b.status === 'lost' || b.status === 'notOnBranch') {
        out.status = b.status;
      }
    } else if (r.status === 'lost') {
      out.status = switched || b.status === 'notOnBranch' ? 'notOnBranch' : 'lost';
    }
    if (positions) {
      out.positions = positions;
    }
    return out;
  });
}
