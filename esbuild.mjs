import * as esbuild from 'esbuild';
import * as fs from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Markdown 預覽用的 Mermaid（media/mermaid-preview.js 在頁面有 Mermaid 區塊時才載入）
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('node_modules/mermaid/dist/mermaid.min.js', 'dist/mermaid.min.js');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
