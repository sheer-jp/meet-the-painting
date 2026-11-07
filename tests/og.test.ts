import { describe, it, expect } from 'vitest';
import { layoutRow, layoutSingle, intBox, OG_W, OG_H, textToPath, fontCovers } from '../scripts/generate/og.js';
import { jaEnTitle } from '../scripts/generate/pages.js';

// いまの 6 作品（幅 cm と写真の縦横比）
const SIX = [
  { wCm: 18, aspect: 18 / 14 }, { wCm: 53, aspect: 53 / 65.2 }, { wCm: 33.3, aspect: 33.3 / 24.2 },
  { wCm: 53, aspect: 53 / 45.5 }, { wCm: 18, aspect: 18 / 14 }, { wCm: 18, aspect: 18 / 14 },
];

describe('SNS カードの配置（ギャラリー：横一列）', () => {
  const opt = { width: OG_W, padX: 72, top: 120, bottom: 500, gap: 40 };
  const { pxPerCm, boxes } = layoutRow(SIX, opt);
  it('実寸比：1 cm あたりの px が全作品で同じ、縦横比は写真のまま', () => {
    boxes.forEach((b, i) => {
      expect(b.w / SIX[i].wCm).toBeCloseTo(pxPerCm, 6);
      expect(b.w / b.h).toBeCloseTo(SIX[i].aspect, 6);
    });
  });
  it('間隔は均等、下端は揃う', () => {
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].x - (boxes[i - 1].x + boxes[i - 1].w)).toBeCloseTo(40, 6);
    for (const b of boxes) expect(b.y + b.h).toBeCloseTo(500, 6);
  });
  it('列は左右中央で、余白と上端の下限の内側に収まる', () => {
    const left = boxes[0].x, right = OG_W - (boxes.at(-1)!.x + boxes.at(-1)!.w);
    expect(left).toBeCloseTo(right, 6);
    expect(left).toBeGreaterThanOrEqual(72 - 1e-6);
    for (const b of boxes) expect(b.y).toBeGreaterThanOrEqual(120 - 1e-6);
  });
  it('背の高い絵が混じると高さで決まる（それでも実寸比と下端は保つ）', () => {
    const tall = [{ wCm: 10, aspect: 0.25 }, { wCm: 10, aspect: 1 }];
    const r = layoutRow(tall, opt);
    expect(r.pxPerCm).toBeCloseTo(380 / 40, 6);
    expect(r.boxes[0].y).toBeCloseTo(120, 6);
    expect(r.boxes[1].y + r.boxes[1].h).toBeCloseTo(500, 6);
    expect(r.boxes[0].x - 0 + r.boxes[1].x + r.boxes[1].w).toBeCloseTo(OG_W, 6);   // 中央
  });
  it('1 点・0 点', () => {
    const one = layoutRow([{ wCm: 20, aspect: 1 }], opt);
    expect(one.boxes[0].x + one.boxes[0].w / 2).toBeCloseTo(OG_W / 2, 6);
    expect(layoutRow([], opt).boxes).toEqual([]);
  });
  it('整数に丸めても縦横比はほぼ保ち、下端は揃う', () => {
    boxes.forEach((b, i) => {
      const ib = intBox(b, SIX[i].aspect);
      expect(Math.abs(ib.w / ib.h - SIX[i].aspect)).toBeLessThan(0.02);
      expect(Math.abs(ib.y + ib.h - 500)).toBeLessThanOrEqual(1);
    });
  });
});

describe('SNS カードの配置（作品：中央に 1 点）', () => {
  it('高さはカードの 60%、中央', () => {
    const b = layoutSingle(53 / 45.5);
    expect(b.h).toBeCloseTo(OG_H * 0.6, 6);
    expect(b.x + b.w / 2).toBeCloseTo(OG_W / 2, 6);
    expect(b.y + b.h / 2).toBeCloseTo(OG_H / 2, 6);
    expect(b.w / b.h).toBeCloseTo(53 / 45.5, 6);
  });
  it('横に長すぎる絵は幅で抑える（比は保つ）', () => {
    const b = layoutSingle(4);
    expect(b.w).toBeCloseTo(OG_W * 0.7, 6);
    expect(b.w / b.h).toBeCloseTo(4, 6);
  });
});

describe('カードの文字（Shippori Mincho の部分集合）', () => {
  it('ブランド名と題名の字がある', () => {
    expect(fontCovers('SHEER Gallery')).toBe(true);
    expect(fontCovers('Meet the Painting by SHEER')).toBe(true);
    expect(fontCovers('内なる心に咲く花よ　18 × 14 cm')).toBe(true);
  });
  it('パスにでき、幅は字数とともに伸びる', () => {
    const a = textToPath('SHEER', 0, 0, 20), b = textToPath('SHEER Gallery', 0, 0, 20);
    expect(a.d).toMatch(/^M/);
    expect(b.width).toBeGreaterThan(a.width);
  });
});

describe('<title> の二言語', () => {
  it('ja と en が同じなら 1 回だけ', () => {
    expect(jaEnTitle('SHEER Gallery', 'SHEER Gallery')).toBe('SHEER Gallery');
    expect(jaEnTitle('Golden Path', '')).toBe('Golden Path');
    expect(jaEnTitle('頂', 'Summit')).toBe('頂 / Summit');
  });
});
