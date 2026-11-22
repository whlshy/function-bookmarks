import * as vscode from 'vscode';
import { readSettings, SECTION } from '../config';
import { DetectedSymbol } from '../detection/types';
import { SymbolService } from '../symbols/symbolService';
import { uriKey } from '../util/uris';

export interface RuleHit {
  ruleId: string;
  name: string;
  kind: string;
  nameLine: number;
  startLine: number;
  endLine: number;
}

/**
 * 「測試偵測規則」（M8）：在目前的檔案標示每條規則抓到哪些函式，方便調整自訂規則的正規表示式。
 * - 名稱底色標示、行尾顯示規則 id；滑鼠移上去顯示規則內容與範圍
 * - 函式的範圍在捲軸上標示
 * - 開啟後編輯或修改設定會自動更新；再執行一次（或執行「停止測試偵測規則」）關閉
 */
export class RuleTester implements vscode.Disposable {
  private readonly nameType: vscode.TextEditorDecorationType;
  private readonly bodyType: vscode.TextEditorDecorationType;
  private active: vscode.Uri | undefined;
  private hits: RuleHit[] = [];
  private timer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly service: SymbolService) {
    this.nameType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      borderRadius: '2px',
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 2em',
      },
    });
    this.bodyType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: '#E5C10080',
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      borderColor: new vscode.ThemeColor('editorIndentGuide.activeBackground'),
      borderStyle: 'none none none solid',
      borderWidth: '0 0 0 2px',
    });
    this.disposables.push(
      this.nameType,
      this.bodyType,
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.active && uriKey(e.document.uri) === uriKey(this.active) && e.contentChanges.length) {
          this.schedule();
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule(0)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (this.active && e.affectsConfiguration(SECTION)) {
          this.schedule(0);
        }
      }),
    );
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }

  /** 給測試用：目前標示的結果。 */
  get results(): RuleHit[] {
    return this.hits;
  }

  get testing(): vscode.Uri | undefined {
    return this.active;
  }

  /** 開始（或在同一個檔案再執行一次時停止）。`keep` 為 true 時一律開始。 */
  async toggle(keep = false): Promise<RuleHit[] | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Open a file to test the detection rules on.'));
      return undefined;
    }
    if (!keep && this.active && uriKey(this.active) === uriKey(editor.document.uri)) {
      this.stop();
      return undefined;
    }
    this.active = editor.document.uri;
    await vscode.commands.executeCommand('setContext', 'functionBookmarks.testingRules', true);
    const hits = await this.update();
    const file = await this.service.getSymbols(editor.document);
    const counts = new Map<string, number>();
    for (const h of hits) {
      counts.set(h.ruleId, (counts.get(h.ruleId) ?? 0) + 1);
    }
    const summary = [...counts.entries()].map(([id, n]) => `${id} ×${n}`).join(', ');
    const how =
      file.source === 'languageServer'
        ? vscode.l10n.t('No rule applies to this file; the functions come from the language server.')
        : file.source === 'none'
          ? vscode.l10n.t('No rule applies to this file (language: {0}).', editor.document.languageId)
          : '';
    const errors = file.errors.map((e) => `${e.ruleId}: ${e.message}`).join('; ');
    const msg = [
      hits.length ? vscode.l10n.t('Found {0} item(s): {1}.', hits.length, summary) : vscode.l10n.t('Nothing found.'),
      how,
      errors ? vscode.l10n.t('Invalid rules: {0}', errors) : '',
      vscode.l10n.t('Run the command again to stop.'),
    ]
      .filter(Boolean)
      .join(' ');
    const settings = vscode.l10n.t('Open Settings');
    void (errors ? vscode.window.showWarningMessage(msg, settings) : vscode.window.showInformationMessage(msg, settings)).then((pick) => {
      if (pick === settings) {
        void vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.detection`);
      }
    });
    return hits;
  }

  stop(): void {
    this.active = undefined;
    this.hits = [];
    void vscode.commands.executeCommand('setContext', 'functionBookmarks.testingRules', false);
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.nameType, []);
      editor.setDecorations(this.bodyType, []);
    }
  }

  private schedule(delay = 300): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.update(), delay);
  }

  async update(): Promise<RuleHit[]> {
    const target = this.active;
    if (!target) {
      return [];
    }
    const editor = vscode.window.visibleTextEditors.find((e) => uriKey(e.document.uri) === uriKey(target));
    if (!editor) {
      return this.hits;
    }
    this.service.invalidate(target);
    const file = await this.service.getSymbols(editor.document);
    const rules = new Map(readSettings(target).rules.map((r) => [r.id, r]));
    const names: vscode.DecorationOptions[] = [];
    const bodies: vscode.DecorationOptions[] = [];
    const hits: RuleHit[] = [];
    const walk = (list: DetectedSymbol[]) => {
      for (const s of list) {
        hits.push({ ruleId: s.ruleId, name: s.name, kind: s.kind, nameLine: s.nameLine, startLine: s.startLine, endLine: s.endLine });
        const rule = rules.get(s.ruleId);
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${vscode.l10n.t('Rule')}: \`${s.ruleId}\`**${rule?.label ? ` — ${rule.label}` : ''}\n\n`);
        md.appendMarkdown(`${vscode.l10n.t('Name')}: \`${s.name}\` · ${s.kind} · \`${s.path}\`\n\n`);
        md.appendMarkdown(vscode.l10n.t('Range: lines {0}–{1}', s.startLine + 1, s.endLine + 1));
        if (rule) {
          md.appendMarkdown(`\n\nbody: \`${rule.body}\`${rule.end ? ` · end: \`${rule.end}\`` : ''}`);
          md.appendCodeblock(rule.pattern, 'regex');
        } else if (s.ruleId) {
          md.appendMarkdown(`\n\n${vscode.l10n.t('From the language server.')}`);
        }
        names.push({
          range: new vscode.Range(s.nameLine, s.nameStartCol, s.nameLine, Math.max(s.nameEndCol, s.nameStartCol)),
          hoverMessage: md,
          renderOptions: { after: { contentText: `⟵ ${s.ruleId}` } },
        });
        if (s.endLine > s.startLine) {
          bodies.push({ range: new vscode.Range(s.startLine, 0, s.endLine, 0) });
        }
        walk(s.children);
      }
    };
    walk(file.symbols);
    editor.setDecorations(this.nameType, names);
    editor.setDecorations(this.bodyType, bodies);
    this.hits = hits;
    return hits;
  }
}
