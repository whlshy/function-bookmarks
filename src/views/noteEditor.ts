import * as path from 'path';
import * as vscode from 'vscode';
import { SECTION } from '../config';
import { MarkKey } from '../storage/marks';
import { uriKey } from '../util/uris';

interface Session {
  id: string;
  uri: vscode.Uri;
  gen: number;
  apply: (text: string) => Promise<void>;
}

export interface NoteTarget {
  /** 用來產生暫存檔名，同一個對象每次相同（例如函式的路徑、書籤 id）。 */
  id: string;
  /** 顯示在分頁標題，例如自訂名稱或函式名稱。 */
  title: string;
  /** 狀態列提示中的對象名稱。 */
  subject: string;
  current?: string;
  /** 存檔時呼叫，把內容寫回書籤資料（空字串代表刪除備註）。 */
  apply: (text: string) => Promise<void>;
}

export const PREVIEW_NOTE_COMMAND = 'functionBookmarks.previewNote';

/**
 * 備註一律用內建的 Markdown 預覽（會跟編輯器同步捲動；Mermaid 由本套件的外掛繪製）。
 * Cursor 會用自己的 Markdown 編輯器接管 .md，所以在 Cursor 裡編輯檔改用 .markdown，維持一般文字編輯。
 */
const IS_CURSOR = /cursor/i.test(vscode.env.appName);

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).slice(0, 6);
}

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60) || 'note';
}

/** 「在預覽中開啟」連結：放進滑鼠提示的 Markdown（需設定 isTrusted 允許這個指令）。 */
export function previewNoteLink(uri: vscode.Uri, key: Pick<MarkKey, 'path' | 'kind'>): string {
  const args = encodeURIComponent(JSON.stringify([{ uri: uri.toString(), path: key.path, kind: key.kind }]));
  return `[$(open-preview) ${vscode.l10n.t('Open in preview')}](command:${PREVIEW_NOTE_COMMAND}?${args})`;
}

/** 書籤備註的「在預覽中開啟」連結。 */
export function bookmarkPreviewLink(uri: vscode.Uri, bookmarkId: string): string {
  const args = encodeURIComponent(JSON.stringify([{ uri: uri.toString(), bookmark: bookmarkId }]));
  return `[$(open-preview) ${vscode.l10n.t('Open in preview')}](command:${PREVIEW_NOTE_COMMAND}?${args})`;
}

/** 允許提示中的「在預覽中開啟」連結。 */
export function trustPreviewLink(md: vscode.MarkdownString): vscode.MarkdownString {
  md.isTrusted = { enabledCommands: [PREVIEW_NOTE_COMMAND] };
  md.supportThemeIcons = true;
  return md;
}

/** 這個分頁是不是某個 Markdown 檔的內建預覽。 */
export function isMarkdownPreviewTab(tab: vscode.Tab, uri: vscode.Uri): boolean {
  return (
    tab.input instanceof vscode.TabInputWebview &&
    tab.input.viewType.includes('markdown.preview') &&
    tab.label.includes(path.posix.basename(uri.path))
  );
}

/** 依作業系統回傳存檔快捷鍵文字，用於備註編輯的狀態列提示。 */
export function saveShortcut(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'Cmd+S' : 'Ctrl+S';
}

/**
 * 備註編輯分頁：把備註寫進暫存的 Markdown 檔開啟，右側並排內建的 Markdown 預覽；
 * 存檔時寫回書籤資料並關閉編輯與預覽分頁。清空後存檔即刪除備註；不存檔直接關閉則不變更。
 */
export class NoteEditor implements vscode.Disposable {
  private sessions = new Map<string, Session>();
  /** 依 uriKey 序列化 open() 與 finish()，避免舊的收尾刪掉剛重開的暫存檔。 */
  private locks = new Map<string, Promise<void>>();
  private seq = 0;
  private disposables: vscode.Disposable[] = [];
  /** 啟動時背景清理殘留暫存檔；建立新暫存檔前先等清理完成，避免刪到剛建的檔。 */
  readonly cleanup: Promise<void>;

  constructor(private readonly storageUri: vscode.Uri) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => void this.onSave(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => void this.onClose(doc)),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.onTabsChanged(e)),
    );
    // 清理上次異常關閉留下的預覽與編輯暫存檔
    this.cleanup = Promise.all([
      vscode.workspace.fs.delete(vscode.Uri.joinPath(storageUri, 'previews'), { recursive: true }).then(undefined, () => undefined),
      vscode.workspace.fs.delete(vscode.Uri.joinPath(storageUri, 'notes'), { recursive: true }).then(undefined, () => undefined),
    ]).then(() => undefined);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /** 給測試用：某個暫存檔是不是備註分頁。 */
  isNoteDocument(uri: vscode.Uri): boolean {
    return this.sessions.has(uriKey(uri));
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const result = prev.catch(() => undefined).then(fn);
    const done = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, done);
    void done.finally(() => {
      if (this.locks.get(key) === done) {
        this.locks.delete(key);
      }
    });
    return result;
  }

  private hasOpenTab(uri: vscode.Uri): boolean {
    const key = uriKey(uri);
    return vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .some((t) => t.input instanceof vscode.TabInputText && uriKey(t.input.uri) === key);
  }

  private findSessionById(targetId: string): [string, Session] | undefined {
    for (const entry of this.sessions) {
      if (entry[1].id === targetId) {
        return entry;
      }
    }
    return undefined;
  }

  async open(target: NoteTarget): Promise<vscode.TextEditor> {
    await this.cleanup;
    const dir = vscode.Uri.joinPath(this.storageUri, 'notes');
    const id = hash(target.id);
    const defaultUri = vscode.Uri.joinPath(
      dir,
      `${vscode.l10n.t('Note')} - ${safeName(target.title)} (${id}).${IS_CURSOR ? 'markdown' : 'md'}`,
    );
    const defaultKey = uriKey(defaultUri);

    // 若同一個目標（target.id）目前已有開啟中的分頁（即使標題在開啟期間改過），沿用原分頁的鎖與路徑
    // 不在鎖外修改 sessions 或呼叫 finish，避免並發 open() 彼此清掉剛建立的 session
    const existingById = this.findSessionById(target.id);
    const lockKey = existingById && this.hasOpenTab(existingById[1].uri) ? existingById[0] : defaultKey;

    return this.serialize(lockKey, async () => {
      let uri = defaultUri;
      let reusingOpenTab = false;
      const active = this.findSessionById(target.id);
      if (active && this.hasOpenTab(active[1].uri)) {
        // 確實還開著同一個備註分頁：直接切過去，不覆蓋尚未存檔的內容
        active[1].apply = target.apply;
        uri = active[1].uri;
        reusingOpenTab = true;
      } else {
        if (active) {
          this.sessions.delete(active[0]);
          if (active[0] === lockKey) {
            await this.closeTabs(active[1].uri);
          } else {
            // 標題改過使檔名不同：背景清掉舊的暫存檔與預覽分頁
            void this.finish(active[1].uri);
          }
        }
        await vscode.workspace.fs.createDirectory(dir);
        const desired = target.current ?? '';
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(desired));
        const gen = ++this.seq;
        this.sessions.set(uriKey(uri), { id: target.id, uri, gen, apply: target.apply });
        let editor: vscode.TextEditor;
        try {
          editor = await vscode.window.showTextDocument(uri, { preview: false });
        } catch (err) {
          if (this.sessions.get(uriKey(uri))?.gen === gen) {
            this.sessions.delete(uriKey(uri));
          }
          throw err;
        }
        // VS Code 可能尚未釋放上次關閉的 TextDocument 緩衝區；若內容或髒狀態不同步，強制自磁碟重載
        const norm = (s: string) => s.replace(/\r\n/g, '\n');
        if (editor.document.isDirty || norm(editor.document.getText()) !== norm(desired)) {
          await vscode.commands.executeCommand('workbench.action.files.revert').then(undefined, () => undefined);
        }
        editor = await this.ensurePreviewAndFocus(editor, uri);
        this.showStatusHint(target.subject);
        return editor;
      }

      let editor = await vscode.window.showTextDocument(uri, { preview: false });
      editor = await this.ensurePreviewAndFocus(editor, uri);
      if (reusingOpenTab) {
        this.showStatusHint(target.subject);
      }
      return editor;
    });
  }

  private async ensurePreviewAndFocus(editor: vscode.TextEditor, uri: vscode.Uri): Promise<vscode.TextEditor> {
    // 右側並排內建預覽（會跟著捲動），之後把焦點還給編輯分頁
    const hasPreview = vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => isMarkdownPreviewTab(t, uri));
    if (!hasPreview) {
      await vscode.commands.executeCommand('markdown.showPreviewToSide', uri).then(undefined, () => undefined);
      await this.waitForPreviewTab(uri);
      return vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preview: false });
    }
    return editor;
  }

  /** 等待內建 Markdown 預覽分頁出現在 tabGroups（避免 Cursor 預覽非同步打開時晚一步搶走焦點）。 */
  private waitForPreviewTab(uri: vscode.Uri, timeoutMs = 250): Promise<void> {
    const has = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => isMarkdownPreviewTab(t, uri));
    if (has()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        sub.dispose();
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const sub = vscode.window.tabGroups.onDidChangeTabs(() => {
        if (has()) {
          done();
        }
      });
    });
  }

  private showStatusHint(subject: string): void {
    const closeOnSave = this.closeOnSave();
    vscode.window.setStatusBarMessage(
      closeOnSave
        ? vscode.l10n.t('Editing note for {0} — save ({1}) to apply and close; save empty to delete', subject, saveShortcut())
        : vscode.l10n.t('Editing note for {0} — save ({1}) to apply; save empty to delete', subject, saveShortcut()),
      8000,
    );
  }

  private closeOnSave(): boolean {
    return vscode.workspace.getConfiguration(SECTION).get<boolean>('notes.closeOnSave', true);
  }

  /** 用內建的 Markdown 預覽分頁查看備註（圖片、表格、程式碼高亮都能完整顯示）。 */
  async preview(title: string, subtitle: string, note: string): Promise<vscode.Uri> {
    await this.cleanup;
    const dir = vscode.Uri.joinPath(this.storageUri, 'previews');
    await vscode.workspace.fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, `${vscode.l10n.t('Note')} - ${safeName(title)} (${hash(subtitle)}).md`);
    const content = `# ${title}\n\n${subtitle}\n\n---\n\n${note}\n`;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    await vscode.commands.executeCommand('markdown.showPreview', uri);
    return uri;
  }

  private async onSave(doc: vscode.TextDocument): Promise<void> {
    const key = uriKey(doc.uri);
    const session = this.sessions.get(key);
    if (!session) {
      return;
    }
    if (this.closeOnSave()) {
      // 在同一個 serialize 區段完成 apply、關閉分頁與刪檔，避免存檔途中馬上重開時誤關新開的分頁
      await this.serialize(key, async () => {
        if (this.sessions.get(key)?.gen !== session.gen) {
          return;
        }
        await session.apply(doc.getText());
        if (this.sessions.get(key)?.gen !== session.gen) {
          return;
        }
        this.sessions.delete(key);
        await this.finishUnlocked(doc.uri, key);
      });
    } else {
      await session.apply(doc.getText());
      if (this.sessions.get(key)?.gen === session.gen) {
        vscode.window.setStatusBarMessage(vscode.l10n.t('Note saved.'), 2000);
      }
    }
  }

  private async onClose(doc: vscode.TextDocument): Promise<void> {
    const key = uriKey(doc.uri);
    const session = this.sessions.get(key);
    if (session && !this.hasOpenTab(doc.uri)) {
      this.sessions.delete(key);
      await this.finish(doc.uri);
    }
  }

  /** 使用者手動關閉備註編輯分頁時，立刻收掉 session、並排預覽與暫存檔（不必等 VS Code 延遲釋放 TextDocument）。 */
  private onTabsChanged(e: vscode.TabChangeEvent): void {
    for (const tab of e.closed) {
      if (!(tab.input instanceof vscode.TabInputText)) {
        continue;
      }
      const uri = tab.input.uri;
      const key = uriKey(uri);
      if (!this.sessions.has(key) || this.hasOpenTab(uri)) {
        continue;
      }
      this.sessions.delete(key);
      void this.finish(uri);
    }
  }

  /** 關閉編輯與預覽分頁，刪除暫存檔（與 open() 序列化；若已開出新 session 則中止，絕不刪到新檔）。 */
  private finish(uri: vscode.Uri): Promise<void> {
    const key = uriKey(uri);
    return this.serialize(key, () => this.finishUnlocked(uri, key));
  }

  /** 已持有該 key 的 serialize 鎖時執行收尾；若期間已開出新 session 則中止。 */
  private async finishUnlocked(uri: vscode.Uri, key: string): Promise<void> {
    if (this.sessions.has(key)) {
      return;
    }
    await this.closeTabs(uri);
    if (this.sessions.has(key)) {
      return;
    }
    await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
  }

  /** 關閉備註的編輯分頁與並排的預覽分頁。 */
  private async closeTabs(uri: vscode.Uri): Promise<void> {
    const key = uriKey(uri);
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => (t.input instanceof vscode.TabInputText && uriKey(t.input.uri) === key) || isMarkdownPreviewTab(t, uri));
    if (tabs.length) {
      await vscode.window.tabGroups.close(tabs, true);
    }
  }
}
