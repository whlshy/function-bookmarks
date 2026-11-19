import * as path from 'path';
import * as vscode from 'vscode';
import { MarkKey } from '../storage/marks';
import { uriKey } from '../util/uris';

interface Session {
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

/**
 * 備註編輯分頁：把備註寫進暫存的 Markdown 檔開啟，右側並排內建的 Markdown 預覽；
 * 存檔時寫回書籤資料並關閉編輯與預覽分頁。清空後存檔即刪除備註；不存檔直接關閉則不變更。
 */
export class NoteEditor implements vscode.Disposable {
  private sessions = new Map<string, Session>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly storageUri: vscode.Uri) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => void this.onSave(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => void this.onClose(doc)),
    );
    // 上次留下的預覽暫存檔
    void vscode.workspace.fs.delete(vscode.Uri.joinPath(storageUri, 'previews'), { recursive: true }).then(undefined, () => undefined);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /** 給測試用：某個暫存檔是不是備註分頁。 */
  isNoteDocument(uri: vscode.Uri): boolean {
    return this.sessions.has(uriKey(uri));
  }

  async open(target: NoteTarget): Promise<vscode.TextEditor> {
    const dir = vscode.Uri.joinPath(this.storageUri, 'notes');
    await vscode.workspace.fs.createDirectory(dir);
    const id = hash(target.id);
    const uri = vscode.Uri.joinPath(dir, `${vscode.l10n.t('Note')} - ${safeName(target.title)} (${id}).${IS_CURSOR ? 'markdown' : 'md'}`);
    // 已經開著同一個備註就直接切過去，不覆蓋尚未存檔的內容
    const existing = vscode.workspace.textDocuments.find((d) => uriKey(d.uri) === uriKey(uri));
    if (!existing) {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(target.current ?? ''));
    }
    this.sessions.set(uriKey(uri), { apply: target.apply });
    let editor = await vscode.window.showTextDocument(uri, { preview: false });
    // 右側並排內建預覽（會跟著捲動），之後把焦點還給編輯分頁
    const hasPreview = vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => isMarkdownPreviewTab(t, uri));
    if (!hasPreview) {
      await vscode.commands.executeCommand('markdown.showPreviewToSide', uri).then(undefined, () => undefined);
      editor = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preview: false });
    }
    vscode.window.setStatusBarMessage(
      vscode.l10n.t('Editing note for {0} — save (Ctrl+S) to apply and close; save empty to delete', target.subject),
      8000,
    );
    return editor;
  }

  /** 用內建的 Markdown 預覽分頁查看備註（圖片、表格、程式碼高亮都能完整顯示）。 */
  async preview(title: string, subtitle: string, note: string): Promise<vscode.Uri> {
    const dir = vscode.Uri.joinPath(this.storageUri, 'previews');
    await vscode.workspace.fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, `${vscode.l10n.t('Note')} - ${safeName(title)} (${hash(subtitle)}).md`);
    const content = `# ${title}\n\n${subtitle}\n\n---\n\n${note}\n`;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    await vscode.commands.executeCommand('markdown.showPreview', uri);
    return uri;
  }

  private async onSave(doc: vscode.TextDocument): Promise<void> {
    const session = this.sessions.get(uriKey(doc.uri));
    if (!session) {
      return;
    }
    await session.apply(doc.getText());
    this.sessions.delete(uriKey(doc.uri));
    await this.finish(doc.uri);
  }

  private async onClose(doc: vscode.TextDocument): Promise<void> {
    const session = this.sessions.get(uriKey(doc.uri));
    if (session) {
      this.sessions.delete(uriKey(doc.uri));
      await this.finish(doc.uri);
    }
  }

  /** 關閉編輯與預覽分頁，刪除暫存檔。 */
  private async finish(uri: vscode.Uri): Promise<void> {
    await this.closeTabs(uri);
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
