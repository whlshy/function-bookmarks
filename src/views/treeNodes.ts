/** 側邊欄樹狀檢視的節點型別與共用常數。 */
import * as vscode from 'vscode';
import { BookmarkItem } from '../bookmarks/unified';
import { OverrideInfo } from '../django/resolver';
import { DetectedSymbol, SymbolKindName } from '../detection/types';
import { BookmarkEntry } from '../storage/store';
import { ResolvedFavorite } from '../symbols/favorites';
import { DirTree } from '../symbols/projectTree';

export type SectionId = 'bookmarks' | 'currentFile' | 'project';
export type FilterMode = 'all' | 'bookmarks';
export type BookmarkGrouping = 'file' | 'tag' | 'source';

export interface SectionNode {
  type: 'section';
  section: SectionId;
}
/** 清單最上面的搜尋列：顯示目前的搜尋字串，點一下開啟輸入框。 */
export interface SearchNode {
  type: 'search';
}
/** 函式書籤（原本的收藏）。 */
export interface FavoriteNode {
  type: 'favorite';
  fav: ResolvedFavorite;
  parent: SectionNode | BmGroupNode;
}
export interface SymbolNode {
  type: 'symbol';
  scope: 'current' | 'project';
  uri: vscode.Uri;
  symbol: DetectedSymbol;
  parent: TreeNode;
  children: SymbolNode[];
  id: string;
  override?: OverrideInfo;
}
export interface WsFolderNode {
  type: 'wsFolder';
  folder: vscode.WorkspaceFolder;
  parent: SectionNode;
}
export interface DirNode {
  type: 'dir';
  folder: vscode.WorkspaceFolder;
  dir: DirTree;
  parent: TreeNode;
}
export interface FileNode {
  type: 'file';
  folder: vscode.WorkspaceFolder;
  uri: vscode.Uri;
  rel: string;
  parent: TreeNode;
}
export interface BmGroupNode {
  type: 'bmGroup';
  /** 依檔案分組時為檔案 uri；依標籤分組時為標籤（沒有標籤為空字串）；依來源分組時為來源（自己的為空字串）。 */
  key: string;
  by: BookmarkGrouping;
  uri?: vscode.Uri;
  rel?: string;
  folder?: vscode.WorkspaceFolder;
  items: BookmarkItem[];
  parent: SectionNode;
}
export interface BookmarkNode {
  type: 'bookmark';
  entry: BookmarkEntry;
  parent: SectionNode | BmGroupNode;
}
export type TreeNode =
  | SearchNode
  | SectionNode
  | FavoriteNode
  | BmGroupNode
  | BookmarkNode
  | SymbolNode
  | WsFolderNode
  | DirNode
  | FileNode;

export const ICONS: Record<SymbolKindName, string> = {
  function: 'symbol-function',
  method: 'symbol-method',
  class: 'symbol-class',
  block: 'symbol-namespace',
  partial: 'symbol-snippet',
  macro: 'symbol-method',
  event: 'symbol-event',
  request: 'cloud',
  heading: 'symbol-key',
  reference: 'go-to-file',
};

export const REFERENCE_KEYWORD: Record<string, string> = {
  'dj-extends': 'extends',
  'dj-include': 'include',
};

/** 有備註的函式，名稱前的圖示改用這個顏色（不另外加圖示，避免擠）。 */
export const NOTE_COLOR = 'charts.blue';
/** 別人的書籤（匯入的）的顏色。 */
export const FOREIGN_COLOR = 'charts.purple';

/** 書籤總數超過此門檻，或分組數達 AUTO_COLLAPSE_GROUPS 時，非搜尋狀態預設收合各分組，避免把「目前檔案」擠到最下面。 */
export const AUTO_COLLAPSE_BOOKMARKS = 30;
export const AUTO_COLLAPSE_GROUPS = 6;

export const COMMANDS = {
  revealLine: 'functionBookmarks.revealLine',
  reveal: 'functionBookmarks.revealSymbol',
  openFavorite: 'functionBookmarks.openFavorite',
  openTemplate: 'functionBookmarks.openTemplate',
};

export function displayName(name: string, alias: string | undefined): string {
  return alias ?? name;
}
