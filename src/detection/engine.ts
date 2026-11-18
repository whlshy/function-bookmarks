import { maskText, syntaxForLanguage } from './mask';
import { DetectedSymbol, DetectionResult, DetectionRule, RuleError } from './types';

/** 找內容範圍時最多往後掃描的字元數，避免規則寫錯時整份檔案被當成一個函式。 */
const MAX_HEADER_SCAN = 4000;

export interface DetectOptions {
  /** 由呼叫端判斷規則是否適用目前檔案（例如 include glob）。 */
  isApplicable?: (rule: DetectionRule) => boolean;
}

interface Compiled {
  rule: DetectionRule;
  start: RegExp;
  end?: RegExp;
}

interface RawSymbol {
  name: string;
  rule: DetectionRule;
  startOffset: number;
  endOffset: number;
  nameOffset: number;
  nameLength: number;
  target?: string;
  children: RawSymbol[];
}

const regexCache = new Map<string, RegExp | Error>();

function compile(source: string, flags: string): RegExp | Error {
  const key = `${flags}/${source}`;
  let re = regexCache.get(key);
  if (!re) {
    try {
      re = new RegExp(source, flags);
    } catch (e) {
      re = e instanceof Error ? e : new Error(String(e));
    }
    regexCache.set(key, re);
  }
  return re;
}

function buildFlags(rule: DetectionRule): string {
  const set = new Set(('gmd' + (rule.flags ?? '')).split(''));
  set.delete('y');
  return [...set].join('');
}

function compileRules(rules: DetectionRule[], errors: RuleError[]): Compiled[] {
  const out: Compiled[] = [];
  for (const rule of rules) {
    const flags = buildFlags(rule);
    const start = compile(rule.pattern, flags);
    if (start instanceof Error) {
      errors.push({ ruleId: rule.id, message: `pattern: ${start.message}` });
      continue;
    }
    if (rule.body !== 'embedded' && !/\(\?<name>/.test(rule.pattern)) {
      errors.push({ ruleId: rule.id, message: 'pattern must contain a (?<name>...) group' });
      continue;
    }
    let end: RegExp | undefined;
    if (rule.body === 'pair' || rule.body === 'embedded') {
      if (!rule.end) {
        errors.push({ ruleId: rule.id, message: `body "${rule.body}" requires "end"` });
        continue;
      }
      const e = compile(rule.end, flags);
      if (e instanceof Error) {
        errors.push({ ruleId: rule.id, message: `end: ${e.message}` });
        continue;
      }
      end = e;
    }
    if (rule.body === 'embedded' && !rule.embeddedLanguage) {
      errors.push({ ruleId: rule.id, message: 'body "embedded" requires "embeddedLanguage"' });
      continue;
    }
    out.push({ rule, start, end });
  }
  return out;
}

function lineEndOffset(text: string, offset: number): number {
  const i = text.indexOf('\n', offset);
  return i === -1 ? text.length : i;
}

function matchBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return masked.length;
}

/** 大括號語言：從比對結束處往後找函式本體。 */
function findBraceEnd(masked: string, from: number): number {
  let depth = 0;
  // 規則本身已經比對到 `=>` 時，後面接的是函式本體或運算式
  let afterArrow = masked.slice(Math.max(0, from - 2), from) === '=>';
  let exprStarted = false;
  const limit = Math.min(masked.length, from + MAX_HEADER_SCAN);
  for (let i = from; i < limit; i++) {
    const c = masked[i];
    if (c === '(' || c === '[') {
      depth++;
      if (afterArrow) {
        exprStarted = true;
      }
      continue;
    }
    if (c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) {
      continue;
    }
    if (c === '{') {
      return matchBrace(masked, i);
    }
    if (c === ';') {
      return i + 1;
    }
    if (c === '=' && masked[i + 1] === '>') {
      afterArrow = true;
      i++;
      continue;
    }
    if (c === '\n') {
      if (exprStarted) {
        return i;
      }
      continue;
    }
    if (afterArrow && c !== ' ' && c !== '\t' && c !== '\r') {
      exprStarted = true;
    }
  }
  return lineEndOffset(masked, from);
}

function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') {
      w++;
    } else if (ch === '\t') {
      w += 8 - (w % 8);
    } else {
      break;
    }
  }
  return w;
}

/** 縮排語言（Python）：找到冒號後，縮排回到同層或更外層為止。 */
function findIndentEnd(masked: string, matchStart: number, from: number): number {
  let depth = 0;
  let colon = -1;
  const limit = Math.min(masked.length, from + MAX_HEADER_SCAN);
  for (let i = from; i < limit; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
    } else if (c === ':' && depth === 0) {
      colon = i;
      break;
    }
  }
  if (colon === -1) {
    return lineEndOffset(masked, from);
  }
  const headerLineEnd = lineEndOffset(masked, colon);
  if (masked.slice(colon + 1, headerLineEnd).trim() !== '') {
    return headerLineEnd; // 單行寫法：def f(): return 1
  }
  const lineStart = masked.lastIndexOf('\n', matchStart) + 1;
  const base = indentWidth(masked.slice(lineStart, lineEndOffset(masked, lineStart)));
  let end = headerLineEnd;
  let pos = headerLineEnd + 1;
  while (pos <= masked.length - 1) {
    const le = lineEndOffset(masked, pos);
    const line = masked.slice(pos, le);
    if (line.trim() !== '') {
      if (indentWidth(line) <= base) {
        break;
      }
      end = le;
    }
    pos = le + 1;
  }
  return end;
}

/** 成對標籤：計算巢狀層數，找到對應的結束標籤。 */
function findPairEnd(masked: string, c: Compiled, from: number): number {
  const startRe = new RegExp(c.start.source, c.start.flags);
  const endRe = new RegExp(c.end!.source, c.end!.flags);
  let depth = 1;
  let pos = from;
  while (pos <= masked.length) {
    startRe.lastIndex = pos;
    endRe.lastIndex = pos;
    const s = startRe.exec(masked);
    const e = endRe.exec(masked);
    if (!e) {
      return lineEndOffset(masked, from);
    }
    if (s && s.index < e.index) {
      depth++;
      pos = s.index + Math.max(1, s[0].length);
      continue;
    }
    depth--;
    const after = e.index + Math.max(1, e[0].length);
    if (depth === 0) {
      return after;
    }
    pos = after;
  }
  return lineEndOffset(masked, from);
}

function leadingWhitespace(s: string): number {
  const m = /^\s*/.exec(s);
  return m ? m[0].length : 0;
}

function collect(
  text: string,
  masked: string,
  offset: number,
  languageId: string,
  allRules: DetectionRule[],
  options: DetectOptions,
  errors: RuleError[],
  depth: number,
): RawSymbol[] {
  const rules = allRules.filter(
    (r) => r.enabled !== false && r.languages.includes(languageId) && (options.isApplicable?.(r) ?? true),
  );
  const compiled = compileRules(rules, errors);
  const out: RawSymbol[] = [];

  // 先處理內嵌區域（例如 <script>）：區域內改用該語言的遮蔽方式，
  // 外層規則才不會抓到 JS 註解或字串裡的 {% block %}
  for (const c of compiled.filter((x) => x.rule.body === 'embedded')) {
    if (depth > 2) {
      break;
    }
    const lang = c.rule.embeddedLanguage!;
    for (const m of [...masked.matchAll(c.start)]) {
      const regionStart = m.index! + m[0].length;
      const endRe = new RegExp(c.end!.source, c.end!.flags);
      endRe.lastIndex = regionStart;
      const e = endRe.exec(masked);
      const regionEnd = e ? e.index : masked.length;
      const regionText = text.slice(regionStart, regionEnd);
      const regionMasked = maskText(regionText, syntaxForLanguage(lang));
      masked = masked.slice(0, regionStart) + regionMasked + masked.slice(regionEnd);
      out.push(
        ...collect(regionText, regionMasked, offset + regionStart, lang, allRules, options, errors, depth + 1),
      );
    }
  }

  for (const c of compiled.filter((x) => x.rule.body !== 'embedded')) {
    c.start.lastIndex = 0;
    for (const m of masked.matchAll(c.start)) {
      const groups = m.indices?.groups;
      const matchStart = m.index! + leadingWhitespace(m[0]);
      const matchEnd = m.index! + m[0].length;
      const nameIdx = groups?.name;
      const name = m.groups?.name;
      if (!nameIdx || !name) {
        continue;
      }
      let endOffset: number;
      switch (c.rule.body) {
        case 'brace':
          endOffset = findBraceEnd(masked, matchEnd);
          break;
        case 'indent':
          endOffset = findIndentEnd(masked, matchStart, matchEnd);
          break;
        case 'pair':
          endOffset = findPairEnd(masked, c, matchEnd);
          break;
        default:
          endOffset = lineEndOffset(masked, matchEnd);
      }
      const targetIdx = groups?.target;
      out.push({
        name,
        rule: c.rule,
        startOffset: offset + matchStart,
        endOffset: offset + Math.max(endOffset, matchEnd),
        nameOffset: offset + nameIdx[0],
        nameLength: nameIdx[1] - nameIdx[0],
        target: targetIdx ? text.slice(targetIdx[0], targetIdx[1]) : undefined,
        children: [],
      });
    }
  }
  return out;
}

function nest(raw: RawSymbol[]): RawSymbol[] {
  // 排序是穩定的：起點、範圍都相同時，先出現的規則在外層
  const sorted = [...raw].sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const roots: RawSymbol[] = [];
  const stack: RawSymbol[] = [];
  for (const s of sorted) {
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (s.startOffset >= top.startOffset && s.endOffset <= top.endOffset && s !== top) {
        break;
      }
      stack.pop();
    }
    (stack.length ? stack[stack.length - 1].children : roots).push(s);
    stack.push(s);
  }
  return roots;
}

/** 移除不符合 `within` 條件的節點，並把它的子節點往上接。 */
function applyWithin(nodes: RawSymbol[], parentKind: string | undefined): RawSymbol[] {
  const out: RawSymbol[] = [];
  for (const n of nodes) {
    if (n.rule.within && (!parentKind || !n.rule.within.includes(parentKind as never))) {
      out.push(...applyWithin(n.children, parentKind));
    } else {
      n.children = applyWithin(n.children, n.rule.kind);
      out.push(n);
    }
  }
  return out;
}

/** 同一個名稱位置被多條規則抓到時，只留最外層（規則順序在前）的那個。 */
function dedupe(nodes: RawSymbol[], seen: Set<number>): RawSymbol[] {
  const out: RawSymbol[] = [];
  for (const n of nodes) {
    if (seen.has(n.nameOffset)) {
      out.push(...dedupe(n.children, seen));
      continue;
    }
    seen.add(n.nameOffset);
    n.children = dedupe(n.children, seen);
    out.push(n);
  }
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

function finalize(nodes: RawSymbol[], starts: number[], parentPath: string): DetectedSymbol[] {
  return nodes.map((n) => {
    const path = parentPath ? `${parentPath}.${n.name}` : n.name;
    const nameLine = lineOf(starts, n.nameOffset);
    return {
      name: n.name,
      kind: n.rule.kind,
      ruleId: n.rule.id,
      startLine: lineOf(starts, n.startOffset),
      endLine: lineOf(starts, Math.max(n.startOffset, n.endOffset - 1)),
      nameLine,
      nameStartCol: n.nameOffset - starts[nameLine],
      nameEndCol: n.nameOffset - starts[nameLine] + n.nameLength,
      startOffset: n.startOffset,
      endOffset: n.endOffset,
      target: n.target,
      path,
      children: finalize(n.children, starts, path),
    };
  });
}

export function detectSymbols(
  text: string,
  languageId: string,
  rules: DetectionRule[],
  options: DetectOptions = {},
): DetectionResult {
  const errors: RuleError[] = [];
  const masked = maskText(text, syntaxForLanguage(languageId));
  const raw = collect(text, masked, 0, languageId, rules, options, errors, 0);
  const tree = dedupe(applyWithin(nest(raw), undefined), new Set());
  const uniqueErrors = errors.filter(
    (e, i) => errors.findIndex((x) => x.ruleId === e.ruleId && x.message === e.message) === i,
  );
  return { symbols: finalize(tree, lineStarts(text), ''), errors: uniqueErrors };
}

/** 依行號找出最內層包住該行的符號。 */
export function findInnermost(symbols: DetectedSymbol[], line: number): DetectedSymbol | undefined {
  for (const s of symbols) {
    if (line >= s.startLine && line <= s.endLine) {
      return findInnermost(s.children, line) ?? s;
    }
  }
  return undefined;
}

/** 以名稱路徑找符號：先找路徑＋種類都相同的，找不到再只比路徑。 */
export function findByPath(symbols: DetectedSymbol[], path: string, kind?: string): DetectedSymbol | undefined {
  let loose: DetectedSymbol | undefined;
  const walk = (list: DetectedSymbol[]): DetectedSymbol | undefined => {
    for (const s of list) {
      if (s.path === path) {
        if (!kind || s.kind === kind) {
          return s;
        }
        loose = loose ?? s;
      }
      const hit = walk(s.children);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  };
  return walk(symbols) ?? loose;
}

/** 合併使用者規則：同 id 覆蓋內建規則，disabled 名單內的關閉。 */
export function mergeRules(
  builtin: DetectionRule[],
  user: DetectionRule[],
  disabled: string[],
): DetectionRule[] {
  const byId = new Map<string, DetectionRule>();
  for (const r of builtin) {
    byId.set(r.id, r);
  }
  for (const r of user) {
    byId.set(r.id, { ...byId.get(r.id), ...r });
  }
  const off = new Set(disabled);
  return [...byId.values()].map((r) => (off.has(r.id) ? { ...r, enabled: false } : r));
}
