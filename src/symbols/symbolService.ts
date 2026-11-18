import * as vscode from 'vscode';
import { uriKey } from '../util/uris';
import { readSettings, ruleApplies } from '../config';
import { detectSymbols } from '../detection/engine';
import { DetectedSymbol, RuleError, SymbolKindName } from '../detection/types';
import { fromDocument, loadSource, SourceDoc } from './documentSource';

export interface FileSymbols {
  uri: vscode.Uri;
  version: string;
  languageId: string;
  symbols: DetectedSymbol[];
  /** 實際使用的來源，給介面顯示用。 */
  source: 'rules' | 'languageServer' | 'both' | 'none';
  errors: RuleError[];
}

const LSP_KIND: Partial<Record<vscode.SymbolKind, SymbolKindName>> = {
  [vscode.SymbolKind.Function]: 'function',
  [vscode.SymbolKind.Method]: 'method',
  [vscode.SymbolKind.Constructor]: 'method',
  [vscode.SymbolKind.Class]: 'class',
};

const MAX_CACHE = 2000;

/**
 * 依設定決定用規則或語言伺服器取得函式，並以文件版本快取結果。
 */
export class SymbolService {
  private cache = new Map<string, FileSymbols>();

  getSymbols(document: vscode.TextDocument): Promise<FileSymbols> {
    return this.getForSource(fromDocument(document));
  }

  /** 不必開啟檔案：已開啟就用編輯中的內容，否則讀磁碟。 */
  async getForUri(uri: vscode.Uri): Promise<FileSymbols | undefined> {
    const src = await loadSource(uri);
    return src ? this.getForSource(src) : undefined;
  }

  async getForSource(src: SourceDoc): Promise<FileSymbols> {
    const key = uriKey(src.uri);
    const cached = this.cache.get(key);
    if (cached && cached.version === src.version && cached.languageId === src.languageId) {
      return cached;
    }
    const result = await this.compute(src);
    if (this.cache.size > MAX_CACHE) {
      this.cache.clear();
    }
    this.cache.set(key, result);
    return result;
  }

  invalidate(uri?: vscode.Uri): void {
    if (uri) {
      this.cache.delete(uriKey(uri));
    } else {
      this.cache.clear();
    }
  }

  private async compute(src: SourceDoc): Promise<FileSymbols> {
    const settings = readSettings(src.uri);
    const applicable = settings.rules.filter(
      (r) => r.enabled !== false && r.languages.includes(src.languageId) && ruleApplies(r, src.uri),
    );
    const base = { uri: src.uri, version: src.version, languageId: src.languageId };
    const lsp = async () => {
      const doc = src.document ?? (await vscode.workspace.openTextDocument(src.uri).then(undefined, () => undefined));
      return doc ? fromLanguageServer(doc) : [];
    };

    if (settings.source === 'languageServer' || (settings.source === 'rules' && applicable.length === 0)) {
      const symbols = await lsp();
      return { ...base, symbols, source: symbols.length ? 'languageServer' : 'none', errors: [] };
    }
    const r = detectSymbols(src.text, src.languageId, settings.rules, {
      isApplicable: (rule) => ruleApplies(rule, src.uri),
    });
    if (settings.source === 'both') {
      return { ...base, symbols: mergeByLine(r.symbols, await lsp()), source: 'both', errors: r.errors };
    }
    return { ...base, symbols: r.symbols, source: 'rules', errors: r.errors };
  }
}

async function fromLanguageServer(document: vscode.TextDocument): Promise<DetectedSymbol[]> {
  let raw: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
  try {
    raw = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    );
  } catch {
    return [];
  }
  if (!raw || raw.length === 0) {
    return [];
  }
  if ('children' in raw[0]) {
    return convertDocumentSymbols(raw as vscode.DocumentSymbol[], document, '');
  }
  return (raw as vscode.SymbolInformation[]).flatMap((s) => {
    const kind = LSP_KIND[s.kind];
    if (!kind) {
      return [];
    }
    return [toDetected(s.name, kind, s.location.range, s.location.range, document, s.name, [])];
  });
}

function convertDocumentSymbols(
  symbols: vscode.DocumentSymbol[],
  document: vscode.TextDocument,
  parentPath: string,
): DetectedSymbol[] {
  const out: DetectedSymbol[] = [];
  for (const s of [...symbols].sort((a, b) => a.range.start.compareTo(b.range.start))) {
    const kind = LSP_KIND[s.kind];
    if (!kind) {
      // 不認得的節點（例如變數、模組）略過，但保留裡面的函式
      out.push(...convertDocumentSymbols(s.children, document, parentPath));
      continue;
    }
    const path = parentPath ? `${parentPath}.${s.name}` : s.name;
    out.push(
      toDetected(s.name, kind, s.range, s.selectionRange, document, path, convertDocumentSymbols(s.children, document, path)),
    );
  }
  return out;
}

function toDetected(
  name: string,
  kind: SymbolKindName,
  range: vscode.Range,
  selection: vscode.Range,
  document: vscode.TextDocument,
  path: string,
  children: DetectedSymbol[],
): DetectedSymbol {
  return {
    name,
    kind,
    ruleId: 'languageServer',
    startLine: range.start.line,
    endLine: range.end.line,
    nameLine: selection.start.line,
    nameStartCol: selection.start.character,
    nameEndCol: selection.start.line === selection.end.line ? selection.end.character : selection.start.character,
    startOffset: document.offsetAt(range.start),
    endOffset: document.offsetAt(range.end),
    path,
    children,
  };
}

/** `both` 模式：以規則結果為主，語言伺服器多抓到的（不同名稱行）補在同層。 */
function mergeByLine(primary: DetectedSymbol[], extra: DetectedSymbol[]): DetectedSymbol[] {
  const seen = new Set<string>();
  const walk = (list: DetectedSymbol[]) => {
    for (const s of list) {
      seen.add(`${s.nameLine}:${s.name}`);
      walk(s.children);
    }
  };
  walk(primary);
  const flatten = (list: DetectedSymbol[]): DetectedSymbol[] =>
    list.flatMap((s) => (seen.has(`${s.nameLine}:${s.name}`) ? flatten(s.children) : [{ ...s, children: flatten(s.children) }]));
  return [...primary, ...flatten(extra)].sort((a, b) => a.startOffset - b.startOffset);
}
