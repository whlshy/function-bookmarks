import * as vscode from 'vscode';
import { DetectedSymbol } from '../detection/types';
import { MarkStore } from '../storage/store';
import { SymbolService } from '../symbols/symbolService';
import { uriKey } from '../util/uris';
import { bookmarkTitle } from '../bookmarks/commands';
import { circled, DEFAULT_COLOR, effectiveColor, GutterKind, gutterSvg, paletteColor, svgDataUri } from '../bookmarks/decor';
import { SECTION } from '../config';
import { bookmarkPreviewLink, trustPreviewLink } from './noteEditor';

function escapeMd(s: string): string {
  return s.replace(/[\\`*_[\]]/g, '\\$&');
}

type LineKind = 'favorite' | 'note' | 'bookmark' | 'foreign' | 'label';

/**
 * 在編輯器行號旁（gutter）標示書籤與有備註的函式：
 * - 行號書籤：書籤圖示；函式書籤：書籤圖示加星星；有號碼時圖示上顯示號碼
 * - 顏色依書籤自己的顏色 → 標籤顏色 → 預設（自己的青綠、別人的紫色）
 * - 只有備註的函式：藍色備註圖示
 * - 書籤有名稱時，行尾淡淡顯示名稱（可在設定關閉）
 * - 可暫時隱藏全部（方便設中斷點），書籤不受影響
 */
export class FavoriteGutter implements vscode.Disposable {
  private readonly noteType: vscode.TextEditorDecorationType;
  private readonly labelType: vscode.TextEditorDecorationType;
  /** 依「種類＋顏色＋號碼」建立的書籤圖示樣式。 */
  private readonly iconTypes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly lines = new Map<string, Record<LineKind, number[]>>();
  private timer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];
  private hiddenValue = false;

  constructor(
    extensionUri: vscode.Uri,
    private readonly service: SymbolService,
    private readonly store: MarkStore,
  ) {
    this.noteType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'gutter-note.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: '#3794FF',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.labelType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 3em',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.disposables.push(
      this.noteType,
      this.labelType,
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule(0)),
      store.onDidChange(() => this.schedule(0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length && vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) {
          this.schedule();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.bookmarks.showLabelAtLineEnd`)) {
          this.schedule(0);
        }
      }),
    );
    this.schedule(0);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.iconTypes.forEach((t) => t.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  /** 暫時隱藏全部圖示與行尾名稱。 */
  get hidden(): boolean {
    return this.hiddenValue;
  }

  set hidden(v: boolean) {
    this.hiddenValue = v;
    this.schedule(0);
  }

  /** 給測試用：某個檔案目前標示的行號（0 起算）。 */
  linesFor(uri: vscode.Uri, kind: LineKind = 'favorite'): number[] {
    return this.lines.get(uriKey(uri))?.[kind] ?? [];
  }

  /** 給測試用：某一行行尾顯示的文字。 */
  labelAt(uri: vscode.Uri, line: number): string | undefined {
    return this.labelTexts.get(`${uriKey(uri)}#${line}`);
  }

  /** 給測試用：某一行圖示的樣式（種類|顏色|號碼）。 */
  iconAt(uri: vscode.Uri, line: number): string | undefined {
    return this.iconKeys.get(`${uriKey(uri)}#${line}`);
  }

  private labelTexts = new Map<string, string>();
  private iconKeys = new Map<string, string>();

  schedule(delay = 300): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.update(), delay);
  }

  private iconType(kind: GutterKind, color: string, n: number | undefined): { key: string; type: vscode.TextEditorDecorationType } {
    const hex = paletteColor(color)?.hex ?? paletteColor(DEFAULT_COLOR)!.hex;
    const key = `${kind}|${color}|${n ?? ''}`;
    let type = this.iconTypes.get(key);
    if (!type) {
      type = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(svgDataUri(gutterSvg(kind, hex, n))),
        gutterIconSize: 'contain',
        overviewRulerColor: hex,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      });
      this.iconTypes.set(key, type);
    }
    return { key, type };
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.noteType, []);
    editor.setDecorations(this.labelType, []);
    this.iconTypes.forEach((t) => editor.setDecorations(t, []));
  }

  async update(): Promise<void> {
    const showLabels = vscode.workspace.getConfiguration(SECTION).get<boolean>('bookmarks.showLabelAtLineEnd', true);
    const tagColors = this.store.tagColors();
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri;
      const fileKey = uriKey(uri);
      for (const k of [...this.labelTexts.keys(), ...this.iconKeys.keys()]) {
        if (k.startsWith(`${fileKey}#`)) {
          this.labelTexts.delete(k);
          this.iconKeys.delete(k);
        }
      }
      if (!this.store.locate(uri) || this.hiddenValue) {
        this.clear(editor);
        this.lines.set(fileKey, { favorite: [], note: [], bookmark: [], foreign: [], label: [] });
        continue;
      }
      const file = await this.service.getSymbols(editor.document);
      const byType = new Map<string, { type: vscode.TextEditorDecorationType; options: vscode.DecorationOptions[] }>();
      const add = (kind: GutterKind, color: string, n: number | undefined, option: vscode.DecorationOptions) => {
        const { key, type } = this.iconType(kind, color, n);
        const slot = byType.get(key) ?? { type, options: [] };
        slot.options.push(option);
        byType.set(key, slot);
        this.iconKeys.set(`${fileKey}#${option.range.start.line}`, key);
      };
      const result: Record<LineKind, number[]> = { favorite: [], note: [], bookmark: [], foreign: [], label: [] };
      const note: vscode.DecorationOptions[] = [];
      const labels: vscode.DecorationOptions[] = [];
      const addLabel = (line: number, text: string) => {
        if (!showLabels || line >= editor.document.lineCount) {
          return;
        }
        const end = editor.document.lineAt(line).range.end;
        labels.push({ range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } });
        result.label.push(line);
        this.labelTexts.set(`${fileKey}#${line}`, text);
      };
      const walk = (list: DetectedSymbol[]) => {
        for (const s of list) {
          const mark = this.store.get(uri, s);
          if (mark?.favorite) {
            // 函式的提示（書籤、備註）由 BookmarkHoverProvider 提供，這裡只標示圖示
            add('favorite', effectiveColor(mark, tagColors) ?? DEFAULT_COLOR, mark.number, { range: new vscode.Range(s.nameLine, 0, s.nameLine, 0) });
            result.favorite.push(s.nameLine);
            if (mark.number) {
              // 函式名稱就在那一行，行尾只顯示號碼（自訂名稱在側邊欄看得到）
              addLabel(s.nameLine, `${circled(mark.number)}${mark.alias ? ` ${mark.alias}` : ''}`);
            } else if (mark.alias) {
              addLabel(s.nameLine, mark.alias);
            }
          } else if (mark?.note) {
            note.push({ range: new vscode.Range(s.nameLine, 0, s.nameLine, 0) });
            result.note.push(s.nameLine);
          }
          walk(s.children);
        }
      };
      walk(file.symbols);
      for (const b of this.store.bookmarksFor(uri)) {
        // 不在此分支的書籤：那一行不是它原本的位置，不顯示；被來源篩選隱藏的也不顯示
        if (b.line >= editor.document.lineCount || b.status === 'notOnBranch' || !this.store.shownBySource(b)) {
          continue;
        }
        const text = editor.document.lineAt(b.line);
        const color = effectiveColor(b, tagColors) ?? DEFAULT_COLOR;
        (b.source ? result.foreign : result.bookmark).push(b.line);
        if (b.label || b.number || b.source) {
          const parts = [circled(b.number), b.label ?? (b.symbol ? bookmarkTitle(b) : ''), b.source ? `@${b.source.author}` : ''];
          addLabel(b.line, parts.filter(Boolean).join(' '));
        }
        if (!b.note && !b.source) {
          add('bookmark', color, b.number, { range: new vscode.Range(b.line, 0, b.line, 0) });
          continue;
        }
        // 有備註或是別人的書籤：範圍是整行內容，滑鼠移到那一行就顯示備註與來源
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${escapeMd(bookmarkTitle(b))}**`);
        if (b.tags?.length) {
          md.appendMarkdown(`  ${b.tags.map((t) => `#${escapeMd(t)}`).join(' ')}`);
        }
        if (b.source) {
          md.appendMarkdown(`\n\n${vscode.l10n.t('From {0}', escapeMd(b.source.author))}`);
        }
        if (b.note) {
          md.appendMarkdown('\n\n---\n\n');
          md.appendMarkdown(b.note);
          md.appendMarkdown(`\n\n${bookmarkPreviewLink(uri, b.id)}`);
          trustPreviewLink(md);
        }
        add('bookmark', color, b.number, {
          range: new vscode.Range(b.line, text.firstNonWhitespaceCharacterIndex, b.line, text.text.length),
          hoverMessage: md,
        });
      }
      this.lines.set(fileKey, result);
      editor.setDecorations(this.noteType, note);
      editor.setDecorations(this.labelType, labels);
      for (const [key, type] of this.iconTypes) {
        editor.setDecorations(type, byType.get(key)?.options ?? []);
      }
    }
  }
}
