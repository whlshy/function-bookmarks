// 產生側邊欄的圖示字型 media/function-bookmarks-icons.woff（字型圖示在 Cursor／VS Code 工具列的亮度才會和內建圖示一致）。
// 1. 把 media/activity-bar.svg 以 1024×1024 白底黑線畫成 PNG（例如用瀏覽器無頭模式截圖）
// 2. npm i --no-save potrace svgpath svg2ttf ttf2woff
// 3. node scripts/build-icon-font.js <放 glyph.png 的資料夾> media/function-bookmarks-icons.woff <預覽 svg>
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');
const [, , S, outWoff, outSvg] = process.argv;
const req = createRequire(path.join(process.cwd(), 'package.json'));
const potrace = req('potrace');
const svgpath = req('svgpath');
const svg2ttf = req('svg2ttf');
const ttf2woff = req('ttf2woff');

/** 拆成子路徑（只有 M、L、C、Z，絕對座標），依包含層數決定方向。 */
function fixWinding(d) {
  const tokens = d.match(/[MLCZ]|-?[\d.]+(?:e-?\d+)?/gi);
  const subs = [];
  let cur;
  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  let last = '';
  while (i < tokens.length) {
    let c = tokens[i++];
    if (/^-?[\d.]/.test(c)) {
      // 省略指令字母：沿用上一個（M 之後的座標視為 L）
      i--;
      c = last === 'M' ? 'L' : last;
    }
    last = c;
    if (c === 'M') {
      cur = { start: [num(), num()], segs: [] };
      subs.push(cur);
    } else if (c === 'L') {
      cur.segs.push({ t: 'L', p: [num(), num()] });
    } else if (c === 'C') {
      cur.segs.push({ t: 'C', c1: [num(), num()], c2: [num(), num()], p: [num(), num()] });
    } else if (c === 'Z' || c === 'z') {
      // 結束
    } else {
      throw new Error('unexpected ' + c);
    }
  }
  const pts = (s) => [s.start, ...s.segs.map((g) => g.p)];
  const area = (s) => {
    const p = pts(s);
    let a = 0;
    for (let k = 0; k < p.length; k++) {
      const [x1, y1] = p[k];
      const [x2, y2] = p[(k + 1) % p.length];
      a += x1 * y2 - x2 * y1;
    }
    return a / 2;
  };
  const bbox = (s) => {
    const p = pts(s);
    const xs = p.map((q) => q[0]);
    const ys = p.map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const boxes = subs.map(bbox);
  const inside = (a, b) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];
  const depth = subs.map((_, k) => boxes.filter((b, j) => j !== k && inside(boxes[k], b)).length);
  const outerSign = Math.sign(area(subs[depth.indexOf(0)]));
  const reverse = (s) => {
    const p = pts(s);
    const segs = [];
    for (let k = s.segs.length - 1; k >= 0; k--) {
      const g = s.segs[k];
      const to = p[k];
      segs.push(g.t === 'L' ? { t: 'L', p: to } : { t: 'C', c1: g.c2, c2: g.c1, p: to });
    }
    return { start: p[p.length - 1], segs };
  };
  const out = subs.map((s, k) => {
    const want = depth[k] % 2 === 0 ? outerSign : -outerSign;
    return Math.sign(area(s)) === want ? s : reverse(s);
  });
  return out
    .map((s) => `M${s.start.join(' ')}` + s.segs.map((g) => (g.t === 'L' ? `L${g.p.join(' ')}` : `C${[...g.c1, ...g.c2, ...g.p].join(' ')}`)).join('') + 'Z')
    .join('');
}

potrace.trace(path.join(S, 'glyph.png'), { threshold: 128, turdSize: 20, optTolerance: 0.4 }, (err, svg) => {
  if (err) throw err;
  const d = [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]).join(' ');
  if (!d) throw new Error('no path');
  // 預覽用（y 向下，1024 格）
  fs.writeFileSync(outSvg, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><path d="${d}" fill="#000" fill-rule="evenodd"/></svg>\n`);
  // 字型用 nonzero 規則：內圈（洞）的方向要和外圈相反
  const fixed = fixWinding(svgpath(d).abs().unshort().toString());
  // 字型座標 y 向上：上下翻轉
  const glyph = svgpath(fixed).scale(1, -1).translate(0, 1024).round(1).toString();
  const svgFont = `<?xml version="1.0" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg"><defs>
<font id="function-bookmarks-icons" horiz-adv-x="1024">
<font-face font-family="function-bookmarks-icons" units-per-em="1024" ascent="1024" descent="0"/>
<missing-glyph horiz-adv-x="1024"/>
<glyph glyph-name="logo" unicode="&#xE001;" horiz-adv-x="1024" d="${glyph}"/>
</font></defs></svg>`;
  const ttf = svg2ttf(svgFont, { ts: 0 }).buffer;
  const woff = ttf2woff(new Uint8Array(ttf)).buffer;
  fs.writeFileSync(outWoff, Buffer.from(woff));
  console.log('path chars', d.length, 'woff bytes', woff.byteLength);
});
