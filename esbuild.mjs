import * as esbuild from 'esbuild';
import * as fs from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Markdown 預覽用的 Mermaid（media/mermaid-preview.js 在頁面有 Mermaid 區塊時才載入）
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('node_modules/mermaid/dist/mermaid.min.js', 'dist/mermaid.min.js');

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
  // 給 AI 助理用的 CLI：不依賴編輯器，「設定 AI 助理」時複製到專案的 skills 資料夾
  esbuild.context({ ...common, entryPoints: ['src/cli/main.ts'], outfile: 'dist/cli.js', sourcemap: false }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
