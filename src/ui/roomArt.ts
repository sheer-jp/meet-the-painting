// 部屋の中で絵を動かす層（docs/EXPERIENCE.md 4 節「絵を動かせる」、3 節 T5）
// 素の部屋（room.base）の上に、絵の実物の写真を quad_px の位置に別の層として置き、指・マウスのドラッグと矢印キーで動かす。
// 拡大表示（lightbox.ts）と物語モードの終わり（StoryMode.ts の T5）の両方から使う。位置は保存しない
import type { Room } from '../experience/types';

const KEY_STEP = 10;    // 矢印キーで絵を動かす量（画像の px）
const DRAG_MIN = 3;     // これより動いたら「動かした」とみなす（画面の px）

export interface Rect { x0: number; y0: number; x1: number; y1: number }
// 4 隅から軸に平行な矩形
export function quadRect(q: [number, number][]): Rect {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
// 絵の移動量（画像の px）を、絵が部屋の画像（iw × ih）の内側に収まる範囲に切り詰める。大きさは変えない
// horizontalOnly：置く場面（イーゼル・棚）。下端は受けに乗ったまま、横にだけ動かす（docs/PLACEMENT.md 6 節）
// bounds：動かせる範囲 [x0, y0, x1, y1]（space.json の move_px。壁の範囲で、家具の手前には出さない）。無ければ画像全体
export function clampOffset(dx: number, dy: number, r: Rect, iw: number, ih: number, horizontalOnly = false, bounds?: [number, number, number, number]): [number, number] {
  const c = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  const [bx0, by0, bx1, by1] = bounds && bounds[2] > bounds[0] && bounds[3] > bounds[1] ? bounds : [0, 0, iw, ih];
  return [c(dx, bx0 - r.x0, bx1 - r.x1), horizontalOnly ? 0 : c(dy, by0 - r.y0, by1 - r.y1)];
}
// 画像の px の矩形 → 枠に対する %（left, top, width, height）。枠の拡大 transform にそのまま乗る
export function pctBox(r: Rect, iw: number, ih: number): [number, number, number, number] {
  return [(r.x0 / iw) * 100, (r.y0 / ih) * 100, ((r.x1 - r.x0) / iw) * 100, ((r.y1 - r.y0) / ih) * 100];
}
// 部屋の画像を画面（vw × vh）いっぱいに cover で置いたときの位置と倍率（画面の px / 画像の px）。T5 の部屋と同じ置き方
export function coverBox(iw: number, ih: number, vw: number, vh: number): { x: number; y: number; w: number; h: number; k: number } {
  const k = Math.max(vw / iw, vh / ih);
  return { x: (vw - iw * k) / 2, y: (vh - ih * k) / 2, w: iw * k, h: ih * k, k };
}
// T5 の部屋の置き方。ふつうは cover。keep（画像の px の矩形。比較の相手）があって cover だと絵と一緒に入らないときだけ、両方が幅に収まるまで引く。
// 引いて高さが余ったら、下の帯（reserveBottom）を除いた場所の中央に置く（周りは紙白）
export function roomBox(iw: number, ih: number, vw: number, vh: number, quad: [number, number][], keep?: [number, number, number, number] | null, reserveBottom = 0): { x: number; y: number; w: number; h: number; k: number } {
  const cover = coverBox(iw, ih, vw, vh);
  if (!keep) return cover;
  const r = quadRect(quad);
  const x0 = Math.min(r.x0, keep[0]), x1 = Math.max(r.x1, keep[2]);
  const inCover = x0 * cover.k + cover.x >= 0 && x1 * cover.k + cover.x <= vw;
  if (inCover) return cover;
  const margin = 24;   // 比較の相手が画面の端に貼りつかないように（画面の px）
  const k = Math.min(cover.k, (vw - margin * 2) / (x1 - x0));
  const w = iw * k, h = ih * k;
  // 横：絵と比較の相手の真ん中を画面の中央に。ただし画像の外（紙白）をなるべく見せない
  const want = vw / 2 - ((x0 + x1) / 2) * k;
  const x = w >= vw ? Math.min(0, Math.max(vw - w, want)) : (vw - w) / 2;
  const y = h >= vh ? (vh - h) / 2 : Math.max(0, (vh - reserveBottom - h) / 2);
  return { x, y, w, h, k };
}
// 素の部屋 + 絵の層にできる部屋か（無ければ従来どおり合成画像）
export function canMove(room: Room | undefined | null, base: string | null | undefined, painting: string | null | undefined): boolean {
  return !!(room && base && painting && !room.occlusion && room.quad_px && room.image_px);
}

export interface RoomArtOptions {
  frame: HTMLElement;          // 部屋の画像と同じ大きさの枠（position: relative か absolute）。層はこの中に置く
  painting: string;            // 絵の写真の URL（painting_1024.jpg）
  label: string;               // 絵の層の読み上げ（「絵の位置。ドラッグか矢印キーで動かせます」）
  fitK: () => number;          // 枠の画面の px / 画像の px（拡大 transform を除く）
  zoom?: () => number;         // 枠に掛かっている拡大率（拡大表示の 2×。無ければ 1）
  onMove?: (off: [number, number]) => void;   // 利用者が実際に動かしたとき（案内を消す、寸法線を描き直す）
}
export interface RoomArt {
  el: HTMLImageElement;
  set(room: Room | null): void;     // この部屋で絵を出す（null なら隠す）。位置は元に戻す
  place(): void;                    // 枠の大きさが変わったら置き直す（接地の影は画面の px なので）
  move(dx: number, dy: number): void;   // 移動量を決めて置く（範囲に切り詰める）
  offset(): [number, number];
  dispose(): void;
}

export function mountRoomArt(o: RoomArtOptions): RoomArt {
  const { frame } = o;
  let room: Room | null = null;
  let off: [number, number] = [0, 0];
  // 置く場面では、絵の層の下に側面の帯と接地の影を敷く（合成画像と同じ見え方に。帯の色と大きさは space.json から）
  const sides = document.createElement('div'); sides.className = 'lb-art-sides'; sides.hidden = true;
  sides.style.position = 'absolute'; sides.style.pointerEvents = 'none';
  const art = document.createElement('img'); art.className = 'lb-art'; art.alt = ''; art.draggable = false; art.hidden = true;
  art.tabIndex = 0; art.setAttribute('role', 'img'); art.setAttribute('aria-label', o.label);
  frame.append(sides, art);

  function place() {
    if (!room || !room.quad_px || !room.image_px) return;
    const [iw, ih] = room.image_px;
    const q = quadRect(room.quad_px);
    const r = { x0: q.x0 + off[0], y0: q.y0 + off[1], x1: q.x1 + off[0], y1: q.y1 + off[1] };
    const [l, t, w, h] = pctBox(r, iw, ih);
    art.style.left = `${l}%`; art.style.top = `${t}%`; art.style.width = `${w}%`; art.style.height = `${h}%`;
    const sp = room.sides_px;
    if (room.place && sp) {
      // 帯：絵の矩形を下に sp.bottom、右に sp.right 広げた箱。絵の層の下にあるので、見えるのは帯だけ
      const [sl, st, sw, sh] = pctBox({ x0: r.x0, y0: r.y0, x1: r.x1 + sp.right, y1: r.y1 + sp.bottom }, iw, ih);
      sides.style.left = `${sl}%`; sides.style.top = `${st}%`; sides.style.width = `${sw}%`; sides.style.height = `${sh}%`;
      sides.style.background = room.side_color || '#555';
      // 接地の影：箱の下にだけ落とす（画面の px に直す）
      const s = sp.shadow * (o.fitK() || 1);
      sides.style.boxShadow = `0 ${(s * 0.5).toFixed(1)}px ${(s * 0.8).toFixed(1)}px ${(-s * 0.1).toFixed(1)}px rgba(0,0,0,0.45)`;
    }
  }
  function setOff(dx: number, dy: number) {
    if (!room || !room.quad_px || !room.image_px) return;
    const [iw, ih] = room.image_px;
    off = clampOffset(dx, dy, quadRect(room.quad_px), iw, ih, !!room.place, room.move_px);
    place();
  }
  function set(r: Room | null) {
    room = r; off = [0, 0]; drag = null; art.classList.remove('dragging');
    art.hidden = !r; sides.hidden = !(r && r.place && r.sides_px);
    art.style.boxShadow = r?.place ? 'none' : '';   // 置く場面は壁に落とす影（page.css）をやめ、帯と接地の影に
    if (r) { if (art.getAttribute('src') !== o.painting) art.src = o.painting; place(); }
  }

  // ---- 操作：絵の上から始まるドラッグは絵を動かす（下の層の拡大・パン・スワイプ・流体には渡さない） ----
  let drag: { id: number; x: number; y: number; off: [number, number]; moved: boolean } | null = null;
  const down = (e: PointerEvent) => {
    if (!room || e.button > 0) return;
    e.stopPropagation(); e.preventDefault();
    if (drag) return;   // 2 本目の指は無視（絵の上ではピンチしない）
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, off: [off[0], off[1]], moved: false };
    try { art.setPointerCapture(e.pointerId); } catch {}
    art.classList.add('dragging');
  };
  const moveEv = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    const s = (o.fitK() * (o.zoom?.() ?? 1)) || 1;   // 画面の px → 画像の px（枠は zoom 倍に拡大されている）
    setOff(drag.off[0] + dx / s, drag.off[1] + dy / s);
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_MIN) drag.moved = true;
    if (drag.moved) o.onMove?.(off);
  };
  const up = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    drag = null; art.classList.remove('dragging');
  };
  const key = (e: KeyboardEvent) => {
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = d[e.key]; if (!v || !room) return;
    e.preventDefault(); e.stopPropagation();
    if (room.place && v[1] !== 0) return;   // 置く場面は縦に動かさない
    setOff(off[0] + v[0] * KEY_STEP, off[1] + v[1] * KEY_STEP);
    o.onMove?.(off);
  };
  const stop = (e: Event) => e.stopPropagation();   // 絵のダブルクリックでは拡大しない（動かす操作と紛れる）
  art.addEventListener('pointerdown', down);
  art.addEventListener('pointermove', moveEv);
  art.addEventListener('pointerup', up);
  art.addEventListener('pointercancel', up);
  art.addEventListener('dblclick', stop);
  art.addEventListener('keydown', key);

  return {
    el: art, set, place,
    move: (dx, dy) => setOff(dx, dy),
    offset: () => [off[0], off[1]],
    dispose() { art.remove(); sides.remove(); },
  };
}

// ---- 「絵を動かせる」の小さなポップ（P-12、11-07 作家）----
// 置く場面（イーゼル・立てかけ）と、動かせる幅（move_px）が絵の幅の 1.2 倍より狭い部屋では出さない（実質動かない）
export function popWorthy(room: Room | null | undefined): boolean {
  if (!room || room.place || !room.quad_px) return false;
  const b = room.move_px;
  if (!b || !(b[2] > b[0])) return true;   // 範囲が無ければ画像全体を動ける
  const r = quadRect(room.quad_px);
  return b[2] - b[0] >= (r.x1 - r.x0) * 1.2;
}

const POP_DELAY = 400;     // 開いてから出るまで
const POP_DIM = 3000;      // 出てから薄くなるまで
const POP_GAP = 8;         // 絵の上辺（下辺）とポップの間
const POP_EDGE = 8;        // 画面の端からの余白

export interface DragPop { hide(): void; dispose(): void }
// 絵の層（art）のすぐ上・中央に吹き出しを出す。位置は出たときに決め、絵と一緒には動かない（ドラッグで hide）。
// 上に入らない（絵が上端に近い）ときは絵の下に出す。parent は position: fixed の層を置ける要素（拡大表示・HUD）
export function mountDragPop(parent: HTMLElement, art: HTMLElement, text: string, minTop = POP_EDGE): DragPop {
  const pop = document.createElement('div'); pop.className = 'drag-pop'; pop.setAttribute('aria-hidden', 'true'); pop.textContent = text;
  let t1 = 0, t2 = 0, t3 = 0, gone = false;
  const placePop = () => {
    const r = art.getBoundingClientRect();
    if (!r.width) return false;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let top = r.top - POP_GAP - h, below = false;
    if (top < minTop) { top = r.bottom + POP_GAP; below = true; }
    const cx = r.left + r.width / 2;
    const left = Math.min(innerWidth - POP_EDGE - w, Math.max(POP_EDGE, cx - w / 2));
    pop.classList.toggle('below', below);
    pop.style.left = `${Math.round(left)}px`; pop.style.top = `${Math.round(top)}px`;
    pop.style.setProperty('--ax', `${Math.round(Math.min(w - 12, Math.max(12, cx - left)))}px`);   // 三角は絵の中央を指す
    return true;
  };
  t1 = window.setTimeout(() => {
    if (gone) return;
    parent.appendChild(pop);
    if (!placePop()) { pop.remove(); return; }
    requestAnimationFrame(() => pop.classList.add('on'));
    t2 = window.setTimeout(() => pop.classList.add('dim'), POP_DIM);
  }, POP_DELAY);
  return {
    hide() {
      if (gone) return; gone = true; clearTimeout(t1); clearTimeout(t2);
      pop.classList.remove('on'); pop.classList.add('gone');
      t3 = window.setTimeout(() => pop.remove(), 400);
    },
    dispose() { gone = true; clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); pop.remove(); },
  };
}
