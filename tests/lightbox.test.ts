import { describe, it, expect } from 'vitest';
import { clampOffset, quadRect } from '../src/ui/lightbox';

// 部屋で見る：拡大表示で絵を動かす範囲（docs/EXPERIENCE.md 4 節「絵を動かせる」）
describe('絵の移動量のクランプ', () => {
  const r = quadRect([[635, 195], [815, 195], [815, 349], [635, 349]]);   // itadaki × entrance-house
  const [iw, ih] = [1586, 992];
  it('4 隅から軸に平行な矩形', () => {
    expect(r).toEqual({ x0: 635, y0: 195, x1: 815, y1: 349 });
  });
  it('範囲の中ならそのまま', () => {
    expect(clampOffset(100, -50, r, iw, ih)).toEqual([100, -50]);
  });
  it('左上・右下の端で止まる（部屋の画像からはみ出さない）', () => {
    expect(clampOffset(-9999, -9999, r, iw, ih)).toEqual([-635, -195]);
    expect(clampOffset(9999, 9999, r, iw, ih)).toEqual([iw - 815, ih - 349]);
  });
  it('どこに動かしても絵の大きさは変わらない', () => {
    for (const [dx, dy] of [[-9999, 0], [0, 9999], [123.4, -56.7]]) {
      const [ox, oy] = clampOffset(dx, dy, r, iw, ih);
      const x0 = r.x0 + ox, x1 = r.x1 + ox, y0 = r.y0 + oy, y1 = r.y1 + oy;
      expect(x1 - x0).toBe(180); expect(y1 - y0).toBe(154);
      expect(x0).toBeGreaterThanOrEqual(0); expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(iw); expect(y1).toBeLessThanOrEqual(ih);
    }
  });
  it('絵が画像より大きいときは中央に（壊れない）', () => {
    expect(clampOffset(50, 50, { x0: -10, y0: 0, x1: 110, y1: 50 }, 100, 50)).toEqual([0, 0]);
  });
});

// 動かせる範囲（move_px）：壁の範囲に限る（11-07 作家「椅子の手前に絵が来るとおかしい」）
import { clampOffset as clampB } from '../src/ui/lightbox';
describe('clampOffset with bounds', () => {
  const r = { x0: 100, y0: 100, x1: 200, y1: 180 };
  it('壁の範囲より下（家具の手前）には下げられない', () => {
    expect(clampB(0, 500, r, 1000, 1000, false, [50, 0, 900, 400])).toEqual([0, 220]);
  });
  it('壁の左右の端で止まる', () => {
    expect(clampB(-500, 0, r, 1000, 1000, false, [50, 0, 900, 400])).toEqual([-50, 0]);
    expect(clampB(5000, 0, r, 1000, 1000, false, [50, 0, 900, 400])).toEqual([700, 0]);
  });
  it('範囲が無ければ画像全体', () => {
    expect(clampB(5000, 5000, r, 1000, 1000)).toEqual([800, 820]);
  });
});

// 絵の層の置き方（src/ui/roomArt.ts。拡大表示と T5 の終わりで共通）
import { pctBox, coverBox, canMove, roomBox } from '../src/ui/roomArt';
describe('roomArt の純関数', () => {
  it('画像の px の矩形を枠の % に', () => {
    expect(pctBox({ x0: 400, y0: 800, x1: 800, y1: 1200 }, 1600, 1600)).toEqual([25, 50, 25, 25]);
  });
  it('cover：縦長の画面では高さで合わせ、横は中央でははみ出す', () => {
    const b = coverBox(1600, 1600, 390, 844);
    expect(b.k).toBeCloseTo(844 / 1600); expect(b.h).toBeCloseTo(844); expect(b.y).toBeCloseTo(0);
    expect(b.x).toBeCloseTo((390 - 844) / 2);
  });
  it('cover：横長の画面では幅で合わせる', () => {
    const b = coverBox(1600, 1600, 1280, 800);
    expect(b.k).toBeCloseTo(0.8); expect(b.x).toBeCloseTo(0); expect(b.y).toBeCloseTo((800 - 1280) / 2);
  });
  it('T5 の演出の終点と絵の層の初期位置が一致する（quad の外接矩形 × cover）', () => {
    const quad: [number, number][] = [[697, 623], [903, 623], [906, 781], [694, 781]];
    const b = coverBox(1600, 1600, 390, 844);
    const [l, t, w, h] = pctBox({ x0: 694, y0: 623, x1: 906, y1: 781 }, 1600, 1600);
    // StoryMode.roomLayout と同じ式で画面の矩形を出す
    const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
    expect(b.x + (l / 100) * b.w).toBeCloseTo(Math.min(...xs) * b.k + b.x);
    expect(b.y + (t / 100) * b.h).toBeCloseTo(Math.min(...ys) * b.k + b.y);
    expect((w / 100) * b.w).toBeCloseTo((Math.max(...xs) - Math.min(...xs)) * b.k);
    expect((h / 100) * b.h).toBeCloseTo((Math.max(...ys) - Math.min(...ys)) * b.k);
  });
  it('素の部屋が無い・手前に物がある部屋は動かさない（合成画像のまま）', () => {
    const room = { name: 'a', image: 'a.jpg', label: {}, wall_width_cm: 300, image_px: [1600, 1600] as [number, number], quad_px: [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][] };
    expect(canMove(room as never, 'rooms/a.jpg', 'p.jpg')).toBe(true);
    expect(canMove(room as never, null, 'p.jpg')).toBe(false);
    expect(canMove({ ...room, occlusion: true } as never, 'rooms/a.jpg', 'p.jpg')).toBe(false);
  });
});

describe('roomBox（T5 の部屋の置き方。比較の相手を切らない）', () => {
  const quad: [number, number][] = [[635, 195], [815, 195], [815, 349], [635, 349]];
  const door: [number, number, number, number] = [1115, 85, 1385, 770];
  const inside = (b: ReturnType<typeof roomBox>, x: number, vw: number) => { const p = x * b.k + b.x; return p >= 0 && p <= vw; };
  it('keep が無ければ cover のまま', () => {
    expect(roomBox(1586, 992, 390, 844, quad)).toEqual(coverBox(1586, 992, 390, 844));
  });
  for (const [vw, vh] of [[390, 844], [375, 667], [768, 1024]] as const) {
    it(`縦長 ${vw}×${vh}：絵とドアが両方入る`, () => {
      const b = roomBox(1586, 992, vw, vh, quad, door, 170);
      for (const x of [635, 815, 1115, 1385]) expect(inside(b, x, vw)).toBe(true);
      expect(b.y).toBeGreaterThanOrEqual(0);
    });
  }
  it('横長：cover で両方入るなら cover のまま', () => {
    expect(roomBox(1586, 992, 1280, 720, quad, door, 170)).toEqual(coverBox(1586, 992, 1280, 720));
  });
  it('高さが余ったら帯を除いた場所の中央', () => {
    const b = roomBox(1586, 992, 390, 844, quad, door, 170);
    expect(b.y).toBeCloseTo((844 - 170 - b.h) / 2);
  });
});
