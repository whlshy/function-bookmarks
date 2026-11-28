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
  /** 標題層級（body: heading）。 */
  level?: number;
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
    if (rule.body !== 'embedded' && !rule.nameTemplate && !/\(\?<name>/.test(rule.pattern)) {
      errors.push({ ruleId: rule.id, message: 'pattern must contain a (?<name>...) group or set nameTemplate' });
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

/**
 * 大括號語言：從比對結束處往後找函式本體。
 * `optionalBody`（Kotlin、Swift）：本體可以省略（data class X(…)、protocol 裡的 func a()），
 * 也可以是 `= 運算式`；標頭那一行結束、下一行又不是 { 或 : 開頭時就結束。
 */
function findBraceEnd(masked: string, from: number, optionalBody = false): number {
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
    if (c === '}') {
      // 外層的範圍先結束了：這個符號沒有本體
      return i;
    }
    if (c === '=' && masked[i + 1] === '>') {
      afterArrow = true;
      i++;
      continue;
    }
    if (optionalBody && c === '=' && masked[i + 1] !== '=' && !'=!<>'.includes(masked[i - 1] ?? '')) {
      // Kotlin 的 fun x() = 運算式
      afterArrow = true;
      continue;
    }
    if (c === '\n') {
      if (exprStarted) {
        return i;
      }
      if (optionalBody && !afterArrow) {
        const rest = masked.slice(i + 1, i + 200).trimStart();
        if (!rest.startsWith('{') && !rest.startsWith(':') && !/^where\b/.test(rest)) {
          return i;
        }
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

/** 函式呼叫：規則比對到左括號為止，內容一直到對應的右括號（含裡面的回呼函式）。 */
function findCallEnd(masked: string, from: number): number {
  let depth = 1;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return masked.length;
}

/** 依 nameTemplate 組出名稱；`${g}`、`${g:upper}`、`${g|預設}`、`${g:upper|預設}`。 */
export function renderNameTemplate(template: string, groups: Record<string, string | undefined>): string {
  return template
    .replace(/\$\{(\w+)(:upper)?(?:\|([^}]*))?\}/g, (_m, g: string, upper: string | undefined, def: string | undefined) => {
      const v = groups[g]?.trim();
      const value = v ? v : (def ?? '');
      return upper ? value.toUpperCase() : value;
    })
    .replace(/\s+/g, ' ')
    .trim();
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

/**
 * 以 `end` 結尾的語言（Ruby）：找到縮排與開頭那一行相同（或更外層）的 `end`。
 * 同一行就結束的寫法（`def x; 1; end`、`def x = 1`）只算那一行。
 */
/** 不算區塊開頭的 BEGIN：交易（BEGIN TRANSACTION、BEGIN WORK…）。 */
const SQL_BEGIN_NOT_BLOCK = /^[ \t]+(?:TRAN|TRANSACTION|WORK|DISTRIBUTED|DEFERRED|IMMEDIATE|EXCLUSIVE)\b|^[ \t]*;/i;

/**
 * SQL 敘述的結尾（body: statement）：
 * - BEGIN／CASE … END 配對之外的第一個 ;（用了 MySQL 的 DELIMITER 時是當時的分隔字串）
 * - 檔案用單獨一行的 GO（SQL Server）或 /（Oracle）分隔時，到那一行之前；
 *   以 GO 分隔但下一個 CREATE VIEW／PROCEDURE…前漏寫了 GO 時，到上一個分號（沒有就到那一行之前）
 * - Oracle（以 / 分隔）的預存程序、套件：宣告區與內層程序都有 ;，只以 / 為準
 * 都找不到時到檔案結尾。
 */
function findStatementEnd(masked: string, matchStart: number, matchEnd: number): number {
  let delim = ';';
  for (const m of masked.slice(0, matchStart).matchAll(/^[ \t]*DELIMITER[ \t]+(\S+)/gim)) {
    delim = m[1];
  }
  const goSep = delim === ';' && /^[ \t]*GO[ \t]*;?[ \t]*\r?$/im.test(masked);
  const slashSep = delim === ';' && /^[ \t]*\/[ \t]*\r?$/m.test(masked);
  const routine = /\b(?:FUNCTION|PROCEDURE|PROC|TRIGGER|PACKAGE)\b/i.test(masked.slice(matchStart, matchEnd));
  const escaped = delim.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const re = new RegExp(
    String.raw`\b(BEGIN|CASE|END)\b(?:[ \t]+(IF|LOOP|WHILE|REPEAT|FOR|CASE)\b)?|^([ \t]*GO[ \t]*;?[ \t]*)\r?$|^([ \t]*\/[ \t]*)\r?$|(${escaped})|` +
      String.raw`^[ \t]*((?:CREATE|ALTER)(?:[ \t]+OR[ \t]+(?:ALTER|REPLACE))?[ \t]+(?:VIEW|PROC|PROCEDURE|FUNCTION|TRIGGER)\b)`,
    'gim',
  );
  re.lastIndex = matchEnd;
  let depth = 0;
  /** 以 GO 分隔的檔案裡，最外層最後一個分號的結尾（下一個 CREATE 前漏寫 GO 時用）。 */
  let lastDelimEnd: number | undefined;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const word = m[1]?.toUpperCase();
    if (word === 'BEGIN') {
      if (!SQL_BEGIN_NOT_BLOCK.test(masked.slice(m.index + 5, m.index + 30))) {
        depth++;
      }
    } else if (word === 'CASE') {
      depth++;
    } else if (word === 'END') {
      const suffix = m[2]?.toUpperCase();
      if (!suffix || suffix === 'CASE') {
        depth = Math.max(0, depth - 1);
      }
    } else if (m[3] !== undefined) {
      if (goSep) {
        return m.index;
      }
    } else if (m[4] !== undefined) {
      if (slashSep) {
        return m.index;
      }
    } else if (m[5] !== undefined) {
      if (goSep && depth === 0) {
        lastDelimEnd = m.index + m[5].length;
      }
      if (goSep || depth > 0 || (slashSep && routine)) {
        continue;
      }
      return m.index + m[5].length;
    } else if (m[6] !== undefined) {
      // 以 GO 分隔的檔案裡，下一個 CREATE VIEW／PROCEDURE…（最外層）前漏寫了 GO：
      // 到上一個分號為止（沒有分號就到那一行之前），不要一路延伸到後面的 GO
      if (goSep && depth === 0) {
        return lastDelimEnd ?? m.index;
      }
    }
  }
  return masked.length;
}

function findEndKeywordEnd(masked: string, matchStart: number, from: number): number {
  const headerEnd = lineEndOffset(masked, from);
  const rest = masked.slice(from, headerEnd);
  if (/(?:^|[;\s])end\b/.test(rest) || /^(?:\([^)]*\))?[ \t]*=[^=~>]/.test(rest)) {
    return headerEnd;
  }
  const lineStart = masked.lastIndexOf('\n', matchStart) + 1;
  const base = indentWidth(masked.slice(lineStart, lineEndOffset(masked, lineStart)));
  let pos = headerEnd + 1;
  let last = headerEnd;
  while (pos <= masked.length - 1) {
    const le = lineEndOffset(masked, pos);
    const line = masked.slice(pos, le);
    if (line.trim() !== '') {
      const w = indentWidth(line);
      if (w <= base) {
        // 只有同一層縮排的 end 才是自己的結尾；更外層的 end 屬於外面的區塊（Elixir 的 `def x, do: 1` 後面接模組的 end）
        return w === base && /^\s*end\b/.test(line) ? le : last;
      }
      last = le;
    }
    pos = le + 1;
  }
  return last;
}

/** 某一行開頭的縮排寬度。 */
function indentAt(masked: string, lineStart: number): number {
  return indentWidth(masked.slice(lineStart, lineEndOffset(masked, lineStart)));
}

/**
 * 從 `pos`（某行開頭）往下，納入縮排比 `base` 深的各行（空行可以夾在中間），回傳最後一行的行尾；
 * 一行都沒有時回傳 `fallback`。
 */
function deeperLinesEnd(masked: string, pos: number, base: number, fallback: number): number {
  let end = fallback;
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

/** 開頭那一行加上後面縮排較深的各行（Haskell 的等式、data、class … where）。 */
function findIndentBlockEnd(masked: string, matchStart: number): number {
  const lineStart = masked.lastIndexOf('\n', matchStart) + 1;
  const headerEnd = lineEndOffset(masked, matchStart);
  return deeperLinesEnd(masked, headerEnd + 1, indentAt(masked, lineStart), headerEnd);
}

/**
 * Scala：標頭（括號外）先遇到 { 就配對大括號；換行時下一行若是 extends、with、derives、{ 或 = 開頭，標頭還沒結束。
 * 否則下一行縮排較深就到那段縮排結束（Scala 3 的 `:`、`=` 後換行縮排；同縮排的 `end xxx` 也算進來），
 * 再不然只算標頭那一行（`def f = 1`、抽象的 `def f: Int`）。
 */
function findBraceOrIndentEnd(masked: string, matchStart: number, from: number): number {
  const lineStart = masked.lastIndexOf('\n', matchStart) + 1;
  const base = indentAt(masked, lineStart);
  let depth = 0;
  const limit = Math.min(masked.length, from + MAX_HEADER_SCAN);
  for (let i = from; i < limit; i++) {
    const c = masked[i];
    if (c === '(' || c === '[') {
      depth++;
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
    if (c === ';' || c === '}') {
      return i;
    }
    if (c !== '\n') {
      continue;
    }
    // 下一個非空白行
    let pos = i + 1;
    while (pos < masked.length && masked.slice(pos, lineEndOffset(masked, pos)).trim() === '') {
      pos = lineEndOffset(masked, pos) + 1;
    }
    if (pos >= masked.length) {
      return i;
    }
    const next = masked.slice(pos, lineEndOffset(masked, pos));
    if (/^\s*(?:extends\b|with\b|derives\b|\{|=(?![=>]))/.test(next)) {
      i = pos - 1;
      continue;
    }
    if (indentWidth(next) <= base) {
      return i;
    }
    let end = deeperLinesEnd(masked, pos, base, i);
    // Scala 3 的結尾標記：同一層縮排的 `end xxx`
    let after = end + 1;
    while (after < masked.length && masked.slice(after, lineEndOffset(masked, after)).trim() === '') {
      after = lineEndOffset(masked, after) + 1;
    }
    if (after < masked.length) {
      const line = masked.slice(after, lineEndOffset(masked, after));
      if (indentWidth(line) === base && /^\s*end\b/.test(line)) {
        end = lineEndOffset(masked, after);
      }
    }
    return end;
  }
  return lineEndOffset(masked, from);
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
    const subject = c.rule.matchRaw ? text : masked;
    for (const m of subject.matchAll(c.start)) {
      const groups = m.indices?.groups;
      const matchStart = m.index! + leadingWhitespace(m[0]);
      const matchEnd = m.index! + m[0].length;
      if (c.rule.matchRaw && masked[matchStart] !== text[matchStart]) {
        continue; // 起點在註解或字串裡
      }
      let nameIdx = groups?.name;
      let name = m.groups?.name;
      if (c.rule.nameTemplate) {
        name = renderNameTemplate(c.rule.nameTemplate, m.groups ?? {});
        if (!nameIdx) {
          // 沒有 name 群組時，以比對起點到該行結尾（最多 80 字）當作名稱位置
          const lineEnd = lineEndOffset(subject, matchStart);
          nameIdx = [matchStart, Math.min(lineEnd, matchStart + 80, matchEnd)];
        }
      }
      if (!nameIdx || !name) {
        continue;
      }
      let endOffset: number;
      switch (c.rule.body) {
        case 'brace':
          endOffset = findBraceEnd(masked, matchEnd, c.rule.optionalBody === true);
          break;
        case 'indent':
          endOffset = findIndentEnd(masked, matchStart, matchEnd);
          break;
        case 'pair':
          endOffset = findPairEnd(masked, c, matchEnd);
          break;
        case 'end':
          endOffset = findEndKeywordEnd(masked, matchStart, matchEnd);
          break;
        case 'statement':
          endOffset = findStatementEnd(masked, matchStart, matchEnd);
          break;
        case 'indentBlock':
          endOffset = findIndentBlockEnd(masked, matchStart);
          break;
        case 'braceOrIndent':
          endOffset = findBraceOrIndentEnd(masked, matchStart, matchEnd);
          break;
        case 'call':
          endOffset = findCallEnd(masked, matchEnd);
          break;
        case 'heading':
          endOffset = lineEndOffset(masked, matchEnd); // 之後由 fixHeadingEnds 補上
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
        level: c.rule.body === 'heading' ? headingLevel(m.groups ?? {}) : undefined,
        children: [],
      });
    }
  }
  return out;
}

function headingLevel(groups: Record<string, string | undefined>): number {
  if (groups.level) {
    return groups.level.length;
  }
  if (groups.under) {
    return groups.under.trim().startsWith('=') ? 1 : 2;
  }
  return 1;
}

/** 標題的範圍：到下一個同層或更上層標題之前（沒有的話到檔案結尾）。 */
function fixHeadingEnds(raw: RawSymbol[], text: string): void {
  const headings = raw.filter((s) => s.level !== undefined).sort((a, b) => a.startOffset - b.startOffset);
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const next = headings.slice(i + 1).find((x) => x.level! <= h.level!);
    let end = text.length;
    if (next) {
      // 結束在下一個標題前的換行；CRLF 時連 \r 一起退回，否則會多算一行
      end = next.startOffset - 1;
      if (text[end - 1] === '\r') {
        end--;
      }
    }
    h.endOffset = Math.max(h.endOffset, end);
  }
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

/** 依 `hideChildren` 移除指定規則的子節點，孫節點往上接。 */
function applyHide(nodes: RawSymbol[], hidden: Set<string> | undefined): RawSymbol[] {
  const out: RawSymbol[] = [];
  for (const n of nodes) {
    if (hidden?.has(n.rule.id)) {
      out.push(...applyHide(n.children, hidden));
      continue;
    }
    const own = n.rule.hideChildren?.length ? new Set(n.rule.hideChildren) : undefined;
    n.children = applyHide(n.children, own);
    out.push(n);
  }
  return out;
}

/** `mergeClauses`：同一層緊鄰、名稱與種類相同的符號合併成一個（範圍延伸到最後一段，子節點接在一起）。 */
function mergeClauses(nodes: RawSymbol[]): RawSymbol[] {
  const out: RawSymbol[] = [];
  for (const n of nodes) {
    n.children = mergeClauses(n.children);
    const prev = out[out.length - 1];
    if (prev && prev.rule.mergeClauses && n.rule.mergeClauses && prev.name === n.name && prev.rule.kind === n.rule.kind) {
      prev.endOffset = Math.max(prev.endOffset, n.endOffset);
      prev.children.push(...n.children);
      continue;
    }
    out.push(n);
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
  fixHeadingEnds(raw, text);
  const tree = mergeClauses(applyHide(dedupe(applyWithin(nest(raw), undefined), new Set()), undefined));
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

/** 依行號找出所有包住該行的符號，由最內層往外層排列。 */
export function findEnclosing(symbols: DetectedSymbol[], line: number): DetectedSymbol[] {
  for (const s of symbols) {
    if (line >= s.startLine && line <= s.endLine) {
      return [...findEnclosing(s.children, line), s];
    }
  }
  return [];
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
