import * as vscode from 'vscode';
import { SECTION } from '../config';
import { DetectedSymbol, SymbolKindName } from '../detection/types';
import { MarkStore } from '../storage/store';
import { SymbolService } from '../symbols/symbolService';
import { PREVIEW_NOTE_COMMAND, previewNoteLink } from './noteEditor';

export const HOVER_ACTION = 'functionBookmarks.hoverAction';

export type HoverActionName = 'toggle' | 'rename' | 'note';

export interface HoverActionArg {
  action: HoverActionName;
  uri: string;
  path: string;
  kind: SymbolKindName;
  line: number;
}

/** 哪些種類的符號名稱會顯示提示（Markdown 標題與 extends／include 不顯示）。 */
const HOVER_KINDS = new Set<SymbolKindName>(['function', 'method', 'class', 'block', 'partial', 'macro', 'event', 'request']);

function escapeMd(s: string): string {
  return s.replace(/[\\`*_[\]]/g, '\\$&');
}

function link(label: string, arg: HoverActionArg): string {
  return `[${label}](command:${HOVER_ACTION}?${encodeURIComponent(JSON.stringify([arg]))})`;
}

/** 找出名稱範圍包住游標的符號（同一行有多個時取最內層）。 */
export function symbolAtName(symbols: DetectedSymbol[], line: number, character: number): DetectedSymbol | undefined {
  let hit: DetectedSymbol | undefined;
  const walk = (list: DetectedSymbol[]) => {
    for (const s of list) {
      if (s.nameLine === line && character >= s.nameStartCol && character <= s.nameEndCol) {
        hit = s;
      }
      walk(s.children);
    }
  };
  walk(symbols);
  return hit;
}

/**
 * 滑鼠移到函式名稱上時的提示：加入／移除書籤、重新命名、編輯備註，並顯示備註內容。
 * 取代原本佔一行空間的 CodeLens。設定 functionBookmarks.hover.enabled 可關閉。
 */
export class BookmarkHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly service: SymbolService,
    private readonly store: MarkStore,
  ) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    if (!vscode.workspace.getConfiguration(SECTION, document.uri).get<boolean>('hover.enabled', true)) {
      return undefined;
    }
    if (!this.store.locate(document.uri)) {
      return undefined;
    }
    const file = await this.service.getSymbols(document);
    const s = symbolAtName(file.symbols, position.line, position.character);
    if (!s || !HOVER_KINDS.has(s.kind)) {
      return undefined;
    }
    const mark = this.store.get(document.uri, s);
    const base = { uri: document.uri.toString(), path: s.path, kind: s.kind, line: s.nameLine };
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: [HOVER_ACTION, PREVIEW_NOTE_COMMAND] };
    md.supportThemeIcons = true;
    md.appendMarkdown(`${mark?.favorite ? '$(star-full) ' : ''}**${escapeMd(mark?.alias ?? s.name)}**`);
    if (mark?.alias || s.path !== s.name) {
      md.appendMarkdown(`  \`${s.path}\``);
    }
    if (mark?.tags?.length) {
      md.appendMarkdown(`  ${mark.tags.map((t) => `#${escapeMd(t)}`).join(' ')}`);
    }
    md.appendMarkdown('\n\n');
    // 重新命名、備註只給已加入書籤的函式；已經有名稱或備註的舊資料仍可編輯
    const links = [
      link(
        mark?.favorite ? `$(star-full) ${vscode.l10n.t('Remove bookmark')}` : `$(star-empty) ${vscode.l10n.t('Add bookmark')}`,
        { ...base, action: 'toggle' },
      ),
    ];
    if (mark?.favorite || mark?.alias) {
      links.push(link(`$(edit) ${vscode.l10n.t('Rename')}`, { ...base, action: 'rename' }));
    }
    if (mark?.favorite || mark?.note) {
      links.push(link(`$(note) ${mark?.note ? vscode.l10n.t('Edit note') : vscode.l10n.t('Add note')}`, { ...base, action: 'note' }));
    }
    md.appendMarkdown(links.join(' &nbsp;·&nbsp; '));
    if (mark?.note) {
      md.appendMarkdown('\n\n---\n\n');
      md.appendMarkdown(mark.note);
      md.appendMarkdown(`\n\n${previewNoteLink(document.uri, s)}`);
    }
    return new vscode.Hover(md, new vscode.Range(s.nameLine, s.nameStartCol, s.nameLine, s.nameEndCol));
  }
}
