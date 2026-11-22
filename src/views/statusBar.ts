import * as vscode from 'vscode';
import { SECTION } from '../config';
import { MarkStore } from '../storage/store';
import { FavoritesModel } from '../symbols/favorites';
import { sameUri } from '../util/uris';
import { FavoriteGutter } from './gutter';

/**
 * 狀態列（M7）：目前檔案的書籤數、來源篩選與圖示隱藏的狀態；點一下打開快速搜尋。
 * 目前檔案不在工作區資料夾內、而且沒有篩選或隱藏時不顯示。
 */
export class BookmarkStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: MarkStore,
    private readonly favorites: FavoritesModel,
    private readonly gutter: FavoriteGutter,
  ) {
    this.item = vscode.window.createStatusBarItem('functionBookmarks.status', vscode.StatusBarAlignment.Left, 50);
    this.item.name = vscode.l10n.t('Function Bookmarks');
    this.item.command = 'functionBookmarks.searchBookmarks';
    this.disposables.push(
      this.item,
      store.onDidChange(() => this.schedule()),
      favorites.onDidChange(() => this.schedule()),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(0)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.statusBar`)) {
          this.schedule(0);
        }
      }),
    );
    this.update();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }

  schedule(delay = 100): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.update(), delay);
  }

  /** 給測試用：目前顯示的文字（不顯示時為 undefined）。 */
  text: string | undefined;
  tooltip: string | undefined;

  update(): void {
    if (!vscode.workspace.getConfiguration(SECTION).get<boolean>('statusBar.enabled', true)) {
      this.hide();
      return;
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    const inWorkspace = !!uri && !!this.store.locate(uri);
    const hiddenSources = this.store.hiddenSourceList;
    const filtered = hiddenSources.length > 0;
    const iconsHidden = this.gutter.hidden;
    if (!inWorkspace && !filtered && !iconsHidden) {
      this.hide();
      return;
    }
    const lines = uri
      ? this.store.bookmarksFor(uri).filter((b) => b.status !== 'notOnBranch' && this.store.shownBySource(b)).length
      : 0;
    const fns = uri ? this.favorites.all.filter((f) => sameUri(f.uri, uri)).length : 0;
    const inFile = lines + fns;
    const total =
      this.store.allBookmarks().filter((e) => this.store.shownBySource(e.bookmark)).length + this.favorites.all.length;
    const parts = [`$(bookmark) ${inWorkspace ? inFile : total}`];
    if (filtered) {
      parts.push('$(filter)');
    }
    if (iconsHidden) {
      parts.push('$(eye-closed)');
    }
    const tips: string[] = [];
    if (inWorkspace) {
      tips.push(vscode.l10n.t('{0} bookmark(s) in this file, {1} in total', inFile, total));
    } else {
      tips.push(vscode.l10n.t('{0} bookmark(s) in total', total));
    }
    if (filtered) {
      const shown = ['', ...this.store.sources()].filter((s) => !hiddenSources.includes(s)).map((s) => s || vscode.l10n.t('Mine'));
      tips.push(vscode.l10n.t('Source filter: showing {0}', shown.length ? shown.join(', ') : vscode.l10n.t('none')));
    }
    if (iconsHidden) {
      tips.push(vscode.l10n.t('Bookmark icons in the editor are hidden'));
    }
    tips.push(vscode.l10n.t('Click to search bookmarks'));
    this.text = parts.join(' ');
    this.tooltip = tips.join('\n');
    this.item.text = this.text;
    this.item.tooltip = this.tooltip;
    this.item.show();
  }

  private hide(): void {
    this.text = undefined;
    this.tooltip = undefined;
    this.item.hide();
  }
}
