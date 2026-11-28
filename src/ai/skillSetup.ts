/**
 * 設定 AI 助理：把 Skill 說明書（SKILL.md）與 CLI（fb.js）放進專案的 skills 資料夾，
 * 讓 Cursor、Claude Code 等 AI 助理能查詢與新增書籤。套件升級時自動更新已設定的副本。
 */
import * as vscode from 'vscode';
import { ensureBookmarksFileExcluded } from '../storage/gitExcludeFs';

/** 各 AI 助理讀取 skills 的資料夾（相對專案根目錄）。Cursor 三個都會讀。 */
export const SKILL_TARGETS = [
  { id: 'cursor', dir: '.cursor/skills/function-bookmarks', label: 'Cursor' },
  { id: 'claude', dir: '.claude/skills/function-bookmarks', label: 'Claude Code' },
  { id: 'agents', dir: '.agents/skills/function-bookmarks', label: 'Codex / other agents (.agents)' },
] as const;

export type SkillTargetId = (typeof SKILL_TARGETS)[number]['id'];

const CLI_NAME = 'scripts/fb.js';

/** 產生 SKILL.md：填入 CLI 的執行方式與版本。 */
export function renderSkill(template: string, skillDir: string, version: string): string {
  return template.replace(/\{\{CLI\}\}/g, `node ${skillDir}/${CLI_NAME}`).replace(/\{\{VERSION\}\}/g, version);
}

async function readBytes(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return !!a && a.length === b.length && a.every((v, i) => v === b[i]);
}

export class SkillSetup {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get version(): string {
    return String((this.context.extension.packageJSON as { version?: string }).version ?? '');
  }

  private async bundled(skillDir: string): Promise<{ skill: Uint8Array; cli: Uint8Array }> {
    const root = this.context.extensionUri;
    const template = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'media', 'skill', 'SKILL.md')));
    return {
      skill: new TextEncoder().encode(renderSkill(template, skillDir, this.version)),
      cli: await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'dist', 'cli.js')),
    };
  }

  /** 寫入一個資料夾的 Skill；內容相同時不動。回傳是否有寫入。 */
  async install(folder: vscode.WorkspaceFolder, skillDir: string): Promise<boolean> {
    const files = await this.bundled(skillDir);
    const base = vscode.Uri.joinPath(folder.uri, ...skillDir.split('/'));
    let wrote = false;
    for (const [rel, bytes] of [
      ['SKILL.md', files.skill],
      [CLI_NAME, files.cli],
    ] as const) {
      const uri = vscode.Uri.joinPath(base, ...rel.split('/'));
      if (sameBytes(await readBytes(uri), bytes)) {
        continue;
      }
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, bytes);
      wrote = true;
    }
    return wrote;
  }

  /** 已設定過的 Skill 跟著套件版本更新（只更新已經存在的，不會自己建立）。 */
  async refreshInstalled(): Promise<number> {
    let updated = 0;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const t of SKILL_TARGETS) {
        const marker = vscode.Uri.joinPath(folder.uri, ...t.dir.split('/'), ...CLI_NAME.split('/'));
        if ((await readBytes(marker)) && (await this.install(folder, t.dir).catch(() => false))) {
          updated++;
        }
      }
    }
    return updated;
  }

  /** 指令「設定 AI 助理 Skill…」：選資料夾與 AI 助理後寫入。 */
  async run(options: { folder?: vscode.WorkspaceFolder; target?: SkillTargetId } = {}): Promise<{ folder: vscode.WorkspaceFolder; dir: string } | undefined> {
    const folder =
      options.folder ??
      ((vscode.workspace.workspaceFolders ?? []).length > 1
        ? await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('Set up the AI assistant skill for which folder?') })
        : vscode.workspace.workspaceFolders?.[0]);
    if (!folder) {
      return undefined;
    }
    let target = SKILL_TARGETS.find((t) => t.id === options.target);
    if (!target) {
      const isCursor = /cursor/i.test(vscode.env.appName);
      const ordered = isCursor ? SKILL_TARGETS : [SKILL_TARGETS[1], SKILL_TARGETS[0], SKILL_TARGETS[2]];
      const pick = await vscode.window.showQuickPick(
        ordered.map((t, i) => ({
          label: t.label,
          description: t.dir,
          detail: i === 0 ? vscode.l10n.t('Recommended') : undefined,
          target: t,
        })),
        {
          title: vscode.l10n.t('Set Up AI Assistant Skill'),
          placeHolder: vscode.l10n.t('Which AI assistant do you use? Cursor also reads the other two folders.'),
        },
      );
      if (!pick) {
        return undefined;
      }
      target = pick.target;
    }
    await this.install(folder, target.dir);
    // 預設只給自己用（與書籤檔相同）：加進 .git/info/exclude；要分享給團隊可自行從 exclude 移除後提交
    await ensureBookmarksFileExcluded(folder.uri, target.dir).catch(() => undefined);
    const open = vscode.l10n.t('Open SKILL.md');
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t(
          'The AI assistant can now read and add bookmarks: {0}. It runs with Node.js. The folder is only on your computer (added to .git/info/exclude).',
          target.dir,
        ),
        open,
      )
      .then((choice) => {
        if (choice === open) {
          void vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, ...target!.dir.split('/'), 'SKILL.md'));
        }
      });
    return { folder, dir: target.dir };
  }
}
