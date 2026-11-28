import * as vscode from 'vscode';
import { DetectedSymbol } from '../detection/types';
import { MarkStore } from '../storage/store';
import { SymbolService } from '../symbols/symbolService';
import { uriKey } from '../util/uris';
import { bookmarkTitle } from '../bookmarks/commands';
import {
  circled,
  DEFAULT_COLOR,
  effectiveColor,
  GutterKind,
  gutterSvg,
  LOST_HEX,
  overviewRulerOptions,
  paletteColor,
  svgDataUri,
} from '../bookmarks/decor';
import { SECTION } from '../config';
import { closeUnclosedFences } from '../markdown/fences';
import { formatLocalDateTime } from '../util/time';
import { bookmarkPreviewLink, trustPreviewLink } from './noteEditor';

export { overviewRulerOptions } from '../bookmarks/decor';

const NOTE_RULER_COLOR = '#3794FF';

function escapeMd(s: string): string {
  return s.replace(/[\\`*_[\]]/g, '\\$&');
}

type LineKind = 'favorite' | 'note' | 'bookmark' | 'foreign' | 'label';

/**
 * 在編輯器行號旁（gutter）標示書籤與有備註的函式：
 * - 行號書籤：書籤圖示；函式書籤：書籤圖示加星星；有號碼時圖示上顯示號碼
 * - 需確認（lost）的行號書籤：灰色問號圖示，滑鼠提示說明原因
 * - 顏色依書籤自己的顏色 → 標籤顏色 → 預設（自己的青綠、別人的紫色）
 * - 只有備註的函式：藍色備註圖示
 * - 書籤有名稱時，行尾淡淡顯示名稱（可在設定關閉）
 * - 可暫時隱藏全部（方便設中斷點），書籤不受影響
 */
export class FavoriteGutter implements vscode.Disposable {
  private noteType: vscode.TextEditorDecorationType;
  private readonly labelType: vscode.TextEditorDecorationType;
  /** 依「種類＋顏色＋號碼」建立的書籤圖示樣式。 */
  private readonly iconTypes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly lines = new Map<string, Record<LineKind, number[]>>();
  private scrollbarMarker: unknown;
  private timer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];
  private disposed = false;
  private hiddenValue = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: SymbolService,
    private readonly store: MarkStore,
  ) {
    this.scrollbarMarker = this.readScrollbarMarker();
    this.noteType = this.createNoteType();
    this.labelType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 3em',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.disposables.push(
      this.labelType,
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule(0)),
      store.onDidChange(() => this.schedule(0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length && vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) {
          this.schedule();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        let redraw = false;
        if (e.affectsConfiguration(`${SECTION}.bookmarks.scrollbarMarker`)) {
          this.rebuildMarkerTypes();
          redraw = true;
        }
        if (e.affectsConfiguration(`${SECTION}.bookmarks.showLabelAtLineEnd`)) {
          redraw = true;
        }
        if (redraw) {
          this.schedule(0);
        }
      }),
    );
    this.schedule(0);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.noteType.dispose();
    this.iconTypes.forEach((t) => t.dispose());
    this.iconTypes.clear();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  /** 多資料夾工作區以視窗／工作區層級設定為準（與 bookmarks.showLabelAtLineEnd 一致）。 */
  private readScrollbarMarker(): unknown {
    return vscode.workspace.getConfiguration(SECTION).get<string>('bookmarks.scrollbarMarker', 'left');
  }

  private createNoteType(): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'gutter-note.svg'),
      gutterIconSize: 'contain',
      ...overviewRulerOptions(this.scrollbarMarker, NOTE_RULER_COLOR),
    });
  }

  /** 捲軸標記設定變更時，釋放舊的 decoration type 並重建，讓設定立刻生效。 */
  private rebuildMarkerTypes(): void {
    if (this.disposed) {
      return;
    }
    this.scrollbarMarker = this.readScrollbarMarker();
    this.noteType.dispose();
    this.iconTypes.forEach((t) => t.dispose());
    this.iconTypes.clear();
    this.noteType = this.createNoteType();
  }

  /** 暫時隱藏全部圖示與行尾名稱。 */
  get hidden(): boolean {
    return this.hiddenValue;
  }

  set hidden(v: boolean) {
    this.hiddenValue = v;
    this.schedule(0);
  }

  /** 給測試用：目前生效的捲軸標記設定值。 */
  get scrollbarMarkerSetting(): unknown {
    return this.scrollbarMarker;
  }

  /** 給測試用：目前備註圖示的 decoration type 鍵值（重建後會更換）。 */
  get noteDecorationKey(): string {
    return this.noteType.key;
  }

  /** 給測試用：某一行圖示目前使用的 decoration type 鍵值（重建後會更換）。 */
  iconDecorationKeyAt(uri: vscode.Uri, line: number): string | undefined {
    const key = this.iconKeys.get(`${uriKey(uri)}#${line}`);
    return key ? this.iconTypes.get(key)?.key : undefined;
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

  /** 給測試用：某一行圖示的滑鼠提示內容（Markdown 原文）。 */
  hoverAt(uri: vscode.Uri, line: number): string | undefined {
    return this.hoverTexts.get(`${uriKey(uri)}#${line}`);
  }

  private labelTexts = new Map<string, string>();
  private iconKeys = new Map<string, string>();
  private hoverTexts = new Map<string, string>();

  schedule(delay = 300): void {
    if (this.disposed) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.update(), delay);
  }

  private iconType(kind: GutterKind, color: string, n: number | undefined): { key: string; type: vscode.TextEditorDecorationType } {
    const hex = kind === 'lost' ? LOST_HEX : (paletteColor(color)?.hex ?? paletteColor(DEFAULT_COLOR)!.hex);
    const key = `${kind}|${color}|${n ?? ''}`;
    let type = this.iconTypes.get(key);
    if (!type) {
      type = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(svgDataUri(gutterSvg(kind, hex, n))),
        gutterIconSize: 'contain',
        ...overviewRulerOptions(this.scrollbarMarker, hex),
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

  /** 每次 update 遞增；等偵測結果期間又有新的 update 時，舊的那次放棄，避免慢的舊結果蓋掉新畫面。 */
  private seq = 0;
  private latest: Promise<void> = Promise.resolve();

  /** 重畫所有可見編輯器；被較新的一次取代時，等那一次畫完才結束。 */
  update(): Promise<void> {
    const p = this.render(++this.seq);
    this.latest = p;
    return p;
  }

  private async render(seq: number): Promise<void> {
    if (this.disposed) {
      return;
    }
    const showLabels = vscode.workspace.getConfiguration(SECTION).get<boolean>('bookmarks.showLabelAtLineEnd', true);
    const tagColors = this.store.tagColors();
    const favoritesShown = this.store.favoritesShown;
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.disposed) {
        return;
      }
      const uri = editor.document.uri;
      const fileKey = uriKey(uri);
      // 對照表（測試用）在確定要更新這個檔案時才清：被較新的一次取代時保留舊的
      const forget = () => {
        for (const k of [...this.labelTexts.keys(), ...this.iconKeys.keys(), ...this.hoverTexts.keys()]) {
          if (k.startsWith(`${fileKey}#`)) {
            this.labelTexts.delete(k);
            this.iconKeys.delete(k);
            this.hoverTexts.delete(k);
          }
        }
      };
      if (!this.store.locate(uri) || this.hiddenValue) {
        forget();
        this.clear(editor);
        this.lines.set(fileKey, { favorite: [], note: [], bookmark: [], foreign: [], label: [] });
        continue;
      }
      const file = await this.service.getSymbols(editor.document);
      if (this.disposed) {
        return;
      }
      if (seq !== this.seq) {
        return this.latest;
      }
      forget();
      const lineCount = editor.document.lineCount;
      const byType = new Map<string, { type: vscode.TextEditorDecorationType; options: vscode.DecorationOptions[] }>();
      const add = (kind: GutterKind, color: string, n: number | undefined, option: vscode.DecorationOptions) => {
        const { key, type } = this.iconType(kind, color, n);
        const slot = byType.get(key) ?? { type, options: [] };
        slot.options.push(option);
        byType.set(key, slot);
        const lineKey = `${fileKey}#${option.range.start.line}`;
        this.iconKeys.set(lineKey, key);
        if (option.hoverMessage instanceof vscode.MarkdownString) {
          this.hoverTexts.set(lineKey, option.hoverMessage.value);
        }
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
          if (s.nameLine >= lineCount) {
            // 偵測結果對應的是較舊的內容（例如剛刪了很多行）：超出範圍的不標示
            continue;
          }
          const mark = this.store.get(uri, s);
          if (mark?.favorite && favoritesShown) {
            // 函式的提示（書籤、備註）由 BookmarkHoverProvider 提供，這裡只標示圖示
            add('favorite', effectiveColor(mark, tagColors) ?? DEFAULT_COLOR, mark.number, { range: new vscode.Range(s.nameLine, 0, s.nameLine, 0) });
            result.favorite.push(s.nameLine);
            if (mark.number) {
              // 函式名稱就在那一行，行尾只顯示號碼（自訂名稱在側邊欄看得到）
              addLabel(s.nameLine, `${circled(mark.number)}${mark.alias ? ` ${mark.alias}` : ''}`);
            } else if (mark.alias) {
              addLabel(s.nameLine, mark.alias);
            }
          } else if (mark?.note && !mark.favorite) {
            // 被來源篩選隱藏的函式書籤（「我的」沒勾）整個不顯示，不要改成顯示備註圖示
            note.push({ range: new vscode.Range(s.nameLine, 0, s.nameLine, 0) });
            result.note.push(s.nameLine);
          }
          walk(s.children);
        }
      };
      walk(file.symbols);
      // 不在此分支的書籤：那一行不是它原本的位置，不顯示；被來源篩選隱藏的也不顯示
      for (const b of this.store.shownBookmarksFor(uri)) {
        if (b.line >= lineCount) {
          continue;
        }
        const text = editor.document.lineAt(b.line);
        const color = effectiveColor(b, tagColors) ?? DEFAULT_COLOR;
        const lost = b.status === 'lost';
        const kind: GutterKind = lost ? 'lost' : 'bookmark';
        (b.source ? result.foreign : result.bookmark).push(b.line);
        if (b.label || b.number || b.source) {
          const parts = [circled(b.number), b.label ?? (b.symbol ? bookmarkTitle(b) : ''), b.source ? `@${b.source.author}` : ''];
          addLabel(b.line, parts.filter(Boolean).join(' '));
        }
        if (!b.note && !b.source && !lost) {
          add(kind, color, b.number, { range: new vscode.Range(b.line, 0, b.line, 0) });
          continue;
        }
        // 有備註、是別人的書籤，或需確認：範圍是整行內容，滑鼠移到那一行就顯示說明、備註與來源
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${escapeMd(bookmarkTitle(b))}**`);
        if (b.tags?.length) {
          md.appendMarkdown(`  ${b.tags.map((t) => `#${escapeMd(t)}`).join(' ')}`);
        }
        if (lost) {
          md.appendMarkdown(
            `\n\n${vscode.l10n.t('The bookmarked line could not be found (deleted, changed a lot, or inside a merge conflict). Put the cursor on the correct line and use Move Bookmark to Cursor.')}`,
          );
        }
        if (b.source) {
          md.appendMarkdown(`\n\n${vscode.l10n.t('From {0}', escapeMd(b.source.author))}`);
        }
        if (b.note) {
          md.appendMarkdown('\n\n---\n\n');
          md.appendMarkdown(closeUnclosedFences(b.note));
          md.appendMarkdown(`\n\n${bookmarkPreviewLink(uri, b.id)}`);
          trustPreviewLink(md);
        }
        const created = formatLocalDateTime(b.createdAt);
        if (created) {
          md.appendMarkdown(`\n\n${vscode.l10n.t('Created {0}', created)}`);
        }
        add(kind, color, b.number, {
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
