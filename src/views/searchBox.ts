import * as vscode from 'vscode';

const STATE_QUERY = 'searchQuery';
/** 輸入框開著時為 true：↓、Esc 的快捷鍵只在這時生效。 */
export const SEARCH_INPUT_CONTEXT = 'functionBookmarks.searchInputOpen';

export interface SearchBoxHandlers {
  /** 搜尋字串變了（打字時已 debounce）。 */
  onQuery(query: string): void;
  /** Enter：跳到第一個結果。 */
  onEnter(): void | Promise<void>;
  /** ↓：移到書籤清單。 */
  onDown(): void | Promise<void>;
}

/**
 * 書籤搜尋：側邊欄書籤清單的第一列顯示搜尋字串，點它（或按快捷鍵）在畫面上方開單行輸入框，
 * 打字時下方「書籤」區即時篩選。不另外開一個側邊欄檢視：多一個檢視就會多一條標題列，
 * 而且展開時至少 120px 高（VS Code 的限制），會留下一大塊空白。
 *
 * - Enter：跳到第一個結果；↓：移到書籤清單；Esc：清除搜尋並關閉
 * - 點到別的地方關閉輸入框時，搜尋字串保留
 * - 搜尋字串存在工作區狀態，重開編輯器後還在
 */
export class BookmarkSearchBox implements vscode.Disposable {
  private value: string;
  private input?: vscode.InputBox;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly handlers: SearchBoxHandlers,
  ) {
    this.value = memento.get<string>(STATE_QUERY, '');
  }

  get query(): string {
    return this.value;
  }

  /** 輸入框是否開著（測試用）。 */
  get isOpen(): boolean {
    return !!this.input;
  }

  dispose(): void {
    this.close();
  }

  /** 從程式設定搜尋字串（指令、測試）：輸入框開著時一起更新。 */
  setQuery(value: string): void {
    if (this.input && this.input.value !== value) {
      this.input.value = value;
    }
    this.flush(value);
  }

  /** 開啟輸入框（帶入目前的搜尋字串，游標放在最後）。 */
  open(): void {
    if (this.input) {
      this.input.show();
      return;
    }
    const input = vscode.window.createInputBox();
    this.input = input;
    input.value = this.value;
    input.valueSelection = [this.value.length, this.value.length];
    input.placeholder = vscode.l10n.t('Search bookmarks (#tag, @source)');
    input.prompt = vscode.l10n.t('Enter: open the first match · ↓: go to the list · Esc: clear the search');
    input.onDidChangeValue((v) => {
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(() => this.flush(v), 100);
    });
    input.onDidAccept(() => {
      this.flush(input.value);
      this.close();
      void this.handlers.onEnter();
    });
    input.onDidHide(() => {
      // 點到別的地方而關閉：保留搜尋字串
      if (this.input === input) {
        this.flush(input.value);
        this.close();
      }
    });
    void vscode.commands.executeCommand('setContext', SEARCH_INPUT_CONTEXT, true);
    input.show();
  }

  /** ↓：關閉輸入框，移到書籤清單的第一個結果。 */
  async toList(): Promise<void> {
    if (this.input) {
      this.flush(this.input.value);
      this.close();
    }
    await this.handlers.onDown();
  }

  /** Esc：清除搜尋並關閉輸入框。 */
  clearAndClose(): void {
    this.close();
    this.flush('');
  }

  /** 關閉輸入框（不改搜尋字串）。 */
  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const input = this.input;
    if (!input) {
      return;
    }
    this.input = undefined;
    void vscode.commands.executeCommand('setContext', SEARCH_INPUT_CONTEXT, false);
    input.hide();
    input.dispose();
  }

  private flush(value: string): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (value === this.value) {
      return;
    }
    this.value = value;
    void this.memento.update(STATE_QUERY, value);
    this.handlers.onQuery(value);
  }
}
