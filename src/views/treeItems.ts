/** 側邊欄書籤、函式、分組與搜尋列的 TreeItem（名稱、圖示、說明、提示與右鍵選單用的 contextValue）。 */
import * as path from 'path';
import * as vscode from 'vscode';
import { bookmarkTitle } from '../bookmarks/commands';
import { circled, effectiveColor, paletteColor } from '../bookmarks/decor';
import { BookmarkQuery, highlightRanges } from '../bookmarks/filter';
import { FileBookmarkSort, symbolBookmarkTitle } from '../bookmarks/sort';
import { SymbolKindName } from '../detection/types';
import { MarkStore } from '../storage/store';
import { ResolvedFavorite } from '../symbols/favorites';
import { basenamePosix } from '../util/paths';
import { formatLocalDateTime } from '../util/time';
import { closeUnclosedFences } from '../markdown/fences';
import { bookmarkPreviewLink, previewNoteLink, trustPreviewLink } from './noteEditor';
import { BmGroupNode, BookmarkNode, COMMANDS, displayName, FavoriteNode, FOREIGN_COLOR, ICONS, NOTE_COLOR, REFERENCE_KEYWORD, SymbolNode } from './treeNodes';

/** TreeItemFactory 需要的側邊欄狀態（由 FunctionTreeProvider 提供）。 */
export interface TreeItemContext {
  readonly store: MarkStore;
  /** 搜尋列有內容。 */
  searching(): boolean;
  /** 解析後的搜尋字串。 */
  query(): BookmarkQuery;
  /** 檔案在「依檔案分組」底下的排序方式。 */
  fileSortOf(target: string): FileBookmarkSort;
  /** 書籤分組預設展開或收合（書籤很多時收合）。 */
  defaultGroupState(): vscode.TreeItemCollapsibleState;
}

export class TreeItemFactory {
  constructor(private readonly ctx: TreeItemContext) {}

  /** 名稱標亮搜尋字（只標一般文字；#標籤、@來源 另外在分組名稱上標）。 */
  private highlighted(label: string, extraTerms: string[] = []): string | vscode.TreeItemLabel {
    if (!this.ctx.searching()) {
      return label;
    }
    const highlights = highlightRanges(label, [...this.ctx.query().text, ...extraTerms]);
    return highlights.length ? { label, highlights } : label;
  }

  /** 搜尋中，分組節點換一組 id：讓分組都展開（使用者先前收合的分組裡也可能有結果），清除搜尋後恢復原本的展開狀態。 */
  private groupId(id: string): string {
    return this.ctx.searching() ? `${id}:search` : id;
  }

  private favLabel(fav: ResolvedFavorite): string {
    return symbolBookmarkTitle(fav.mark);
  }

  bmGroupItem(element: BmGroupNode): vscode.TreeItem {
    const defaultState = this.ctx.defaultGroupState();
    if (element.by === 'source') {
      const item = new vscode.TreeItem(
        this.highlighted(element.key || vscode.l10n.t('Mine'), element.key ? this.ctx.query().authors : []),
        defaultState,
      );
      item.id = this.groupId(`bmSource:${element.key}`);
      item.iconPath = new vscode.ThemeIcon(element.key ? 'person' : 'account', element.key ? new vscode.ThemeColor(FOREIGN_COLOR) : undefined);
      item.description = String(element.items.length);
      item.contextValue = element.key ? 'fbBmSource:foreign' : 'fbBmSource';
      return item;
    }
    if (element.by === 'tag') {
      const item = new vscode.TreeItem(
        element.key ? this.highlighted(`#${element.key}`, this.ctx.query().tags) : vscode.l10n.t('No tag'),
        defaultState,
      );
      item.id = this.groupId(`bmTag:${element.key}`);
      const tc = paletteColor(this.ctx.store.tagColors().get(element.key));
      item.iconPath = new vscode.ThemeIcon('tag', tc ? new vscode.ThemeColor(tc.theme) : undefined);
      item.contextValue = element.key ? 'fbBmTag' : undefined;
      item.description = String(element.items.length);
      return item;
    }
    const rel = element.rel ?? '';
    const sort = this.ctx.fileSortOf(element.key);
    const item = new vscode.TreeItem(this.highlighted(basenamePosix(rel)), defaultState);
    item.id = this.groupId(`bmFile:${element.key}`);
    item.resourceUri = element.uri;
    item.iconPath = vscode.ThemeIcon.File;
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const folderName = multiRoot ? element.folder?.name : undefined;
    const sortLabel =
      sort === 'title' ? vscode.l10n.t('by title') : sort === 'created' ? vscode.l10n.t('by created time') : '';
    item.description = [folderName, dir, sortLabel].filter(Boolean).join(' · ');
    item.tooltip = folderName ? `${folderName} · ${rel}` : rel;
    item.contextValue = sort === 'title' ? 'fbBmFile:byTitle' : sort === 'created' ? 'fbBmFile:byCreated' : 'fbBmFile';
    return item;
  }

  bookmarkItem(element: BookmarkNode): vscode.TreeItem {
    const b = element.entry.bookmark;
    const item = new vscode.TreeItem(
      this.highlighted(b.number ? `${circled(b.number)} ${bookmarkTitle(b)}` : bookmarkTitle(b)),
      vscode.TreeItemCollapsibleState.None,
    );
    const color = paletteColor(effectiveColor(b, this.ctx.store.tagColors()));
    item.id = `bm:${element.parent.type === 'bmGroup' ? element.parent.key : ''}:${b.id}`;
    const lost = b.status === 'lost';
    const away = b.status === 'notOnBranch';
    item.iconPath = lost
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('disabledForeground'))
      : away
        ? new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('disabledForeground'))
        : new vscode.ThemeIcon(
            b.source && b.symbol ? 'symbol-method' : 'bookmark',
            color ? new vscode.ThemeColor(color.theme) : b.note ? new vscode.ThemeColor(NOTE_COLOR) : undefined,
          );
    const parts: string[] = [];
    if (lost) {
      parts.push(vscode.l10n.t('needs checking'));
    }
    if (away) {
      parts.push(vscode.l10n.t('not on this branch'));
    }
    if (b.scope === 'branch' && b.homeBranch) {
      parts.push(vscode.l10n.t('only on {0}', b.homeBranch));
    }
    if (b.source && !(element.parent.type === 'bmGroup' && element.parent.by === 'source')) {
      parts.push(`@${b.source.author}`);
    }
    // 不是依檔案分組（依標籤、依來源）時看不出是哪個檔案，補上檔名
    parts.push(notByFile(element) ? `${basenamePosix(b.file)}:${b.line + 1}` : String(b.line + 1));
    if (b.tags?.length && !(element.parent.type === 'bmGroup' && element.parent.by === 'tag')) {
      parts.push(b.tags.map((t) => `#${t}`).join(' '));
    }
    item.description = parts.join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMd(bookmarkTitle(b))}**\n\n`);
    md.appendMarkdown(`${escapeMd(b.file)}:${b.line + 1}`);
    if (b.label && b.anchor?.text) {
      md.appendMarkdown('\n\n');
      md.appendCodeblock(b.anchor.text);
    }
    if (b.tags?.length) {
      md.appendMarkdown(`\n\n${b.tags.map((t) => `#${escapeMd(t)}`).join(' ')}`);
    }
    if (away) {
      md.appendMarkdown(`\n\n${vscode.l10n.t('This code is not on the current branch. The bookmark comes back when you switch to a branch that has it.')}`);
    }
    if (b.source) {
      const when = b.source.importedAt ? ` · ${vscode.l10n.t('imported {0}', b.source.importedAt.slice(0, 10))}` : '';
      md.appendMarkdown(`\n\n${vscode.l10n.t('From {0}', escapeMd(b.source.author))}${when}`);
    }
    if (b.scope === 'branch' && b.homeBranch) {
      md.appendMarkdown(`\n\n${vscode.l10n.t('Shown only on branch {0}.', escapeMd(b.homeBranch))}`);
    }
    if (lost) {
      md.appendMarkdown(`\n\n${vscode.l10n.t('The bookmarked line could not be found (deleted, changed a lot, or inside a merge conflict). Put the cursor on the correct line and use Move Bookmark to Cursor.')}`);
    }
    if (b.note) {
      md.appendMarkdown('\n\n---\n\n');
      md.appendMarkdown(closeUnclosedFences(b.note));
      md.appendMarkdown(`\n\n${bookmarkPreviewLink(element.entry.uri, b.id)}`);
      trustPreviewLink(md);
    }
    const created = formatLocalDateTime(b.createdAt);
    if (created) {
      md.appendMarkdown(`\n\n${vscode.l10n.t('Created {0}', created)}`);
    }
    item.tooltip = md;
    item.contextValue = `fbBookmark${b.note ? ':note' : ''}${lost ? ':lost' : ''}${away ? ':away' : ''}${b.scope === 'branch' ? ':branchOnly' : ''}${b.source ? ':foreign' : ''}`;
    item.command = {
      command: COMMANDS.openBookmark,
      title: vscode.l10n.t('Go to bookmark'),
      arguments: [{ uri: element.entry.uri.toString(), bookmark: b.id }],
    };
    return item;
  }

  searchItem(queryText: string): vscode.TreeItem {
    // 沒有搜尋時名稱留空、用淡色的 description 當提示文字（像輸入框的 placeholder）
    const item = new vscode.TreeItem(queryText, vscode.TreeItemCollapsibleState.None);
    item.id = 'search';
    item.iconPath = new vscode.ThemeIcon('search');
    if (!queryText) {
      item.description = vscode.l10n.t('Search bookmarks…');
    }
    item.tooltip = vscode.l10n.t('Search bookmarks by name, tag, file, function, code or note. #tag searches tags only, @source shows one person\'s bookmarks.');
    item.contextValue = queryText ? 'fbSearch:active' : 'fbSearch';
    item.command = { command: 'functionBookmarks.focusSearch', title: vscode.l10n.t('Search bookmarks…') };
    return item;
  }

  private tooltip(
    name: string,
    alias: string | undefined,
    symPath: string,
    rel: string,
    line: number | undefined,
    extra: string[],
    note?: string,
    previewTarget?: { uri: vscode.Uri; kind: SymbolKindName },
    createdAt?: string,
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMd(alias ?? name)}**\n\n`);
    if (alias) {
      md.appendMarkdown(`${vscode.l10n.t('Original name')}: \`${name}\`\n\n`);
    }
    md.appendMarkdown(`${vscode.l10n.t('Path')}: \`${symPath}\`\n\n`);
    md.appendMarkdown(`${escapeMd(rel)}${line !== undefined ? `:${line + 1}` : ''}`);
    for (const e of extra) {
      md.appendMarkdown(`\n\n${e}`);
    }
    if (note) {
      md.appendMarkdown('\n\n---\n\n');
      md.appendMarkdown(closeUnclosedFences(note));
      if (previewTarget) {
        md.appendMarkdown(`\n\n${previewNoteLink(previewTarget.uri, { path: symPath, kind: previewTarget.kind })}`);
        trustPreviewLink(md);
      }
    }
    const created = formatLocalDateTime(createdAt);
    if (created) {
      md.appendMarkdown(`\n\n${vscode.l10n.t('Created {0}', created)}`);
    }
    return md;
  }

  symbolItem(element: SymbolNode): vscode.TreeItem {
    const s = element.symbol;
    const mark = this.ctx.store.get(element.uri, s);
    const isRef = s.kind === 'reference';
    const item = new vscode.TreeItem(
      displayName(s.name, mark?.alias),
      element.children.length
        ? element.scope === 'current'
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = element.id;
    item.iconPath = new vscode.ThemeIcon(ICONS[s.kind] ?? 'symbol-misc', mark?.note ? new vscode.ThemeColor(NOTE_COLOR) : undefined);
    const prefix = `${mark?.favorite ? '★' : ''}${mark?.alias ? '✎' : ''}`;
    const parts: string[] = [];
    const keyword = REFERENCE_KEYWORD[s.ruleId];
    if (keyword) {
      parts.push(keyword);
    }
    parts.push(String(s.nameLine + 1));
    if (element.override) {
      parts.push(vscode.l10n.t('overrides {0}', basenamePosix(element.override.label)));
    }
    item.description = prefix ? `${prefix} ${parts.join(' · ')}` : parts.join(' · ');
    const extra = [`${vscode.l10n.t('Rule')}: \`${s.ruleId}\``];
    if (element.override) {
      extra.push(vscode.l10n.t('Overrides the block in {0}', element.override.label));
    }
    item.tooltip = this.tooltip(
      s.name,
      mark?.alias,
      s.path,
      vscode.workspace.asRelativePath(element.uri, false),
      s.nameLine,
      extra,
      mark?.note,
      {
        uri: element.uri,
        kind: s.kind,
      },
      mark?.favorite ? mark.addedAt : undefined,
    );
    item.contextValue = `fbSymbol:${mark?.favorite ? 'fav' : 'nofav'}${mark?.alias ? ':alias' : ''}${mark?.note ? ':note' : ''}${isRef ? ':ref' : ''}${
      element.override ? ':override' : ''
    }`;
    item.command = isRef
      ? { command: COMMANDS.openTemplate, title: vscode.l10n.t('Open template'), arguments: [element] }
      : {
          command: COMMANDS.reveal,
          title: vscode.l10n.t('Go to symbol'),
          arguments: [element.uri, s.nameLine, s.nameStartCol, s.nameEndCol],
        };
    return item;
  }

  favoriteItem(element: FavoriteNode): vscode.TreeItem {
    const { fav } = element;
    const name = fav.mark.path.split('.').pop() ?? fav.mark.path;
    const item = new vscode.TreeItem(
      this.highlighted(fav.mark.number ? `${circled(fav.mark.number)} ${this.favLabel(fav)}` : this.favLabel(fav)),
      vscode.TreeItemCollapsibleState.None,
    );
    const color = paletteColor(effectiveColor(fav.mark, this.ctx.store.tagColors()));
    const byTag = element.parent.type === 'bmGroup' && element.parent.by === 'tag';
    item.id = `fav:${element.parent.type === 'bmGroup' ? element.parent.key : ''}:${fav.uri.toString()}::${fav.mark.kind}:${fav.mark.path}`;
    const line = fav.symbol?.nameLine ?? fav.mark.line;
    const parts: string[] = [];
    if (fav.mark.alias) {
      parts.push('✎');
    }
    if (fav.status === 'ok') {
      if (line !== undefined) {
        parts.push(notByFile(element) ? `${basenamePosix(fav.mark.file)}:${line + 1}` : String(line + 1));
      } else if (notByFile(element)) {
        parts.push(basenamePosix(fav.mark.file));
      }
      item.iconPath = new vscode.ThemeIcon(
        ICONS[fav.mark.kind] ?? 'symbol-misc',
        color ? new vscode.ThemeColor(color.theme) : fav.mark.note ? new vscode.ThemeColor(NOTE_COLOR) : undefined,
      );
    } else {
      parts.push(fav.status === 'missing' ? vscode.l10n.t('function not found') : vscode.l10n.t('file not found'));
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('disabledForeground'));
    }
    if (fav.mark.tags?.length && !byTag) {
      parts.push(`· ${fav.mark.tags.map((t) => `#${t}`).join(' ')}`);
    }
    item.description = parts.join(' ');
    const extra: string[] = [];
    if (fav.mark.tags?.length) {
      extra.push(fav.mark.tags.map((t) => `#${escapeMd(t)}`).join(' '));
    }
    if (fav.status !== 'ok') {
      extra.push(
        fav.status === 'missing'
          ? vscode.l10n.t('This function was not found in the file. It may have been renamed or deleted.')
          : vscode.l10n.t('The file does not exist.'),
      );
    }
    item.tooltip = this.tooltip(
      name,
      fav.mark.alias,
      fav.mark.path,
      fav.mark.file,
      line,
      extra,
      fav.mark.note,
      {
        uri: fav.uri,
        kind: fav.mark.kind,
      },
      fav.mark.addedAt,
    );
    // 與行號書籤共用右鍵選單（fbBookmark），:fn 表示函式書籤
    item.contextValue = `fbBookmark:fn${fav.mark.alias ? ':alias' : ''}${fav.mark.note ? ':note' : ''}:${fav.status}`;
    item.command = { command: COMMANDS.openFavorite, title: vscode.l10n.t('Go to symbol'), arguments: [fav] };
    return item;
  }
}

/** 書籤節點不在「依檔案分組」底下（依標籤、依來源）：描述要補上檔名。 */
function notByFile(element: BookmarkNode | FavoriteNode): boolean {
  return element.parent.type === 'bmGroup' && element.parent.by !== 'file';
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
