import { DetectedSymbol } from '../detection/types';

/** `{% include "x.html#card" %}` → `{ file: 'x.html', partial: 'card' }` */
export function splitTemplateTarget(target: string): { file: string; partial?: string } {
  const i = target.indexOf('#');
  if (i === -1) {
    return { file: target };
  }
  return { file: target.slice(0, i), partial: target.slice(i + 1) || undefined };
}

/** 找出 `{% extends %}` 的目標（只看最外層第一個）。 */
export function extendsTarget(symbols: DetectedSymbol[]): string | undefined {
  return symbols.find((s) => s.ruleId === 'dj-extends')?.target;
}

/** 收集所有 block（含巢狀），以 block 名稱為鍵；Django 規定同一 template 內 block 名稱唯一。 */
export function collectBlocks(symbols: DetectedSymbol[], out = new Map<string, DetectedSymbol>()): Map<string, DetectedSymbol> {
  for (const s of symbols) {
    if (s.kind === 'block' && s.ruleId === 'dj-block' && !out.has(s.name)) {
      out.set(s.name, s);
    }
    collectBlocks(s.children, out);
  }
  return out;
}

export function findPartial(symbols: DetectedSymbol[], name: string): DetectedSymbol | undefined {
  for (const s of symbols) {
    if (s.kind === 'partial' && s.name === name) {
      return s;
    }
    const hit = findPartial(s.children, name);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/**
 * 多個候選 template 時，挑路徑和目前檔案最接近的（同一個 app 優先）。
 * 參數都是以 / 分隔的相對路徑。
 */
export function pickClosest(fromRel: string, candidates: string[]): string | undefined {
  if (candidates.length <= 1) {
    return candidates[0];
  }
  const from = fromRel.split('/');
  const score = (c: string) => {
    const parts = c.split('/');
    let n = 0;
    while (n < from.length && n < parts.length && from[n] === parts[n]) {
      n++;
    }
    return n;
  };
  return [...candidates].sort((a, b) => score(b) - score(a) || a.length - b.length || a.localeCompare(b))[0];
}

export interface AncestorBlock<T> {
  /** 定義這個 block 的祖先 template。 */
  template: T;
  symbol: DetectedSymbol;
}

/**
 * 沿著 extends 鏈往上找，回傳每個 block 名稱最近的祖先定義。
 * `load` 負責把 extends 目標解析成 template 並偵測其符號；最多往上 `maxDepth` 層，並避免循環。
 */
export async function findOverrides<T>(
  symbols: DetectedSymbol[],
  load: (target: string, from: T | undefined) => Promise<{ template: T; key: string; symbols: DetectedSymbol[] } | undefined>,
  selfKey?: string,
  maxDepth = 6,
): Promise<Map<string, AncestorBlock<T>>> {
  const result = new Map<string, AncestorBlock<T>>();
  const wanted = new Set(collectBlocks(symbols).keys());
  const visited = new Set<string>(selfKey ? [selfKey] : []);
  let target = extendsTarget(symbols);
  let from: T | undefined;
  for (let depth = 0; target && depth < maxDepth && wanted.size > 0; depth++) {
    const parent = await load(target, from);
    if (!parent || visited.has(parent.key)) {
      break;
    }
    visited.add(parent.key);
    for (const [name, sym] of collectBlocks(parent.symbols)) {
      if (wanted.has(name)) {
        result.set(name, { template: parent.template, symbol: sym });
        wanted.delete(name);
      }
    }
    target = extendsTarget(parent.symbols);
    from = parent.template;
  }
  return result;
}
