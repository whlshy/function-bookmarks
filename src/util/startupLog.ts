import * as vscode from 'vscode';

export interface StartupTiming {
  phase: string;
  ms: number;
  atMs: number;
}

/**
 * 輕量的啟動計時紀錄：只在啟動與啟動背景工作完成時寫幾行到 Output channel，
 * 平常操作不輸出，方便排查開啟專案時的啟動耗時。
 */
export class StartupLog implements vscode.Disposable {
  private readonly t0 = performance.now();
  private readonly channel: vscode.OutputChannel;
  readonly timings: StartupTiming[] = [];

  constructor() {
    this.channel = vscode.window.createOutputChannel('Function Bookmarks');
  }

  dispose(): void {
    this.channel.dispose();
  }

  /** 記錄某個階段的耗時（毫秒）。 */
  record(phase: string, ms: number): void {
    const rounded = Math.round(ms);
    const atMs = Math.round(performance.now() - this.t0);
    this.timings.push({ phase, ms: rounded, atMs });
    this.channel.appendLine(`[startup] ${phase}: ${rounded}ms (at +${atMs}ms)`);
  }

  /** 量測同步或非同步階段並記錄耗時。 */
  async measure<T>(phase: string, fn: () => Promise<T> | T): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.record(phase, performance.now() - start);
    }
  }

  /** 寫入一行單純的啟動說明（不重複刷）。 */
  info(message: string): void {
    const atMs = Math.round(performance.now() - this.t0);
    this.channel.appendLine(`[startup] ${message} (at +${atMs}ms)`);
  }

  /** 從啟動開始至今的毫秒數。 */
  elapsed(): number {
    return Math.round(performance.now() - this.t0);
  }
}
