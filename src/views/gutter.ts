import * as vscode from 'vscode';
import { DetectedSymbol } from '../detection/types';
import { MarkStore } from '../storage/store';
import { SymbolService } from '../symbols/symbolService';
import { uriKey } from '../util/uris';
import { bookmarkTitle } from '../bookmarks/commands';
import { bookmarkPreviewLink, trustPreviewLink } from './noteEditor';

function escapeMd(s: string): string {
  return s.replace(/[\\`*_[\]]/g, '\\$&');
}

/**
 * 在編輯器行號旁（gutter）標示收藏與有備註的函式：
 * - 收藏：橘色書籤圖示
 * - 只有備註：藍色備註圖示
 * - 有備註時，滑鼠移到函式名稱上顯示備註全文
 */
export class FavoriteGutter implements vscode.Disposable {
  private readonly favoriteType: vscode.TextEditorDecorationType;
  private readonly noteType: vscode.TextEditorDecorationType;
  private readonly bookmarkType: vscode.TextEditorDecorationType;
  /** 別人的書籤（匯入的）：紫色。 */
  private readonly foreignType: vscode.TextEditorDecorationType;
  private readonly lines = new Map<string, { favorite: number[]; note: number[]; bookmark: number[]; foreign: number[] }>();
  private timer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    extensionUri: vscode.Uri,
    private readonly service: SymbolService,
    private readonly store: MarkStore,
  ) {
    this.favoriteType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'gutter-favorite.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: '#2BB5A0',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.noteType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'gutter-note.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: '#3794FF',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.bookmarkType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'gutter-bookmark.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: '#2BB5A0',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.foreignType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'gutter-bookmark-foreign.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: '#A371F7',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.disposables.push(
      this.favoriteType,
      this.noteType,
      this.bookmarkType,
      this.foreignType,
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule(0)),
      store.onDidChange(() => this.schedule(0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length && vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) {
          this.schedule();
        }
      }),
    );
    this.schedule(0);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }

  /** 給測試用：某個檔案目前標示的行號（0 起算）。 */
  linesFor(uri: vscode.Uri, kind: 'favorite' | 'note' | 'bookmark' | 'foreign' = 'favorite'): number[] {
    return this.lines.get(uriKey(uri))?.[kind] ?? [];
  }

  schedule(delay = 300): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.update(), delay);
  }

  async update(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri;
      if (!this.store.locate(uri)) {
        editor.setDecorations(this.favoriteType, []);
        editor.setDecorations(this.noteType, []);
        editor.setDecorations(this.bookmarkType, []);
        editor.setDecorations(this.foreignType, []);
        continue;
      }
      const file = await this.service.getSymbols(editor.document);
      const favorite: vscode.DecorationOptions[] = [];
      const note: vscode.DecorationOptions[] = [];
      const walk = (list: DetectedSymbol[]) => {
        for (const s of list) {
          const mark = this.store.get(uri, s);
          if (mark?.favorite || mark?.note) {
            // 函式的提示（書籤、備註）由 BookmarkHoverProvider 提供，這裡只標示圖示
            const option: vscode.DecorationOptions = { range: new vscode.Range(s.nameLine, 0, s.nameLine, 0) };
            (mark.favorite ? favorite : note).push(option);
          }
          walk(s.children);
        }
      };
      walk(file.symbols);
      // 行號書籤：有備註時範圍是整行內容，滑鼠移到那一行就顯示備註
      const bookmark: vscode.DecorationOptions[] = [];
      const foreign: vscode.DecorationOptions[] = [];
      for (const b of this.store.bookmarksFor(uri)) {
        // 不在此分支的書籤：那一行不是它原本的位置，不顯示；被來源篩選隱藏的也不顯示
        if (b.line >= editor.document.lineCount || b.status === 'notOnBranch' || !this.store.shownBySource(b)) {
          continue;
        }
        const text = editor.document.lineAt(b.line);
        const target = b.source ? foreign : bookmark;
        if (!b.note && !b.source) {
          target.push({ range: new vscode.Range(b.line, 0, b.line, 0) });
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
        target.push({
          range: new vscode.Range(b.line, text.firstNonWhitespaceCharacterIndex, b.line, text.text.length),
          hoverMessage: md,
        });
      }
      this.lines.set(uriKey(uri), {
        favorite: favorite.map((o) => o.range.start.line),
        note: note.map((o) => o.range.start.line),
        bookmark: bookmark.map((o) => o.range.start.line),
        foreign: foreign.map((o) => o.range.start.line),
      });
      editor.setDecorations(this.favoriteType, favorite);
      editor.setDecorations(this.noteType, note);
      editor.setDecorations(this.bookmarkType, bookmark);
      editor.setDecorations(this.foreignType, foreign);
    }
  }
}
