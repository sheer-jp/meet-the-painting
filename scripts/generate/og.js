// ファビコンと SNS カード（OGP 1200×630）を sharp で合成する（E-16）
// 絵は実物の写真（painting_1024.jpg）を縮小して置くだけ。切り抜き・拡大縮小・影のほかは何もしない。生成モデルには入れない
// 文字は Shippori Mincho を TTF から直接パスにして描く（sharp の SVG テキストは macOS では CoreText の書体しか引けず、
// 同梱の書体ファイルを読めないため）。字形が無い文字があれば、その文字列だけ SVG の <text>（Hiragino Mincho ProN）に落とす
//
// 書体 fonts/ShipporiMincho-subset.ttf は Google Fonts の部分集合（ASCII + × — 全角空白 ・ + 作品の題名の字）。
// 題名が増えたら取り直す（ブラウザの UA を付けないと TTF が返る）：
//   T=$(node -e "const fs=require('fs');let s='';for(let c=32;c<127;c++)s+=String.fromCharCode(c);s+='×—　・絵と出会う';for(const d of fs.readdirSync('works')){try{s+=JSON.parse(fs.readFileSync('works/'+d+'/work.json')).title.ja}catch{}}console.log(encodeURIComponent([...new Set(s)].join('')))")
//   curl -s "https://fonts.googleapis.com/css2?family=Shippori+Mincho&text=$T"   # → src: url(...) の TTF を fonts/ に保存
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const OG_W = 1200;
export const OG_H = 630;
const INK = '#141210';
const FONT_FILE = new URL('./fonts/ShipporiMincho-subset.ttf', import.meta.url);

// ---------- 配置（純関数。tests/og.test.ts） ----------

/**
 * 絵を実寸比で横一列に掛ける。1 cm あたりの px は全作品で共通。間隔は均等、下端は揃える、列は左右中央
 * 高さは写真の縦横比（aspect = 幅 / 高さ）から出す（size_cm の比と写真の比が少し違っても、写真を歪めない）
 * @param {{ wCm: number, aspect: number }[]} items
 * @param {{ width?: number, height?: number, padX?: number, top?: number, bottom?: number, gap?: number }} [opt]
 *   top：絵の上端の下限、bottom：下端を揃える y
 * @returns {{ pxPerCm: number, boxes: { x: number, y: number, w: number, h: number }[] }}
 */
export function layoutRow(items, opt = {}) {
  const { width = OG_W, padX = 72, top = 120, bottom = 500, gap = 40 } = opt;
  if (!items.length) return { pxPerCm: 0, boxes: [] };
  const sumW = items.reduce((s, it) => s + it.wCm, 0);
  const maxH = Math.max(...items.map((it) => it.wCm / it.aspect));
  const availW = width - padX * 2 - gap * (items.length - 1);
  const availH = bottom - top;
  const pxPerCm = Math.min(availW / sumW, availH / maxH);
  const total = pxPerCm * sumW + gap * (items.length - 1);
  let x = (width - total) / 2;
  const boxes = items.map((it) => {
    const w = it.wCm * pxPerCm;
    const h = w / it.aspect;
    const box = { x, y: bottom - h, w, h };
    x += w + gap;
    return box;
  });
  return { pxPerCm, boxes };
}

/**
 * 作品ページ用：絵 1 点を中央に。高さはカードの ratio（既定 60%）。横長すぎるときは幅を maxW に収める
 * @param {number} aspect 幅 / 高さ
 * @param {{ width?: number, height?: number, ratio?: number, maxW?: number }} [opt]
 */
export function layoutSingle(aspect, opt = {}) {
  const { width = OG_W, height = OG_H, ratio = 0.6, maxW = width * 0.7 } = opt;
  let h = height * ratio;
  let w = h * aspect;
  if (w > maxW) { w = maxW; h = w / aspect; }
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/** 整数の箱にする（sharp に渡す直前だけ丸める）。幅と高さは比を保つよう、幅から高さを出す */
export const intBox = (b, aspect) => {
  const w = Math.max(1, Math.round(b.w));
  const h = Math.max(1, Math.round(w / aspect));
  return { x: Math.round(b.x), y: Math.round(b.y + b.h - h), w, h };   // 下端を保つ
};

// ---------- 書体（TrueType の glyf を SVG のパスに） ----------

/** @param {Buffer} buf */
export function parseTTF(buf) {
  const u16 = (o) => buf.readUInt16BE(o), i16 = (o) => buf.readInt16BE(o), u32 = (o) => buf.readUInt32BE(o);
  const tables = {};
  const n = u16(4);
  for (let i = 0; i < n; i++) tables[buf.toString('latin1', 12 + 16 * i, 16 + 16 * i)] = u32(20 + 16 * i);
  const head = tables.head, upm = u16(head + 18), locFmt = i16(head + 50);
  const numGlyphs = u16(tables.maxp + 4);
  const numH = u16(tables.hhea + 34);
  const loca = (g) => locFmt ? u32(tables.loca + g * 4) : u16(tables.loca + g * 2) * 2;
  const advance = (g) => u16(tables.hmtx + 4 * Math.min(g, numH - 1));
  // cmap：format 12 か 4
  const cmap = new Map();
  const nSub = u16(tables.cmap + 2);
  for (let i = 0; i < nSub; i++) {
    const off = tables.cmap + u32(tables.cmap + 4 + 8 * i + 4);
    const fmt = u16(off);
    if (fmt === 12) {
      const groups = u32(off + 12);
      for (let j = 0; j < groups; j++) {
        const s = u32(off + 16 + 12 * j), e = u32(off + 20 + 12 * j), g0 = u32(off + 24 + 12 * j);
        for (let c = s; c <= e; c++) cmap.set(c, g0 + c - s);
      }
    } else if (fmt === 4) {
      const segX2 = u16(off + 6), ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = u16(ends + 2 * s), start = u16(starts + 2 * s), delta = i16(deltas + 2 * s), ro = u16(ranges + 2 * s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xffff;
          else { g = u16(ranges + 2 * s + ro + 2 * (c - start)); if (g) g = (g + delta) & 0xffff; }
          if (g && !cmap.has(c)) cmap.set(c, g);
        }
      }
    }
  }
  // 1 字形の輪郭（点の列の配列。点は [x, y, onCurve]）
  const contours = (g, depth = 0) => {
    if (g >= numGlyphs || depth > 8) return [];
    const start = tables.glyf + loca(g), end = tables.glyf + loca(g + 1);
    if (end <= start) return [];
    const nc = i16(start);
    if (nc >= 0) {
      const endPts = []; for (let i = 0; i < nc; i++) endPts.push(u16(start + 10 + 2 * i));
      const nPts = nc ? endPts[nc - 1] + 1 : 0;
      let p = start + 10 + 2 * nc;
      p += 2 + u16(p);   // 命令は読み飛ばす
      const flags = [];
      while (flags.length < nPts) { const f = buf[p++]; flags.push(f); if (f & 8) { let r = buf[p++]; while (r--) flags.push(f); } }
      const xs = [], ys = [];
      let v = 0;
      for (const f of flags) { if (f & 2) { const d = buf[p++]; v += f & 16 ? d : -d; } else if (!(f & 16)) { v += i16(p); p += 2; } xs.push(v); }
      v = 0;
      for (const f of flags) { if (f & 4) { const d = buf[p++]; v += f & 32 ? d : -d; } else if (!(f & 32)) { v += i16(p); p += 2; } ys.push(v); }
      const out = []; let s = 0;
      for (const e of endPts) { out.push(xs.slice(s, e + 1).map((x, k) => [x, ys[s + k], !!(flags[s + k] & 1)])); s = e + 1; }
      return out;
    }
    // 合成字形
    const out = []; let p = start + 10, more = true;
    while (more) {
      const f = u16(p), sub = u16(p + 2); p += 4;
      let dx, dy;
      if (f & 1) { dx = i16(p); dy = i16(p + 2); p += 4; } else { dx = (buf[p] << 24) >> 24; dy = (buf[p + 1] << 24) >> 24; p += 2; }
      let a = 1, b = 0, c = 0, d = 1;
      const f2 = (o) => i16(o) / 16384;
      if (f & 8) { a = d = f2(p); p += 2; } else if (f & 64) { a = f2(p); d = f2(p + 2); p += 4; } else if (f & 128) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
      if (!(f & 2)) { dx = 0; dy = 0; }   // 点の番号合わせは使われていない前提（Shippori の部分集合では出ない）
      for (const ct of contours(sub, depth + 1)) out.push(ct.map(([x, y, on]) => [a * x + c * y + dx, b * x + d * y + dy, on]));
      more = !!(f & 32);
    }
    return out;
  };
  return { upm, glyphOf: (cp) => cmap.get(cp), advance, contours };
}

let FONT = null;
const font = () => (FONT ??= parseTTF(readFileSync(FONT_FILE)));

/** 文字列が書体にすべてあるか */
export const fontCovers = (str) => [...str].every((ch) => font().glyphOf(ch.codePointAt(0)) !== undefined);

/**
 * 文字列を SVG の path にする（左下が x, y の基線）。letterSpacing は em 比
 * @returns {{ d: string, width: number }}
 */
export function textToPath(str, x, y, size, letterSpacing = 0) {
  const f = font(), k = size / f.upm, r = (n) => +n.toFixed(2);
  let pen = x, d = '';
  for (const ch of str) {
    const g = f.glyphOf(ch.codePointAt(0)) ?? 0;
    for (const ct of f.contours(g)) {
      if (!ct.length) continue;
      const P = (pt) => [r(pen + pt[0] * k), r(y - pt[1] * k)];
      // 2 次ベジエ：on-curve の点から始まるよう回す（無ければ最初の 2 点の中点を補う）。連続する off-curve の間には中点の on-curve を補う
      const i0 = ct.findIndex((pt) => pt[2]);
      const pts = i0 >= 0 ? [...ct.slice(i0), ...ct.slice(0, i0)] : [[(ct[0][0] + ct[1 % ct.length][0]) / 2, (ct[0][1] + ct[1 % ct.length][1]) / 2, true], ...ct];
      const [sx, sy] = P(pts[0]);
      d += `M${sx} ${sy}`;
      let ctrl = null;
      for (const pt of [...pts.slice(1), pts[0]]) {
        if (pt[2]) {
          const [px, py] = P(pt);
          if (ctrl) { const [cx, cy] = P(ctrl); d += `Q${cx} ${cy} ${px} ${py}`; ctrl = null; } else d += `L${px} ${py}`;
        } else {
          if (ctrl) { const [cx, cy] = P(ctrl), [mx, my] = P([(ctrl[0] + pt[0]) / 2, (ctrl[1] + pt[1]) / 2]); d += `Q${cx} ${cy} ${mx} ${my}`; }
          ctrl = pt;
        }
      }
      d += 'Z';
    }
    pen += f.advance(g) * k + size * letterSpacing;
  }
  return { d, width: pen - x - (str.length ? size * letterSpacing : 0) };
}

const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** 文字の SVG 片。anchor は 'start' | 'end'。書体に無い字があれば <text>（Hiragino Mincho ProN）に落とす */
function textSvg(str, x, y, size, { anchor = 'start', fill = INK, letterSpacing = 0 } = {}) {
  if (fontCovers(str)) {
    const w = textToPath(str, 0, 0, size, letterSpacing).width;
    const { d } = textToPath(str, anchor === 'end' ? x - w : x, y, size, letterSpacing);
    return `<path d="${d}" fill="${fill}"/>`;
  }
  return `<text x="${x}" y="${y}" font-family="Hiragino Mincho ProN, Shippori Mincho, serif" font-size="${size}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${size * letterSpacing}">${escXml(str)}</text>`;
}

// ---------- 合成 ----------

/** 影の SVG（箱ごとに、少し下にずらしてぼかした矩形） */
function shadowSvg(boxes, { blur = 7, dy = 5, opacity = 0.16 } = {}) {
  const rects = boxes.map((b) => `<rect x="${b.x}" y="${b.y + dy}" width="${b.w}" height="${b.h}" fill="#000" fill-opacity="${opacity}" filter="url(#s)"/>`).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}"><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>${rects}</svg>`);
}

const wall = () => sharp({ create: { width: OG_W, height: OG_H, channels: 3, background: '#ffffff' } });
const brandSvg = () => textSvg('Meet the Painting by SHEER', 64, 78, 26, { letterSpacing: 0.04 });

/** 絵（実物の写真）を w×h に縮小する。縦横比はそもそも写真と同じなので歪まない */
const paintingAt = (path, w, h) => sharp(path).resize(w, h, { fit: 'fill' }).toBuffer();

/**
 * 受付・ギャラリー用 public/og/gallery.png
 * @param {{ root: string, works: { id: string, size_cm: number[], aspect: number }[] }} p
 */
export async function galleryOg({ root, works }) {
  const items = works.map((s) => ({ wCm: s.size_cm[0], aspect: s.aspect }));
  const { boxes } = layoutRow(items);
  const ib = boxes.map((b, i) => intBox(b, items[i].aspect));
  const layers = await Promise.all(works.map(async (s, i) => ({
    input: await paintingAt(join(root, 'works', s.id, 'generated', 'painting_1024.jpg'), ib[i].w, ib[i].h), left: ib[i].x, top: ib[i].y,
  })));
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}">${brandSvg()}<line x1="64" y1="560.5" x2="${OG_W - 64}" y2="560.5" stroke="${INK}" stroke-opacity=".28" stroke-width="1"/></svg>`);
  const out = join(root, 'public', 'og');
  mkdirSync(out, { recursive: true });
  await wall().composite([{ input: shadowSvg(ib), left: 0, top: 0 }, ...layers, { input: overlay, left: 0, top: 0 }]).png().toFile(join(out, 'gallery.png'));
  return { boxes: ib };
}

/**
 * 作品ページ用 works/<id>/generated/og.png
 * @param {{ root: string, space: { id: string, size_cm: number[], aspect: number, title?: any } }} p
 */
export async function workOg({ root, space }) {
  const b = intBox(layoutSingle(space.aspect), space.aspect);
  const gen = join(root, 'works', space.id, 'generated');
  const input = await paintingAt(join(gen, 'painting_1024.jpg'), b.w, b.h);
  const [w, h] = space.size_cm;
  const title = space.title?.ja || space.id;
  const caption = `${title}　${w} × ${h} cm`;
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}">${brandSvg()}${textSvg(caption, OG_W - 64, OG_H - 56, 22, { anchor: 'end', letterSpacing: 0.02 })}</svg>`);
  await wall().composite([{ input: shadowSvg([b], { blur: 10, dy: 7, opacity: 0.16 }), left: 0, top: 0 }, { input, left: b.x, top: b.y }, { input: overlay, left: 0, top: 0 }]).png().toFile(join(gen, 'og.png'));
  return { box: b };
}

// ---------- ファビコン ----------

/** 白地に細い黒線の額縁 1 つ、中に小さな横長の長方形。32 の格子、線 1.5、角は直角 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
<rect width="32" height="32" fill="#ffffff"/>
<rect x="5.75" y="5.75" width="20.5" height="20.5" fill="none" stroke="#141210" stroke-width="1.5"/>
<rect x="11.75" y="13.25" width="8.5" height="5.5" fill="none" stroke="#141210" stroke-width="1.5"/>
</svg>
`;

/** public/favicon.svg・favicon-32.png・apple-touch-icon.png（180、不透明の白地）・site.webmanifest */
export async function writeIcons(root) {
  const pub = join(root, 'public');
  writeFileSync(join(pub, 'favicon.svg'), FAVICON_SVG);
  const svg = Buffer.from(FAVICON_SVG);
  await sharp(svg, { density: 72 }).flatten({ background: '#ffffff' }).png().toFile(join(pub, 'favicon-32.png'));
  await sharp(svg, { density: (72 * 180) / 32 }).resize(180, 180).flatten({ background: '#ffffff' }).removeAlpha().png().toFile(join(pub, 'apple-touch-icon.png'));
  // PWA 用の 192 / 512（監査 11-07：manifest に無かった）
  for (const n of [192, 512]) await sharp(svg, { density: (72 * n) / 32 }).resize(n, n).flatten({ background: '#ffffff' }).removeAlpha().png().toFile(join(pub, `icon-${n}.png`));
  const manifest = {
    name: 'Meet the Painting', short_name: 'Meet the Painting', start_url: './', scope: './', display: 'standalone',
    background_color: '#ffffff', theme_color: '#ffffff',
    icons: [
      { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: 'favicon-32.png', sizes: '32x32', type: 'image/png' },
      { src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
  writeFileSync(join(pub, 'site.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');
}

/** generate の最後に呼ぶ：アイコン、ギャラリーのカード、各作品のカード */
export async function writeOg({ root, works }) {
  await writeIcons(root);
  await galleryOg({ root, works });
  for (const space of works) if (existsSync(join(root, 'works', space.id, 'generated', 'painting_1024.jpg'))) await workOg({ root, space });
}
