/**
 * 共用核心：把書籤整理成匯出用的資料（JSON 項目、表格列、導讀文件段落）。
 * 不依賴編輯器：套件的「匯出書籤」與 CLI 的輸出共用同一套規則，結果才會一致。
 * 介面文字（欄位名稱、狀態文字）由呼叫端傳入，核心不處理翻譯。
 */
import { paletteColor } from '../bookmarks/decor';
import { LineBookmark, makeAnchor } from '../bookmarks/model';
import { lineBookmarkTitle } from '../bookmarks/sort';
import { DetectedSymbol } from '../detection/types';
import {
  ExportedBookmark,
  ExportRow,
  ExportStatus,
  extractFunctionSnippet,
  extractLineSnippet,
  GuideEntry,
  GuideSnippet,
  lastKnownCode,
} from '../share/format';
import { SymbolMark, validNumber } from '../storage/marks';
import { languageForPath } from '../util/paths';
import { FavoriteStatus } from './resolve';

/** 一筆要匯出的書籤（行號書籤或函式書籤）。 */
export interface ExportItem {
  id: string;
  file: string;
  /** 0 起算。函式書籤為函式名稱所在的行。 */
  line: number;
  title: string;
  tags: string[];
  imported: boolean;
  number?: number;
  color?: string;
  /** 位置不可靠時的狀態：導讀文件、表格、CSV 要標示，也不能照行號擷取程式碼。 */
  status?: ExportStatus;
  createdAt?: string;
  line_?: LineBookmark;
  symbol?: { path: string; kind: string; alias?: string; note?: string; startLine?: number; endLine?: number };
}

/** 各檔案目前的內容（以行為單位）；undefined 表示讀不到。 */
export type FileContents = Map<string, string[] | undefined>;

export function itemFromBookmark(b: LineBookmark): ExportItem {
  return {
    id: b.id,
    file: b.file,
    line: b.line,
    title: lineBookmarkTitle(b),
    tags: b.tags ?? [],
    imported: !!b.source,
    number: b.number,
    color: b.color,
    status: b.status === 'lost' || b.status === 'notOnBranch' ? b.status : undefined,
    createdAt: b.createdAt,
    line_: b,
  };
}

export function itemFromFavorite(m: SymbolMark, symbol: DetectedSymbol | undefined, status: FavoriteStatus): ExportItem {
  return {
    id: `fn:${m.file}:${m.kind}:${m.path}`,
    file: m.file,
    line: symbol?.nameLine ?? m.line ?? 0,
    title: m.alias ?? m.path.split('.').pop() ?? m.path,
    tags: m.tags ?? [],
    imported: false,
    number: m.number,
    color: m.color,
    status: status === 'ok' ? undefined : status,
    createdAt: m.addedAt,
    symbol: {
      path: m.path,
      kind: m.kind,
      alias: m.alias,
      note: m.note,
      startLine: symbol?.startLine,
      endLine: symbol?.endLine,
    },
  };
}

/** 依檔案、行號排序。 */
export function sortItems(list: ExportItem[]): ExportItem[] {
  return list.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** 匯出檔（JSON）的書籤項目。 */
export function jsonBookmarks(list: ExportItem[], contents: FileContents, includeCode: boolean): ExportedBookmark[] {
  return list.map((c) => {
    const lines = contents.get(c.file);
    const e: ExportedBookmark = { kind: c.symbol ? 'symbol' : 'line', id: c.id, file: c.file, line: c.line };
    const label = c.symbol ? c.symbol.alias : c.line_?.label;
    if (label) {
      e.label = label;
    }
    if (c.tags.length) {
      e.tags = c.tags;
    }
    const note = c.symbol ? c.symbol.note : c.line_?.note;
    if (note) {
      e.note = note;
    }
    if (c.symbol) {
      e.path = c.symbol.path;
      e.symbolKind = c.symbol.kind;
    } else if (c.line_?.symbol) {
      // 從別人匯入的函式書籤，轉出去時仍是函式書籤
      e.kind = 'symbol';
      e.path = c.line_.symbol.path;
      e.symbolKind = c.line_.symbol.kind;
    }
    if (c.line_?.source) {
      e.author = c.line_.source.author;
    }
    if (c.createdAt) {
      e.createdAt = c.createdAt;
    }
    if (validNumber(c.number)) {
      e.number = c.number;
    }
    if (paletteColor(c.color)) {
      e.color = c.color;
    }
    if (c.status) {
      e.status = c.status;
    }
    if (includeCode) {
      // 位置不可靠的書籤不能用目前檔案這一行的內容當 anchor（會是不相干的程式碼），只帶最後記得的內容
      if (lines && !c.status && c.line < lines.length) {
        const old = c.line_?.anchor;
        e.anchor = makeAnchor(lines, c.line, old?.symbolPath ?? c.symbol?.path, undefined);
        if (old?.symbolOffset !== undefined) {
          e.anchor.symbolOffset = old.symbolOffset;
        }
      } else if (c.line_?.anchor) {
        e.anchor = c.line_.anchor;
      }
    }
    return e;
  });
}

/** Markdown 表格與 CSV 的列；`statusLabel` 把狀態轉成要顯示的文字。 */
export function tableRows(
  list: ExportItem[],
  contents: FileContents,
  includeCode: boolean,
  statusLabel: (status: ExportStatus) => string,
): ExportRow[] {
  return list.map((c) => {
    const lines = contents.get(c.file);
    const row: ExportRow = {
      file: c.file,
      line: c.line + 1,
      name: c.title,
      kind: c.symbol || c.line_?.symbol ? 'symbol' : 'line',
      tags: c.tags,
      note: c.symbol ? c.symbol.note : c.line_?.note,
      source: c.line_?.source?.author,
    };
    if (c.status) {
      row.status = statusLabel(c.status);
    }
    if (includeCode) {
      row.code = c.status ? (lastKnownCode(c.status, c.line_?.anchor) ?? '') : (lines?.[c.line]?.trim() ?? c.line_?.anchor?.text ?? '');
    }
    return row;
  });
}

/**
 * 導讀文件的段落：函式書籤取函式本體（最多 30 行），行號書籤取前後各 3 行。
 * 函式範圍不知道時呼叫 `findRange` 重新偵測（沒給或找不到就改取前後幾行）。
 */
export async function guideEntries(
  list: ExportItem[],
  contents: FileContents,
  includeCode: boolean,
  findRange?: (file: string, path: string, kind: string) => Promise<{ startLine: number; endLine: number } | undefined>,
): Promise<GuideEntry[]> {
  const entries: GuideEntry[] = [];
  for (const c of list) {
    const lines = contents.get(c.file);
    let snippet: GuideSnippet | undefined;
    if (c.status) {
      const code = includeCode ? lastKnownCode(c.status, c.line_?.anchor) : undefined;
      snippet = code ? { code, omittedLines: 0 } : undefined;
    } else if (includeCode && lines) {
      const symTarget = c.symbol ?? c.line_?.symbol;
      if (symTarget) {
        let startLine = c.symbol?.startLine;
        let endLine = c.symbol?.endLine;
        if ((startLine === undefined || endLine === undefined) && findRange) {
          const found = await findRange(c.file, symTarget.path, symTarget.kind).catch(() => undefined);
          if (found) {
            startLine = found.startLine;
            endLine = found.endLine;
          }
        }
        snippet =
          startLine !== undefined && endLine !== undefined ? extractFunctionSnippet(lines, startLine, endLine) : extractLineSnippet(lines, c.line);
      } else {
        snippet = extractLineSnippet(lines, c.line);
      }
    }
    entries.push({
      number: c.number,
      name: c.title,
      file: c.file,
      line: c.line + 1,
      tags: c.tags,
      note: c.symbol ? c.symbol.note : c.line_?.note,
      source: c.line_?.source?.author,
      language: languageForPath(c.file),
      snippet,
      status: c.status,
    });
  }
  return entries;
}
