// 部屋のイメージ（AI 生成、rooms/ に共用）に、絵の写真を壁の 4 隅へ射影して貼る。
// sharp.affine() はアフィンのみなので、ホモグラフィの逆写像を自前で行う（バイリニア補間）
import sharp from 'sharp';
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// 単位正方形 (0,0)-(1,1) → 4 点 への射影行列 H（3×3、行優先）
export function homographyFromUnitSquare([p0, p1, p2, p3]) {
  // p0 左上, p1 右上, p2 右下, p3 左下（時計回り）
  const [x0, y0] = p0, [x1, y1] = p1, [x2, y2] = p2, [x3, y3] = p3;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  return [a, b, c, d, e, f, g, h, 1];
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, Hh = -(a * f - c * d), I = a * e - b * d;
  return [A, D, G, B, E, Hh, C, F, I].map((v) => v / det);
}

// 壁の 4 隅と壁幅から、絵（幅 w_cm × 高さ h_cm）を置く 4 隅を求める
export function paintingQuadOnWall(wall, sizeCm) {
  const H = homographyFromUnitSquare(wall.corners_px);
  const [cx, cy] = wall.hang_center_ratio || [0.5, 0.45];
  const rw = sizeCm[0] / wall.width_cm;
  const wallHeightCm = wall.height_cm || wall.width_cm * ((dist(wall.corners_px[0], wall.corners_px[3]) + dist(wall.corners_px[1], wall.corners_px[2])) / (dist(wall.corners_px[0], wall.corners_px[1]) + dist(wall.corners_px[3], wall.corners_px[2])));
  const rh = sizeCm[1] / wallHeightCm;
  const u0 = cx - rw / 2, u1 = cx + rw / 2, v0 = cy - rh / 2, v1 = cy + rh / 2;
  const map = (u, v) => { const x = H[0] * u + H[1] * v + H[2], y = H[3] * u + H[4] * v + H[5], w = H[6] * u + H[7] * v + H[8]; return [x / w, y / w]; };
  return [map(u0, v0), map(u1, v0), map(u1, v1), map(u0, v1)];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// 絵を quad に貼る。room: {data,width,height} RGB raw。painting 同様。薄い影つき
export function warpOnto(room, painting, quad, { shadow = 0.35 } = {}) {
  const H = homographyFromUnitSquare(quad);
  const Hi = invert3(H);
  const out = Buffer.from(room.data);
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const pad = 14; // 影の範囲
  const minX = Math.max(0, Math.floor(Math.min(...xs)) - pad), maxX = Math.min(room.width - 1, Math.ceil(Math.max(...xs)) + pad);
  const minY = Math.max(0, Math.floor(Math.min(...ys)) - pad), maxY = Math.min(room.height - 1, Math.ceil(Math.max(...ys)) + pad);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const w = Hi[6] * x + Hi[7] * y + Hi[8];
    const u = (Hi[0] * x + Hi[1] * y + Hi[2]) / w, v = (Hi[3] * x + Hi[4] * y + Hi[5]) / w;
    const o = (y * room.width + x) * 3;
    if (u >= 0 && u < 1 && v >= 0 && v < 1) {
      const px = u * (painting.width - 1), py = v * (painting.height - 1);
      const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
      const x1 = Math.min(painting.width - 1, x0 + 1), y1 = Math.min(painting.height - 1, y0 + 1);
      for (let c = 0; c < 3; c++) {
        const s = (xx, yy) => painting.data[(yy * painting.width + xx) * 3 + c];
        const val = s(x0, y0) * (1 - fx) * (1 - fy) + s(x1, y0) * fx * (1 - fy) + s(x0, y1) * (1 - fx) * fy + s(x1, y1) * fx * fy;
        out[o + c] = Math.round(val);
      }
    } else {
      // 影：絵の外側、下と右に落ちる柔らかい影
      const du = u < 0 ? -u : u > 1 ? u - 1 : 0, dv = v < 0 ? -v : v > 1 ? v - 1 : 0;
      const d = Math.hypot(du * (painting.width), dv * (painting.height)) / Math.max(painting.width, painting.height) * 60;
      const bias = (v > 1 ? 1.0 : 0.5) * (u > 1 ? 1.0 : 0.7);
      const a = Math.max(0, shadow * bias * (1 - d / 1.0));
      if (a > 0) for (let c = 0; c < 3; c++) out[o + c] = Math.round(out[o + c] * (1 - a));
    }
  }
  return out;
}

// 基準物から出した px/cm で、正面の壁に絵を置く 4 隅を求める（左上から時計回り、長方形）
// imageWidthPx：実際に使う画像の幅。def.image_width_px と違えば、その比率を px/cm と座標に掛ける
export function paintingRectFromScale(def, sizeCm, imageWidthPx) {
  const k = imageWidthPx && def.image_width_px ? imageWidthPx / def.image_width_px : 1;
  const pxPerCm = def.scale.px_per_cm * k;
  if (def.hang.place) return placeQuad(def.hang, sizeCm, pxPerCm, k);
  const w = sizeCm[0] * pxPerCm, h = sizeCm[1] * pxPerCm;
  const cx = def.hang.x_px * k;
  // 掛ける高さ：3 通り。(a) 家具の上端の画素 furniture_top_y_px から gap_cm（既定 20）上に下端（家具が壁より手前でも、床の線の読み違いでもずれない。家具の上に掛けるときはこれ）
  // (b) 下端 bottom_from_floor_cm（床の線から）、(c) 中心 center_from_floor_cm（立って見る壁 145cm など）
  let cy;
  // 11-08 作家「普通は目線の位置に置く」：低い家具でも、目線の高さより下げない。center_from_floor_cm があれば、それと家具の上の高い方を取る
  if (def.hang.furniture_top_y_px != null) {
    cy = def.hang.furniture_top_y_px * k - (def.hang.gap_cm ?? 20) * pxPerCm - h / 2;
    if (def.hang.center_from_floor_cm != null) cy = Math.min(cy, def.hang.floor_y_px * k - def.hang.center_from_floor_cm * pxPerCm);
  } else if (def.hang.center_from_floor_cm != null) cy = def.hang.floor_y_px * k - def.hang.center_from_floor_cm * pxPerCm;
  else cy = def.hang.floor_y_px * k - (def.hang.bottom_from_floor_cm + sizeCm[1] / 2) * pxPerCm;
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

// ---- 置く場面（docs/PLACEMENT.md 6 節）----
// easel：卓上イーゼルの受けに乗せる。面が少し上を向くので、上辺を下辺より 3% 短く、高さ 0.96 倍（台形）
// lean：棚の天板に立てかける。高さ 0.97 倍、上辺はそのまま
export const PLACE = {
  easel: { height: 0.96, taper: 0.03, right_cm: 1 },
  lean: { height: 0.97, taper: 0, right_cm: 0 },
};
export const SIDE_BOTTOM_CM = 2.5;     // キャンバスの側面（下辺）の厚み（物の寸法）
export const SIDE_VIEW = 0.4;          // 下の側面が見える割合（視線の角度。正面に近いので 2.5 cm × 0.4 ≈ 1 cm の細い帯に。そのままだと台座のように厚く見えた）
export const CONTACT_SHADOW_CM = 1.5;  // 接地の影の高さ
export const SIDE_DARKEN = 0.35;       // 側面は絵の端の色を 35% 暗く

// 側面の帯と接地の影の大きさ（画像の px）
export function placeSidesPx(place, pxPerCm) {
  const p = PLACE[place] || PLACE.lean;
  return { bottom: SIDE_BOTTOM_CM * SIDE_VIEW * pxPerCm, right: p.right_cm * pxPerCm, shadow: CONTACT_SHADOW_CM * pxPerCm };
}

// 置く場面の 4 隅（左上から時計回り）。ledge_y_px は「物としての絵」の底（側面の帯の下端）が乗る線。
// 絵の面の下辺は、そこから見えている側面の帯（2.5 cm × SIDE_VIEW）だけ上。受けの木が帯で隠れないように（帯を受けの前に垂らすと、受けが消えて浮いて見える）
export function placeQuad(hang, sizeCm, pxPerCm, k = 1) {
  const p = PLACE[hang.place];
  if (!p) throw new Error(`hang.place は easel か lean（${hang.place}）`);
  const w = sizeCm[0] * pxPerCm, h = sizeCm[1] * pxPerCm * p.height;
  const wt = w * (1 - p.taper);
  const cx = hang.x_px * k;
  const yb = hang.ledge_y_px * k - placeSidesPx(hang.place, pxPerCm).bottom, yt = yb - h;
  return [[cx - wt / 2, yt], [cx + wt / 2, yt], [cx + w / 2, yb], [cx - w / 2, yb]];
}

// 置いた絵に厚みと接地の影を描く（warpOnto で面を貼ったあと、shadow: 0 で）。buf は RGB raw（書き換える）
// - lean：壁にごく薄い影（絵の左右と上に、寄りかかった分だけ）
// - 下辺：厚み 2.5 cm の側面が見える分（× SIDE_VIEW）の帯。色は絵の下端の色を 35% 暗く
// - easel：右辺にも 1 cm の帯（絵の右端の色を 35% 暗く）
// - 接地の影：帯の直下に高さ 1.5 cm。中心が濃く、端が薄い
// ledgeX：受けの左右の端 [x0, x1]（画像の px）。あれば接地の影をその中だけに落とす（受けからはみ出た所は宙に浮いた壁なので影を置かない）
export function drawPlaceSides(buf, W, H, painting, quad, { place, pxPerCm, ledgeX = null }) {
  const sz = placeSidesPx(place, pxPerCm);
  const [tl, tr, br, bl] = quad;
  const yt = tl[1], yb = bl[1], xl = bl[0], xr = br[0];
  const yBand = yb + sz.bottom;
  const Hi = invert3(homographyFromUnitSquare(quad));
  const inside = (x, y) => {
    const w = Hi[6] * x + Hi[7] * y + Hi[8];
    const u = (Hi[0] * x + Hi[1] * y + Hi[2]) / w, v = (Hi[3] * x + Hi[4] * y + Hi[5]) / w;
    return u >= 0 && u < 1 && v >= 0 && v < 1;
  };
  const darken = (o, a) => { for (let c = 0; c < 3; c++) buf[o + c] = Math.round(buf[o + c] * (1 - a)); };
  const mix = (o, rgb, a) => { for (let c = 0; c < 3; c++) buf[o + c] = Math.round(buf[o + c] * (1 - a) + rgb[c] * a); };
  // 絵の端の色（下端・右端の 3 行 / 列の平均を、長さの 12% の幅でならす。画素ごとの色だと縦縞になる）を 35% 暗く
  const edgeProfile = (axis) => {
    const { data, width: pw, height: ph } = painting;
    const n = axis === 'bottom' ? pw : ph;
    const raw = Array.from({ length: n }, (_, j) => {
      const out = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const px = axis === 'bottom' ? j : pw - 1 - i, py = axis === 'bottom' ? ph - 1 - i : j;
        for (let c = 0; c < 3; c++) out[c] += data[(py * pw + px) * 3 + c] / 3;
      }
      return out;
    });
    const r = Math.max(1, Math.round(n * 0.06));
    return raw.map((_, j) => {
      const out = [0, 0, 0]; let cnt = 0;
      for (let t = Math.max(0, j - r); t <= Math.min(n - 1, j + r); t++) { for (let c = 0; c < 3; c++) out[c] += raw[t][c]; cnt++; }
      return out.map((v) => (v / cnt) * (1 - SIDE_DARKEN));
    });
  };
  const profB = edgeProfile('bottom'), profR = edgeProfile('right');
  const edgeColor = (axis, t) => {
    const prof = axis === 'bottom' ? profB : profR;
    return prof[Math.min(prof.length - 1, Math.max(0, Math.round(t * (prof.length - 1))))];
  };
  const clampX = (v) => Math.max(0, Math.min(W - 1, v)), clampY = (v) => Math.max(0, Math.min(H - 1, v));
  // 右辺の x（y で線形。台形の右の辺）
  const rightAt = (y) => tr[0] + (br[0] - tr[0]) * ((y - yt) / (yb - yt));

  // (1) lean：壁のごく薄い影（絵の外、天板より上）
  if (place === 'lean') {
    const d = 0.8 * pxPerCm;
    for (let y = clampY(Math.floor(yt - d)); y <= clampY(Math.ceil(yb)); y++) for (let x = clampX(Math.floor(xl - d)); x <= clampX(Math.ceil(xr + d)); x++) {
      if (inside(x, y)) continue;
      const dx = x < xl ? xl - x : x > xr ? x - xr : 0, dy = y < yt ? yt - y : 0;
      const dd = Math.hypot(dx, dy);
      if (dd >= d) continue;
      darken((y * W + x) * 3, 0.10 * (1 - dd / d) ** 2);
    }
  }
  // (2) 接地の影（帯の下。中心が濃く、端が薄い）。帯で隠れる所に描いても後で上書きされる
  {
    let x0 = xl - sz.shadow, x1 = xr + sz.right + sz.shadow;
    if (ledgeX) { x0 = Math.max(x0, ledgeX[0]); x1 = Math.min(x1, ledgeX[1]); }
    const cx = (x0 + x1) / 2, half = Math.max(1, (x1 - x0) / 2);
    for (let y = clampY(Math.floor(yBand)); y <= clampY(Math.ceil(yBand + sz.shadow)); y++) for (let x = clampX(Math.floor(x0)); x <= clampX(Math.ceil(x1)); x++) {
      const tv = Math.min(1, Math.max(0, (y - yBand) / sz.shadow));
      const th = Math.abs(x - cx) / half;
      const a = 0.7 * (1 - tv) * (1 - smoothstep(0.7, 1.1, th));
      if (a > 0) darken((y * W + x) * 3, a);
    }
  }
  // (3) 右辺の帯（easel）：面の右の辺から右へ sz.right。下は帯の下端まで
  if (sz.right > 0) {
    for (let y = clampY(Math.floor(yt)); y <= clampY(Math.ceil(yBand) - 1); y++) {
      const xe = rightAt(Math.min(y + 0.5, yb));
      const col = edgeColor('right', Math.min(1, Math.max(0, (y - yt) / (yb - yt))));
      for (let x = clampX(Math.floor(xe)); x <= clampX(Math.ceil(xe + sz.right)); x++) {
        // 横の被覆率（端の画素は割合で混ぜる）
        const cov = Math.min(1, x + 1 - xe) - Math.max(0, x - (xe + sz.right));
        const covV = Math.min(1, y + 1 - yt) * Math.min(1, yBand - y);
        const a = Math.max(0, Math.min(1, cov)) * Math.max(0, Math.min(1, covV));
        if (a > 0 && !inside(x + 0.5, y + 0.5)) mix((y * W + x) * 3, col, a);
      }
    }
  }
  // (4) 下辺の帯：面の下辺から下へ sz.bottom
  for (let y = clampY(Math.floor(yb)); y <= clampY(Math.ceil(yBand) - 1); y++) {
    const covV = Math.max(0, Math.min(1, Math.min(y + 1, yBand) - Math.max(y, yb)));
    if (covV <= 0) continue;
    for (let x = clampX(Math.floor(xl)); x <= clampX(Math.ceil(xr)); x++) {
      const cov = Math.max(0, Math.min(1, Math.min(x + 1, xr) - Math.max(x, xl)));
      if (cov <= 0) continue;
      // 帯の下ほど少し暗く（丸みのある木枠に見せる）
      // 面との境の 1px は暗い継ぎ目（角が回り込んで見える）
      const t = (y + 0.5 - yb) / sz.bottom;
      const seam = y - yb < 1 ? 0.75 : 1;
      const col = edgeColor('bottom', (x + 0.5 - xl) / (xr - xl)).map((v) => v * (1 - 0.25 * t) * seam);
      mix((y * W + x) * 3, col, cov * covV);
    }
  }
  return buf;
}

// 帯の色（space.json の side_color。拡大表示で絵の層の下に敷く）：絵の下端の平均を 35% 暗く
export function sideColorHex(painting) {
  const { data, width: pw, height: ph } = painting;
  const s = [0, 0, 0];
  for (let i = 0; i < 3; i++) for (let x = 0; x < pw; x++) for (let c = 0; c < 3; c++) s[c] += data[((ph - 1 - i) * pw + x) * 3 + c];
  return '#' + s.map((v) => Math.round((v / (3 * pw)) * (1 - SIDE_DARKEN)).toString(16).padStart(2, '0')).join('');
}

// 絵の中心の床からの高さ（cm）。文章用。家具の上端で決めたときは、置いた位置と床の線から逆算する
// quad と pxPerCm は実際に使う画像幅（k 倍）で揃っていること。k は def.image_width_px に対する比率
// 優先順位は paintingRectFromScale と同じ（家具の上端と中心の高い方 → 下端 → 中心）。文章が合成と食い違わないように
export function hangCenterCm(def, sizeCm, quad, pxPerCm, k = 1) {
  if (def.hang.furniture_top_y_px != null) {
    const cy = (quad[0][1] + quad[2][1]) / 2;
    return Math.round((def.hang.floor_y_px * k - cy) / pxPerCm);
  }
  if (def.hang.center_from_floor_cm != null) return def.hang.center_from_floor_cm;
  return Math.round(def.hang.bottom_from_floor_cm + sizeCm[1] / 2);
}

// ---- 手前の物と絵の前後（docs/SIZE_UX.md 11 節）----

const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// 壁色キーで「手前の物」の alpha（0〜1、画像全体の Float32Array）を作る
// room: {data,width,height} RGB raw。quad：絵の 4 隅
// 壁の色は、絵の外接矩形を 20px 広げた帯の画素から取る。帯の中央値を出発点に、
// 位置の 2 次式（1, u, v, uv, u², v²）を外れ値を除きながら当てはめる（AI 生成の部屋は壁に上下の明暗があり、
// 1 色の中央値だと絵の上端が「手前」と誤判定されるため）
export function wallKeyAlpha(room, quad, { tolerance = 0.10, band = 20, margin = 14, minArea = 16 } = {}) {
  const { data, width: W, height: H } = room;
  const b = bbox(quad);
  const rx0 = Math.max(0, Math.floor(b.x0)), ry0 = Math.max(0, Math.floor(b.y0));
  const rx1 = Math.min(W - 1, Math.ceil(b.x1)), ry1 = Math.min(H - 1, Math.ceil(b.y1));
  const bx0 = Math.max(0, rx0 - band), by0 = Math.max(0, ry0 - band), bx1 = Math.min(W - 1, rx1 + band), by1 = Math.min(H - 1, ry1 + band);
  const bandIdx = [];
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    if (x >= rx0 && x <= rx1 && y >= ry0 && y <= ry1) continue;
    bandIdx.push(y * W + x);
  }
  const median = (a) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };
  const wallMedian = [0, 1, 2].map((c) => median(bandIdx.map((i) => data[i * 3 + c])) / 255);
  // 位置の正規化（数値の安定のため）
  const cx = (rx0 + rx1) / 2, cy = (ry0 + ry1) / 2, sc = Math.max(1, (bx1 - bx0) / 2, (by1 - by0) / 2);
  const basis = (x, y) => { const u = (x - cx) / sc, v = (y - cy) / sc; return [1, u, v, u * v, u * u, v * v]; };
  let coef = wallMedian.map((m) => [m, 0, 0, 0, 0, 0]);
  const wallAt = (x, y) => { const f = basis(x, y); return coef.map((k) => k.reduce((a, kk, j) => a + kk * f[j], 0)); };
  const distTo = (i, w) => Math.hypot(data[i * 3] / 255 - w[0], data[i * 3 + 1] / 255 - w[1], data[i * 3 + 2] / 255 - w[2]);
  // 外れ値（紐、葉、家具の端）を除いて当てはめ直す。1 回目は中央値から 0.25 以内、以後は当てはめから tolerance 以内
  for (let it = 0; it < 3; it++) {
    const thr = it === 0 ? 0.25 : tolerance;
    const inl = bandIdx.filter((i) => { const x = i % W, y = (i - x) / W; return distTo(i, wallAt(x, y)) < thr; });
    if (inl.length < 24) break;
    const next = fitQuadratic(inl, W, data, basis);
    if (!next) break;
    coef = next;
  }
  const wallRgb = wallAt(cx, cy);
  // 対象の領域：矩形 + 影の余白（影を手前の物に落とさないため）
  const x0 = Math.max(0, rx0 - margin), y0 = Math.max(0, ry0 - margin), x1 = Math.min(W - 1, rx1 + margin), y1 = Math.min(H - 1, ry1 + margin);
  const alpha = new Float32Array(W * H);
  const hi = tolerance * 1.6;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    alpha[y * W + x] = smoothstep(tolerance, hi, distTo(y * W + x, wallAt(x, y)));
  }
  // 小さな孤立点を消す（alpha > 0 の塊で面積 minArea 未満 → 0）。収縮→膨張は細い紐を消すので、面積で判定する
  // 逆に、手前の物の中の小さな穴（葉のハイライトが壁色に近い所。alpha < 0.5 の塊で、領域の縁に触れず 64px 未満）は埋める
  const region = { x0, y0, x1, y1 };
  for (const c of components(alpha, W, region, (a) => a > 0)) if (c.idx.length < minArea) for (const i of c.idx) alpha[i] = 0;
  for (const c of components(alpha, W, region, (a) => a < 0.5)) if (!c.touchesEdge && c.idx.length < 64) for (const i of c.idx) alpha[i] = 1;
  return { alpha: featherAlpha(alpha, W, H, region), wall_rgb: wallRgb.map((v) => Math.round(v * 255)) };
}

// 最小二乗で、チャンネルごとに 壁色 = Σ coef_j × basis_j(x, y) を当てはめる（6×6 の正規方程式をガウスの消去で解く）
function fitQuadratic(idx, W, data, basis) {
  const n = 6;
  const A = Array.from({ length: n }, () => new Float64Array(n));
  const B = [0, 1, 2].map(() => new Float64Array(n));
  for (const i of idx) {
    const x = i % W, y = (i - x) / W, f = basis(x, y);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) A[r][c] += f[r] * f[c];
      for (let ch = 0; ch < 3; ch++) B[ch][r] += f[r] * data[i * 3 + ch] / 255;
    }
  }
  // 帯の形によっては決まらない項があるので、少しだけ正則化する
  for (let r = 1; r < n; r++) A[r][r] += 1e-6 * idx.length;
  const out = [];
  for (let ch = 0; ch < 3; ch++) {
    const M = A.map((row, r) => [...row, B[ch][r]]);
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      [M[col], M[piv]] = [M[piv], M[col]];
      for (let r = 0; r < n; r++) if (r !== col) { const k = M[r][col] / M[col][col]; for (let c = col; c <= n; c++) M[r][c] -= k * M[col][c]; }
    }
    out.push(M.map((row, r) => row[n] / row[r]));
  }
  return out;
}

// 領域内で pred を満たす画素の 8 近傍の塊を列挙する
function components(alpha, W, r, pred) {
  const seen = new Uint8Array(alpha.length), out = [], stack = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
    const i0 = y * W + x;
    if (seen[i0] || !pred(alpha[i0])) continue;
    const idx = [];
    let touchesEdge = false;
    stack.push(i0); seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop(); idx.push(i);
      const cx = i % W, cy = (i - cx) / W;
      if (cx === r.x0 || cx === r.x1 || cy === r.y0 || cy === r.y1) touchesEdge = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < r.x0 || nx > r.x1 || ny < r.y0 || ny > r.y1) continue;
        const j = ny * W + nx;
        if (!seen[j] && pred(alpha[j])) { seen[j] = 1; stack.push(j); }
      }
    }
    out.push({ idx, touchesEdge });
  }
  return out;
}

// 境界を半径 1.5px でぼかす（ガウス σ=0.75、5 タップの分離フィルタ）
// 細い紐が薄くならないよう、ぼかした値と元の値の大きい方を取る（外側にだけ柔らかくする）
function featherAlpha(alpha, W, H, r = { x0: 0, y0: 0, x1: W - 1, y1: H - 1 }) {
  const k = [-2, -1, 0, 1, 2].map((t) => Math.exp(-(t * t) / (2 * 0.75 * 0.75)));
  const ks = k.reduce((a, v) => a + v, 0);
  const kn = k.map((v) => v / ks);
  const tmp = new Float32Array(W * H), out = new Float32Array(alpha);
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
    let s = 0;
    for (let t = -2; t <= 2; t++) s += kn[t + 2] * alpha[y * W + Math.min(W - 1, Math.max(0, x + t))];
    tmp[y * W + x] = s;
  }
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
    let s = 0;
    for (let t = -2; t <= 2; t++) { const yy = Math.min(r.y1, Math.max(r.y0, y + t)); s += kn[t + 2] * tmp[yy * W + x]; }
    const i = y * W + x;
    out[i] = Math.max(alpha[i], s);
  }
  return out;
}

// 手描きのマスク（白 = 手前）を alpha にする。部屋の画像の大きさに合わせる
export async function maskPngAlpha(path, W, H) {
  const m = await sharp(path).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer();
  const ch = m.length / (W * H);
  const alpha = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = m[i * ch] / 255;
  return alpha;
}

// 絵を貼ったあと、手前の物の画素を元に戻す：out = mix(painted, original, alpha)
// 絵の外（影の範囲）では alpha 0.5 以上の画素に影を掛けない（影は壁にだけ）
export function restoreForeground(painted, original, alpha, quad, W, H) {
  const out = Buffer.from(painted);
  const Hi = invert3(homographyFromUnitSquare(quad));
  for (let i = 0; i < W * H; i++) {
    const a = alpha[i];
    if (a <= 0) continue;
    const x = i % W, y = (i - x) / W;
    const w = Hi[6] * x + Hi[7] * y + Hi[8];
    const u = (Hi[0] * x + Hi[1] * y + Hi[2]) / w, v = (Hi[3] * x + Hi[4] * y + Hi[5]) / w;
    const inside = u >= 0 && u < 1 && v >= 0 && v < 1;
    const aa = !inside && a >= 0.5 ? 1 : a;
    const o = i * 3;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(painted[o + c] * (1 - aa) + original[o + c] * aa);
  }
  return out;
}

const bbox = (pts) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (v) => String(+v.toFixed(2));

// ---- 縮尺：基準物（rooms/REFERENCES.json の実寸 cm と、部屋 JSON の px）から ----

export function loadReferenceTable(roomsDir) {
  const p = join(roomsDir, 'REFERENCES.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

// "door_interior.height" → { key, dim: 'height', item, cm }
export function resolveRef(ref, table) {
  const [key, dim] = String(ref).split('.');
  const item = table[key];
  const cm = item?.[`${dim}_cm`];
  if (!item || !cm) throw new Error(`寸法表に ${ref} が無い（rooms/REFERENCES.json）`);
  return { key, dim, item, cm };
}

// ずれ（割合）と基準の数から信頼度：8% 以内 high、15% 以内 mid、それ以上か基準が 1 つ → low
export function confidenceFrom(deviation, count) {
  if (count < 2) return 'low';
  if (deviation <= 0.08) return 'high';
  if (deviation <= 0.15) return 'mid';
  return 'low';
}

// references: [{ ref, px, primary }] → { px_per_cm, deviation, confidence, primary: [...], all: [...] }
// primary が複数あれば、その平均を px/cm にする。ずれは、全基準物の px/cm と採用値の最大のずれ
// 奥行きの補正（H5）：基準物が壁より手前に立っているとき、部屋の horizon_y_px（目の高さの線）と基準物の接地線 floor_y_px から、
// 壁の奥行きでの px/cm に換算する。factor = (壁の床線 − 地平線) / (基準物の接地線 − 地平線)。どちらかが無ければ補正しない
/** @param {{ wallFloorY?: number | null, horizonY?: number | null }} [opts] */
export function scaleFromReferences(references, table, { wallFloorY = null, horizonY = null } = /** @type {{ wallFloorY?: number | null, horizonY?: number | null }} */ ({})) {
  const all = references.map((r) => {
    const x = resolveRef(r.ref, table);
    let depth = 1;
    if (horizonY != null && wallFloorY != null && r.floor_y_px != null && r.floor_y_px > horizonY && wallFloorY > horizonY) depth = (wallFloorY - horizonY) / (r.floor_y_px - horizonY);
    return { ...x, ref: r.ref, px: r.px, primary: !!r.primary, depth, pxPerCm: (r.px / x.cm) * depth };
  });
  if (!all.length) throw new Error('references が空');
  const prim = all.filter((r) => r.primary).length ? all.filter((r) => r.primary) : [all[0]];
  const pxPerCm = prim.reduce((a, r) => a + r.pxPerCm, 0) / prim.length;
  const deviation = Math.max(0, ...all.map((r) => Math.abs(r.pxPerCm - pxPerCm) / pxPerCm));
  return { px_per_cm: pxPerCm, deviation, confidence: confidenceFrom(deviation, all.length), primary: prim, all };
}

// ---- 比較の一文 ----

// 比率を身近な言い方に丸める（docs/SIZE_UX.md 3 節）
export function fractionOf(r) {
  if (r >= 0.9 && r <= 1.1) return { kind: 'same', ja: 'ほぼ同じ', en: 'about the same' };
  if (r >= 0.6 && r <= 0.75) return { kind: 'frac', ja: '約 3 分の 2', en: 'about two thirds' };
  if (r >= 0.45 && r <= 0.55) return { kind: 'frac', ja: '約半分', en: 'about half' };
  if (r >= 0.28 && r <= 0.38) return { kind: 'frac', ja: '約 3 分の 1', en: 'about one third' };
  if (r >= 0.22 && r < 0.28) return { kind: 'frac', ja: '約 4 分の 1', en: 'about a quarter' };
  if (r >= 0.17 && r < 0.22) return { kind: 'frac', ja: '約 5 分の 1', en: 'about a fifth' };   // 11-07：「約 0.2 倍の高さ」が不自然だった
  if (r >= 0.14 && r < 0.17) return { kind: 'frac', ja: '約 6 分の 1', en: 'about a sixth' };
  const v = Math.max(0.1, Math.round(r * 10) / 10).toFixed(1);
  return { kind: 'times', ja: `約 ${v} 倍`, en: `about ${v} times` };
}

// 顧客に馴染みがある順（ドア > ソファ > 机 > 棚 > カウンター > ナイトテーブル > 天井 > その他）
export const FAMILIAR = ['door_interior', 'door_entrance', 'sofa_2seat', 'armchair', 'bench', 'desk', 'low_shelf', 'tabletop_easel', 'sideboard', 'bookshelf_low', 'kitchen_counter', 'nightstand', 'ceiling', 'ceiling_entrance', 'window', 'kettle', 'table_lamp', 'laptop', 'mug'];
// 幅で比べてよい物（横長の絵と、横に長い家具）
const WIDE = new Set(['sofa_2seat', 'bench', 'desk', 'low_shelf', 'window', 'shoe_cabinet', 'sideboard', 'bookshelf_low']);   // 11-07：靴箱・サイドボード・本棚は幅で比べる（「約 0.2 倍の高さ」が不自然だった）
const rankOf = (k) => { const i = FAMILIAR.indexOf(k); return i < 0 ? FAMILIAR.length : i; };

// 1 つの基準物との比べ方：基本は高さ。横長の絵と横に長い物で、幅の方が 1 に近ければ幅。高さの無い物は幅
export function compareWith(sizeCm, item, key) {
  const [w, h] = sizeCm;
  const opts = [];
  if (item.height_cm) opts.push({ dim: 'height', ratio: h / item.height_cm, cm: item.height_cm });
  if (item.width_cm && (!item.height_cm || (w > h && WIDE.has(key)))) opts.push({ dim: 'width', ratio: w / item.width_cm, cm: item.width_cm });
  opts.sort((a, b) => Math.abs(Math.log(a.ratio)) - Math.abs(Math.log(b.ratio)));
  return opts[0] || null;
}

const DIM = { height: { ja: '高さ', en: 'height' }, width: { ja: '幅', en: 'width' } };

// 比較の文（ja / en）。withCm なら基準物の実寸を括弧で添える（数字を出す場所だけ）
export function compareSentence({ item, dim, ratio, cm }, { withCm = false, approx = false } = {}) {
  const f = fractionOf(ratio);
  const cmJa = withCm ? `（約 ${Math.round(cm)} cm）` : '', cmEn = withCm ? ` (about ${Math.round(cm)} cm)` : '';
  const d = DIM[dim];
  const sp = /\d$/.test(f.ja) ? ' ' : '';   // 「約 3 分の 1 の高さ」：数字のあとは半角スペース
  let ja = f.kind === 'same' ? `この${item.label.ja}${cmJa}と${f.ja}${d.ja}。` : `この${item.label.ja}${cmJa}の${f.ja}${sp}の${d.ja}。`;
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  let en = f.kind === 'same' ? `${cap(f.en)} ${d.en} as ${item.label.en}${cmEn}.` : `${cap(f.en)} the ${d.en} of ${item.label.en}${cmEn}.`;
  if (approx) { ja = ja.replace(/。$/, '（寸法は目安）。'); en = en.replace(/\.$/, ' (size is approximate).'); }
  return { ja, en };
}

// 部屋の文章：比較の一文、2 つ目の比較、部屋の説明、注記（ja / en）
/** @param {{ references: any[], table: any, sizeCm: number[], confidence: string | null, wallWidthCm: number, centerFromFloorCm: number, aboveFurniture?: boolean, place?: string | null }} args */
export function roomTexts({ references, table, sizeCm, confidence, wallWidthCm, centerFromFloorCm, aboveFurniture = false, place = null }) {
  const seen = new Set();
  const cands = [];
  for (const r of [...references].sort((a, b) => rankOf(a.ref.split('.')[0]) - rankOf(b.ref.split('.')[0]))) {
    const key = r.ref.split('.')[0];
    if (seen.has(key) || !table[key]) continue;
    seen.add(key);
    const c = compareWith(sizeCm, table[key], key);
    if (c) cands.push({ ...c, item: table[key], key });
  }
  const low = confidence === 'low';
  const compare = cands[0] ? compareSentence(cands[0], { approx: low }) : null;
  const compare2 = cands[1] ? compareSentence(cands[1], { withCm: true }) : null;
  const m = (wallWidthCm / 100).toFixed(1);
  const hc = Math.round(centerFromFloorCm / 5) * 5;
  const seated = centerFromFloorCm < 140;
  // 置く場面：掛ける高さではなく、何に置いたか
  const PLACE_ABOUT = {
    easel: { ja: '小さな卓上イーゼル（高さ約 28 cm）の受けに、絵の底を乗せて置いています。', en: 'The painting stands on a small tabletop easel (about 28 cm tall), resting on its ledge.' },
    lean: { ja: '棚の天板に絵の底を乗せ、壁に立てかけています。', en: 'The painting rests on the top of the shelf, leaning against the wall.' },
  };
  const about = place && PLACE_ABOUT[place] ? PLACE_ABOUT[place] : {
    ja: aboveFurniture
      ? `壁の幅は約 ${m} m。家具の上端から 20 cm ほど空けて掛けています（絵の中心は床から約 ${hc} cm）。`
      : `壁の幅は約 ${m} m。${seated ? '座ったときの目の高さ' : '目の高さ'}（床から約 ${hc} cm）に掛けています。`,
    en: aboveFurniture
      ? `The wall is about ${m} m wide. The painting hangs about 20 cm above the furniture (center about ${hc} cm from the floor).`
      : `The wall is about ${m} m wide. The painting hangs at ${seated ? 'seated eye level' : 'eye level'} (about ${hc} cm from the floor).`,
  };
  const note = {
    ja: '部屋は AI で作ったイメージで、寸法はだいたいこのくらい、という目安です。絵は実物の写真です。' + (low ? 'この部屋は縮尺の手がかりが不確かなので、特に大まかな目安です。' : ''),
    en: 'The room is an AI-generated image, and the size is a rough guide to how it might look. The painting is a real photo.' + (low ? ' The scale cues in this room are uncertain, so treat it as an especially rough guide.' : ''),
  };
  return { compare, compare2, about, note, primary_ref: cands[0]?.key || null };
}

// 確認用の重ね描き（SVG）：絵の枠（赤）、床の線（青、画像内のときだけ）、左上に縮尺の文字
function checkOverlaySvg({ width, height, quad, floorY, lines, ledgeY = null }) {
  const pts = quad.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  // 置く場面：受けの線（緑の破線）。絵の底（側面の帯の下端）がここに乗る
  const ledge = ledgeY != null && Number.isFinite(ledgeY) ? `<line x1="0" y1="${ledgeY.toFixed(1)}" x2="${width}" y2="${ledgeY.toFixed(1)}" stroke="#00b050" stroke-width="2" stroke-dasharray="10 6"/>` : '';
  const floor = Number.isFinite(floorY) && floorY >= 0 && floorY < height ? `<line x1="0" y1="${floorY.toFixed(1)}" x2="${width}" y2="${floorY.toFixed(1)}" stroke="#2060ff" stroke-width="3"/>` : '';
  const text = lines.map((l, i) => `<text x="16" y="${34 + i * 28}">${xmlEsc(l)}</text>`).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <polygon points="${pts}" fill="none" stroke="#ff2020" stroke-width="3"/>
  ${floor}
  ${ledge}
  <rect x="6" y="6" width="${Math.min(width - 12, 1100)}" height="${lines.length * 28 + 16}" fill="rgba(255,255,255,0.8)"/>
  <g font-family="Noto Sans CJK JP, WenQuanYi Zen Hei, sans-serif" font-size="20" fill="#111">${text}</g>
</svg>`);
}

export async function compositeRooms({ root, work, paintingPath, outDir }) {
  const roomsDir = join(root, 'rooms');
  if (!existsSync(roomsDir)) return [];
  const table = loadReferenceTable(roomsDir);
  // 部屋の指定が無ければ、作品の大きさ（長辺）に向いている部屋を、種類（category）ごとに 2 枚まで（ファイル名順）使う（suits_cm: [min, max]）
  const longSide = Math.max(...work.size_cm);
  const readDef = (n) => { const p = join(roomsDir, `${n}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; };
  let names = work.rooms;
  if (!names) {
    const perCat = {};
    // 置く部屋（hang.place）を、同じ種類の掛ける部屋より先に（小さな絵は置く方が浮かない。docs/PLACEMENT.md 6 節）
    const isPlace = (n) => (readDef(n).hang?.place ? 0 : 1);
    names = readdirSync(roomsDir).filter((f) => f.endsWith('.json') && f !== 'REFERENCES.json').map((f) => f.replace(/\.json$/, '')).sort().sort((a, b) => isPlace(a) - isPlace(b)).filter((n) => {
      const d = readDef(n);
      if (d.disabled) return false;   // 暗い部屋など、使わないと決めた部屋（11-07 作家「暗い部屋はやめた方がいい」）。work.json の rooms で明示しても使わない
      if (d.suits_cm && !(longSide >= d.suits_cm[0] && longSide <= d.suits_cm[1])) return false;
      const c = d.category || '';
      perCat[c] = (perCat[c] || 0) + 1;
      return perCat[c] <= (d.hang?.place ? 3 : 2);   // 置く部屋は種類ごとに 3 枚まで（小さな絵で desk-easel・entrance-console・shelf-lean。docs/PLACEMENT.md 6 節）
    });
  }
  const painting = await sharp(paintingPath).resize({ width: 800 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const checkDir = join(roomsDir, 'check');
  const results = [];
  for (const name of names) {
    const jsonPath = join(roomsDir, `${name}.json`);
    const imgPath = ['jpg', 'png', 'jpeg'].map((e) => join(roomsDir, `${name}.${e}`)).find(existsSync);
    if (!existsSync(jsonPath) || !imgPath) { console.warn(`  部屋 ${name} の json か画像が無い。スキップ`); continue; }
    const def = JSON.parse(readFileSync(jsonPath, 'utf8'));
    if (def.disabled) { console.warn(`  部屋 ${name} は使わない（${def.disabled}）。スキップ`); continue; }
    const room = await sharp(imgPath).resize({ width: 1600, withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = room.info.width, H = room.info.height;
    const scale = W / (def.image_width_px || W);
    const wall = { ...def.wall, corners_px: def.wall.corners_px.map(([x, y]) => [x * scale, y * scale]) };
    // 縮尺：references（基準物）から。無ければ従来の scale.px_per_cm 直書き（後方互換）
    let sc = null;
    if (def.references?.length) sc = scaleFromReferences(def.references, table, { wallFloorY: def.hang?.floor_y_px, horizonY: def.horizon_y_px });
    else if (def.scale?.px_per_cm) sc = { px_per_cm: def.scale.px_per_cm, deviation: null, confidence: def.scale.confidence || null, all: [] };
    let quad, pxPerCm = null, wallWidthCm = def.wall.width_cm;
    if (sc) {
      pxPerCm = sc.px_per_cm * scale;
      quad = paintingRectFromScale({ ...def, scale: { px_per_cm: sc.px_per_cm } }, work.size_cm, W);
      const wb = bbox(wall.corners_px), pb = bbox(quad);
      wallWidthCm = Math.round((wb.x1 - wb.x0) / pxPerCm);
      const eps = 0.5;
      if (pb.x0 < wb.x0 - eps || pb.y0 < wb.y0 - eps || pb.x1 > wb.x1 + eps || pb.y1 > wb.y1 + eps) {
        console.warn(`  部屋 ${name}：絵（${work.size_cm[0]}×${work.size_cm[1]}cm = ${Math.round(pb.x1 - pb.x0)}×${Math.round(pb.y1 - pb.y0)}px）が壁の範囲（${Math.round(wb.x0)},${Math.round(wb.y0)}〜${Math.round(wb.x1)},${Math.round(wb.y1)}px）からはみ出す。スキップ`);
        continue;
      }
    } else {
      // 従来の方式（後方互換）：壁幅 cm から縮尺を出す
      quad = paintingQuadOnWall(wall, work.size_cm);
    }
    const paintingRaw = { data: painting.data, width: painting.info.width, height: painting.info.height };
    const place = def.hang?.place && sc ? def.hang.place : null;
    // 置く場面は、壁に落とす影をやめて、側面の帯と接地の影にする（docs/PLACEMENT.md 6 節）
    let buf = warpOnto({ data: room.data, width: W, height: H }, paintingRaw, quad, place ? { shadow: 0 } : undefined);
    if (place) drawPlaceSides(buf, W, H, paintingRaw, quad, { place, pxPerCm, ledgeX: def.hang.ledge_x_px ? def.hang.ledge_x_px.map((v) => v * scale) : null });
    // 手前の物（紐、傘、花瓶）を絵の上に戻す。mask_png（白 = 手前）があればキーの代わりにそれを使う
    let fgAlpha = null, fgSource = '';
    const occ = def.occlusion;
    if (occ?.mask_png) {
      const mp = join(roomsDir, typeof occ.mask_png === 'string' ? occ.mask_png : `${name}_mask.png`);
      if (existsSync(mp)) { fgAlpha = await maskPngAlpha(mp, W, H); fgSource = 'mask_png'; }
      else console.warn(`  部屋 ${name}：mask_png（${mp}）が無い。壁色キーに戻す`);
    }
    if (!fgAlpha && occ?.mode === 'wall-key') fgAlpha = wallKeyAlpha({ data: room.data, width: W, height: H }, quad, { tolerance: occ.tolerance ?? 0.10 }).alpha;
    if (fgAlpha && !fgSource) fgSource = `wall-key tol=${occ.tolerance ?? 0.10}`;
    // 絵の矩形の中で手前の物が占める画素数（space.json の occlusion：絵の前に何かあるか）
    let frontPx = 0;
    if (fgAlpha) {
      buf = restoreForeground(buf, room.data, fgAlpha, quad, W, H);
      const qb = bbox(quad);
      for (let y = Math.max(0, Math.floor(qb.y0)); y < Math.min(H, Math.ceil(qb.y1)); y++) for (let x = Math.max(0, Math.floor(qb.x0)); x < Math.min(W, Math.ceil(qb.x1)); x++) if (fgAlpha[y * W + x] >= 0.5) frontPx++;
    }
    const raw = { raw: { width: W, height: H, channels: 3 } };
    // 絵の無い素の部屋（拡大表示で絵を別の層にしてドラッグで動かすため。docs/EXPERIENCE.md 4 節）。合成と同じリサイズの画素を書く
    const baseDir = join(root, 'public', 'rooms');
    mkdirSync(baseDir, { recursive: true });
    await sharp(room.data, raw).jpeg({ quality: 82 }).toFile(join(baseDir, `${name}.jpg`));
    const outName = `room_${name}.jpg`;
    await sharp(buf, raw).jpeg({ quality: 85 }).toFile(join(outDir, outName));

    // 確認用画像：rooms/check/<name>_<workId>.jpg
    if (sc) {
      mkdirSync(checkDir, { recursive: true });
      const pb = bbox(quad);
      const wPx = Math.round(pb.x1 - pb.x0), hPx = Math.round(pb.y1 - pb.y0);
      const lines = [
        `px/cm=${fmt(pxPerCm)}  絵 ${work.size_cm[0]}×${work.size_cm[1]}cm = ${wPx}×${hPx}px  confidence=${sc.confidence || '?'}${sc.deviation != null ? `（ずれ ${(sc.deviation * 100).toFixed(1)}%）` : ''}`,
        ...sc.all.map((r) => `${r.primary ? '主 ' : '　 '}${r.ref} ${r.px}px = ${r.cm}cm${r.depth !== 1 ? ` × 奥行き ${r.depth.toFixed(2)}` : ''} → ${fmt(r.pxPerCm)}`),
        ...(!sc.all.length && def.scale?.basis?.ja ? [`basis=${def.scale.basis.ja}`] : []),
      ];
      if (fgAlpha) lines.push(`手前の物（緑）：${fgSource}  絵の前 ${frontPx}px`);
      if (place) {
        const s = placeSidesPx(place, pxPerCm);
        lines.push(`置く（${place}）：受け y=${fmt(def.hang.ledge_y_px * scale)}  側面 下 ${fmt(s.bottom)}px（${SIDE_BOTTOM_CM}cm×${SIDE_VIEW}）${s.right ? `・右 ${fmt(s.right)}px` : ''}  接地の影 ${fmt(s.shadow)}px  高さ ${PLACE[place].height} 倍・上辺 ${1 - PLACE[place].taper} 倍`);
      }
      const svg = checkOverlaySvg({ width: W, height: H, quad, floorY: def.hang.floor_y_px * scale, lines, ledgeY: place ? def.hang.ledge_y_px * scale : null });
      // 手前の物のマスクを緑（50%）で重ねる
      let checkBuf = buf;
      if (fgAlpha) {
        checkBuf = Buffer.from(buf);
        const green = [0, 220, 60];
        for (let i = 0; i < W * H; i++) {
          const a = fgAlpha[i] * 0.5;
          if (a <= 0) continue;
          for (let c = 0; c < 3; c++) checkBuf[i * 3 + c] = Math.round(checkBuf[i * 3 + c] * (1 - a) + green[c] * a);
        }
      }
      await sharp(checkBuf, raw).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 85 }).toFile(join(checkDir, `${name}_${work.id}.jpg`));
    }

    // 顧客向けの文章（ja / en。他の言語は index.js で翻訳キャッシュから）
    const texts = def.references?.length
      ? roomTexts({ references: def.references, table, sizeCm: work.size_cm, confidence: sc.confidence, wallWidthCm, centerFromFloorCm: place ? 0 : hangCenterCm(def, work.size_cm, quad, pxPerCm, scale), aboveFurniture: def.hang.bottom_from_floor_cm != null || (def.hang.furniture_top_y_px != null && (def.hang.center_from_floor_cm == null || hangCenterCm(def, work.size_cm, quad, pxPerCm, scale) > def.hang.center_from_floor_cm)), place })
      : { compare: null, compare2: null, about: null, note: null, primary_ref: null };

    results.push({
      name, image: outName, base: `rooms/${name}.jpg`, ...(def.category ? { category: def.category } : {}), label: def.label || { ja: name }, wall_width_cm: wallWidthCm,
      image_px: [W, H], quad_px: quad.map(([x, y]) => [Math.round(x), Math.round(y)]),
      // 終わりの画面で絵と一緒に必ず見せる範囲（比較の相手。roomArt.ts の roomBox）
      ...(Array.isArray(def.keep_px) ? { keep_px: def.keep_px.map((v) => Math.round(v * scale)) } : {}),
      ...(sc ? { px_per_cm: +pxPerCm.toFixed(3), confidence: sc.confidence || null } : {}),
      occlusion: frontPx > 0,
      // 拡大表示で動かせる範囲（画像の px）：壁の範囲。家具の上端（furniture_top_y_px）より下には下げない（11-07 作家「椅子の手前に絵が来るとおかしい」）。置く場面は受けの幅
      move_px: (() => {
        const wb = bbox(wall.corners_px);
        let [x0, y0, x1, y1] = [wb.x0, wb.y0, wb.x1, wb.y1];
        if (def.hang.furniture_top_y_px != null) y1 = Math.min(y1, def.hang.furniture_top_y_px * scale);
        if (place && def.hang.ledge_x_px) [x0, x1] = def.hang.ledge_x_px.map((v) => v * scale);
        return [x0, y0, x1, y1].map((v) => Math.round(Math.min(Math.max(v, 0), v === x0 || v === x1 ? W : H)));
      })(),
      // 置く場面（拡大表示では横にだけ動かす。帯の色は絵の層の下に敷く）
      ...(place ? (() => { const s = placeSidesPx(place, pxPerCm); return { place, side_color: sideColorHex(paintingRaw), sides_px: { bottom: +s.bottom.toFixed(1), right: +s.right.toFixed(1), shadow: +s.shadow.toFixed(1) } }; })() : {}),
      ...texts,
    });
  }
  return results;
}
