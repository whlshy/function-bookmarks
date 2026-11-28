/**
 * CLI 進入點（打包成 dist/cli.js，套件的「設定 AI 助理」會複製到專案的 skills 資料夾）。
 * 用法：node fb.js <command> …（見 run.ts 的 USAGE）
 */
import { rootFromScriptPath } from './project';
import { run } from './run';

void run(process.argv.slice(2), {
  cwd: process.cwd(),
  root: rootFromScriptPath(process.argv[1]),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
}).then((code) => {
  process.exitCode = code;
});
