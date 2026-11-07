import { describe, it, expect } from 'vitest';
import { kmeans, toHex, textColor, backColor, brightCenter } from '../scripts/generate/color.js';
import { structureTensorFlow, motionFromFlow, reliefFromGray } from '../scripts/generate/flow.js';
import { homographyFromUnitSquare, invert3, paintingQuadOnWall, paintingRectFromScale, wallKeyAlpha, restoreForeground, warpOnto, fractionOf, confidenceFrom, scaleFromReferences, roomTexts } from '../scripts/generate/rooms.js';
import { key } from '../scripts/generate/translate.js';
import { normalizeLang, pickLang } from '../src/i18n/normalize';
import { publishedStory } from '../scripts/generate/story.js';
import { UI_JA } from '../scripts/generate/pages.js';
import ui from '../src/i18n/ui.json';
import { readFileSync } from 'node:fs';

describe('主要色', () => {
  it('2 色の画像から 2 色を面積順に取る', () => {
    const px = new Uint8Array(100 * 3);
    for (let i = 0; i < 100; i++) { const red = i < 70; px[i * 3] = red ? 250 : 10; px[i * 3 + 1] = red ? 10 : 10; px[i * 3 + 2] = red ? 10 : 240; }
    const p = kmeans(px, 2);
    expect(p.length).toBe(2);
    expect(p[0].area).toBeCloseTo(0.7, 1);
    expect(toHex(p[0].rgb)).toBe('#fa0a0a');
  });
  it('文字色は最も明るい色をさらに明るく、基調色は面積最大の色を暗く', () => {
    const palette = [{ rgb: [100, 50, 20], area: 0.6 }, { rgb: [200, 200, 180], area: 0.4 }];
    expect(textColor(palette)).toBe('#e9e9e1');
    expect(backColor(palette)).toBe('#231207');
  });
});

describe('筆致の流れ場', () => {
  it('水平の縞では筆致の方向が水平になる', () => {
    const w = 32, h = 32; const g = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = (Math.floor(y / 4) % 2) * 200;
    const f = structureTensorFlow(g, w, h, 2);
    const i = 16 * w + 16;
    expect(Math.abs(f.cos[i])).toBeGreaterThan(0.95);   // 水平（±）
    expect(Math.abs(f.sin[i])).toBeLessThan(0.3);
  });
  it('平坦な画像では強さが 0、動きは最小', () => {
    const w = 16, h = 16; const g = new Float32Array(w * h).fill(120);
    const f = structureTensorFlow(g, w, h, 2);
    expect(Math.max(...f.str)).toBe(0);
    expect(motionFromFlow(f).speed).toBe(0.25);
  });
});

describe('絵の具の厚みと渦の中心', () => {
  it('厚みは 0〜1。平坦な所は 0、筆のあと（細かい縞）は盛り上がる', () => {
    const w = 64, h = 32; const g = new Float32Array(w * h).fill(120);
    for (let y = 0; y < h; y++) for (let x = 32; x < w; x++) g[y * w + x] = (x % 4 < 2) ? 40 : 200;
    const r = reliefFromGray(g, w, h, null);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(0); expect(Math.max(...r)).toBeLessThanOrEqual(1);
    expect(r[16 * w + 8]).toBeLessThan(0.05);
    expect(r[16 * w + 48]).toBeGreaterThan(0.3);
  });
  it('最も明るい主要色の重心を UV（v は下 → 上）で返す', () => {
    const w = 10, h = 10; const px = new Uint8Array(w * h * 3).fill(30);
    for (let y = 0; y < 2; y++) for (let x = 8; x < 10; x++) px.set([250, 250, 240], (y * w + x) * 3);   // 右上に白
    const c = brightCenter(px, w, h, [{ rgb: [30, 30, 30], area: 0.96 }, { rgb: [250, 250, 240], area: 0.04 }]);
    expect(c[0]).toBeCloseTo(0.9, 2); expect(c[1]).toBeCloseTo(0.9, 2);
    expect(brightCenter(px, w, h, [])).toEqual([0.5, 0.5]);
  });
});

describe('部屋の射影', () => {
  it('単位正方形 → 4 点 の射影は角を正しく写す', () => {
    const q = [[10, 20], [110, 25], [100, 120], [12, 110]] as [[number, number], [number, number], [number, number], [number, number]];
    const H = homographyFromUnitSquare(q);
    const map = (u: number, v: number) => { const x = H[0] * u + H[1] * v + H[2], y = H[3] * u + H[4] * v + H[5], w = H[6] * u + H[7] * v + H[8]; return [x / w, y / w]; };
    expect(map(0, 0)[0]).toBeCloseTo(10); expect(map(1, 0)[1]).toBeCloseTo(25); expect(map(1, 1)[0]).toBeCloseTo(100); expect(map(0, 1)[1]).toBeCloseTo(110);
    const Hi = invert3(H);
    const [x, y] = map(0.3, 0.7);
    const w = Hi[6] * x + Hi[7] * y + Hi[8];
    expect((Hi[0] * x + Hi[1] * y + Hi[2]) / w).toBeCloseTo(0.3); expect((Hi[3] * x + Hi[4] * y + Hi[5]) / w).toBeCloseTo(0.7);
  });
  it('壁幅 300cm の正面の壁に 30cm の絵は幅 1/10 で置かれる', () => {
    const wall = { corners_px: [[0, 0], [1000, 0], [1000, 600], [0, 600]], width_cm: 300, hang_center_ratio: [0.5, 0.5] };
    const q = paintingQuadOnWall(wall, [30, 18]);
    expect(q[1][0] - q[0][0]).toBeCloseTo(100);
    expect(q[3][1] - q[0][1]).toBeCloseTo(60);
  });
  it('px/cm=4 で 50×60cm の絵は 200×240px、中心は床から 150cm 上', () => {
    const def = { scale: { px_per_cm: 4 }, hang: { x_px: 500, floor_y_px: 800, center_from_floor_cm: 150 } };
    const q = paintingRectFromScale(def, [50, 60]);
    expect(q[1][0] - q[0][0]).toBeCloseTo(200);
    expect(q[3][1] - q[0][1]).toBeCloseTo(240);
    expect((q[0][0] + q[2][0]) / 2).toBeCloseTo(500);
    expect((q[0][1] + q[2][1]) / 2).toBeCloseTo(200);
    expect(q[2][0]).toBeGreaterThan(q[3][0]); // 左上から時計回り
  });
  it('正方形の画像（image_width_px と同じ幅）では k=1 で、高さは使わない', () => {
    const def = { image_width_px: 1024, image_height_px: 1024, scale: { px_per_cm: 2 }, hang: { x_px: 512, floor_y_px: 900, center_from_floor_cm: 140 } };
    const a = paintingRectFromScale(def, [53, 65.2], 1024);
    const b = paintingRectFromScale(def, [53, 65.2]);
    expect(a).toEqual(b);
    expect(a[1][0] - a[0][0]).toBeCloseTo(106);
  });
  it('壁色キー：絵の前を通る黒い線は絵の上に残り、壁には影が落ちる', () => {
    // 単色の壁（200,190,180）に、縦の黒い線（幅 2px）。絵は単色の赤
    const W = 120, H = 100;
    const room = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) { room[i * 3] = 200; room[i * 3 + 1] = 190; room[i * 3 + 2] = 180; }
    for (let y = 0; y < H; y++) for (const x of [59, 60]) room.fill(0, (y * W + x) * 3, (y * W + x) * 3 + 3);
    const painting = { data: Buffer.alloc(10 * 10 * 3).fill(Buffer.from([255, 0, 0])), width: 10, height: 10 };
    const quad = [[30, 30], [90, 30], [90, 70], [30, 70]];
    const painted = warpOnto({ data: room, width: W, height: H }, painting, quad);
    const { alpha, wall_rgb } = wallKeyAlpha({ data: room, width: W, height: H }, quad, { tolerance: 0.1 });
    expect(wall_rgb).toEqual([200, 190, 180]);
    const out = restoreForeground(painted, room, alpha, quad, W, H);
    const px = (x: number, y: number) => [...out.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
    expect(px(59, 50)).toEqual([0, 0, 0]);       // 線は絵の前に残る
    expect(px(60, 50)).toEqual([0, 0, 0]);
    expect(px(40, 50)).toEqual([255, 0, 0]);     // 線から離れた所は絵
    expect(px(56, 50)).toEqual([255, 0, 0]);     // 線の脇も絵（壁が手前扱いされない。ぼかしは 2px まで）
    expect(px(59, 70)).toEqual([0, 0, 0]);       // 絵の下の影は線には落ちない
    expect(px(40, 70)[0]).toBeLessThan(200);     // 壁には影が落ちる
  });
});

describe('大きさの伝え方（比較の一文と信頼度）', () => {
  const table = {
    door_interior: { height_cm: 200, width_cm: 78, label: { ja: 'ドア', en: 'the door' } },
    ceiling: { height_cm: 240, label: { ja: '部屋の天井', en: 'the ceiling' } },
    kettle: { height_cm: 24, label: { ja: 'ケトル', en: 'the kettle' } },
    dining_chair: { height_cm: 80, label: { ja: 'ダイニングチェア', en: 'the dining chair' } },
    dining_table: { height_cm: 72, label: { ja: 'ダイニングテーブル', en: 'the dining table' } },
  };
  it('比率を身近な分数に丸める', () => {
    expect(fractionOf(0.33).ja).toBe('約 3 分の 1');
    expect(fractionOf(0.5).ja).toBe('約半分');
    expect(fractionOf(1.0).ja).toBe('ほぼ同じ');
    expect(fractionOf(1.4).ja).toBe('約 1.4 倍');
    expect(fractionOf(0.7).ja).toBe('約 3 分の 2');
    expect(fractionOf(0.25).ja).toBe('約 4 分の 1');
    expect(fractionOf(0.42).ja).toBe('約 0.4 倍');
    expect(fractionOf(0.33).en).toBe('about one third');
  });
  it('信頼度：ずれ 8% 以内 high、15% 以内 mid、それ以上か基準が 1 つなら low', () => {
    expect(confidenceFrom(0.03, 2)).toBe('high');
    expect(confidenceFrom(0.08, 2)).toBe('high');
    expect(confidenceFrom(0.12, 2)).toBe('mid');
    expect(confidenceFrom(0.2, 2)).toBe('low');
    expect(confidenceFrom(0, 1)).toBe('low');
  });
  it('主の基準物で px/cm を決め、他とのずれから信頼度を出す', () => {
    const s = scaleFromReferences([{ ref: 'door_interior.height', px: 725, primary: true }, { ref: 'ceiling.height', px: 845 }], table);
    expect(s.px_per_cm).toBeCloseTo(3.625);
    expect(s.deviation).toBeCloseTo(0.029, 2);
    expect(s.confidence).toBe('high');
    expect(() => scaleFromReferences([{ ref: 'piano.height', px: 100 }], table)).toThrow();
  });
  it('H5：手前の基準物は地平線と接地線で壁の奥行きに換算する（sq-dining-wide の実測）', () => {
    const refs = [{ ref: 'dining_chair.height', px: 310, floor_y_px: 900, primary: true }, { ref: 'dining_table.height', px: 350, floor_y_px: 960 }];
    const raw = scaleFromReferences(refs, table);
    expect(raw.deviation).toBeGreaterThan(0.2);                  // 補正なしでは 25% ずれる
    const s = scaleFromReferences(refs, table, { wallFloorY: 770, horizonY: 680 });
    expect(s.px_per_cm).toBeCloseTo((310 / 80) * (90 / 220), 3);  // 3.875 × 0.409
    expect(s.deviation).toBeLessThan(0.03);                      // 補正後は 2% に収まる
    expect(s.all[1].depth).toBeCloseTo(90 / 280, 3);
    // 地平線が無ければ補正しない
    expect(scaleFromReferences(refs, table, { wallFloorY: 770 }).px_per_cm).toBeCloseTo(raw.px_per_cm);
  });
  it('比較の一文：馴染みのある物（ドア）を選び、数字を出さない。2 つ目は実寸つき', () => {
    const t = roomTexts({ references: [{ ref: 'ceiling.height', px: 845 }, { ref: 'door_interior.height', px: 725, primary: true }], table, sizeCm: [53, 65.2], confidence: 'high', wallWidthCm: 323, centerFromFloorCm: 150 });
    expect(t.compare!.ja).toBe('このドアの約 3 分の 1 の高さ。');
    expect(t.compare!.en).toBe('About one third the height of the door.');
    expect(t.compare2!.ja).toBe('この部屋の天井（約 240 cm）の約 4 分の 1 の高さ。');
    expect(t.about.ja).toBe('壁の幅は約 3.2 m。目の高さ（床から約 150 cm）に掛けています。');
    expect(t.primary_ref).toBe('door_interior');
  });
  it('信頼度 low は比較の一文に「寸法は目安」を添える', () => {
    const t = roomTexts({ references: [{ ref: 'kettle.height', px: 200, primary: true }], table, sizeCm: [24.2, 33.3], confidence: 'low', wallWidthCm: 137, centerFromFloorCm: 140 });
    expect(t.compare!.ja).toBe('このケトルの約 1.4 倍の高さ（寸法は目安）。');
    expect(t.compare2).toBeNull();
  });
});

describe('言語', () => {
  it('端末の言語タグを 10 言語に正規化する', () => {
    expect(normalizeLang('zh-TW')).toBe('zh-Hant'); expect(normalizeLang('zh-HK')).toBe('zh-Hant'); expect(normalizeLang('zh-Hant-TW')).toBe('zh-Hant');
    expect(normalizeLang('zh-CN')).toBe('zh-Hans'); expect(normalizeLang('zh')).toBe('zh-Hans');
    expect(normalizeLang('pt-BR')).toBe('pt'); expect(normalizeLang('en-US')).toBe('en'); expect(normalizeLang('ja-JP')).toBe('ja');
    expect(normalizeLang('ar')).toBeNull(); expect(normalizeLang('')).toBeNull();
  });
  it('navigator.languages の順で最初に一致、無ければ en、強制があればそれ', () => {
    expect(pickLang(['ar', 'fr-CA', 'en'])).toBe('fr');
    expect(pickLang(['ar', 'he'])).toBe('en');
    expect(pickLang(['ja'], 'ko')).toBe('ko');
  });
  it('翻訳キャッシュの鍵は原文から決まる', () => {
    expect(key('海辺の町で描いた。')).toBe(key('海辺の町で描いた。'));
    expect(key('海辺の町で描いた。')).not.toBe(key('海辺の町で描いた'));
  });
});

describe('絵ごとの流体の性格（docs/FLUID_PER_WORK.md）', async () => {
  const { fluidSpec, normalizeDriveDir } = await import('../scripts/generate/index.js');
  it('overrides の look.swell / dots / bleed と drive_dir を space.json の fluid に通す', () => {
    const f = fluidSpec({ speed: 0.8, restore: 0.012, look: { swell: 0.6, dots: 0.8, bleed: 0.5, relief: 0.9 }, drive_dir: [0, 2] }, { vorticity: 0.5, speed: 0.4 });
    expect(f.speed).toBe(0.8); expect(f.restore).toBe(0.012); expect(f.vorticity).toBe(0.5);
    expect(f.look.swell).toBe(0.6); expect(f.look.dots).toBe(0.8); expect(f.look.bleed).toBe(0.5); expect(f.look.relief).toBe(0.9);
    expect(f.look.gloss).toBe(0.18);   // 指定の無い鍵は既定
    expect(f.drive_dir).toEqual([0, 1]);
  });
  it('無ければ swell / dots / bleed は 0、drive_dir は出さない（従来どおり）', () => {
    const f = fluidSpec({}, { vorticity: 0.3, speed: 0.4 });
    expect(f.look.swell).toBe(0); expect(f.look.dots).toBe(0); expect(f.look.bleed).toBe(0);
    expect('drive_dir' in f).toBe(false);
    expect('arc' in f).toBe(false);
  });
  it('arc（時間の弧）を space.json の fluid に通す。不正なら出さない', () => {
    expect(fluidSpec({ arc: { peak_s: 60, calm_s: 150 } }).arc).toEqual({ peak_s: 60, calm_s: 150 });
    expect('arc' in fluidSpec({ arc: { peak_s: 'x', calm_s: 150 } })).toBe(false);
  });
  it('drive_dir は正規化。長さ 0・不正は null', () => {
    const d = normalizeDriveDir([3, 4])!;
    expect(d[0]).toBeCloseTo(0.6); expect(d[1]).toBeCloseTo(0.8);
    expect(normalizeDriveDir([0, 0])).toBeNull();
    expect(normalizeDriveDir(undefined)).toBeNull();
    expect(normalizeDriveDir(['a', 1])).toBeNull();
  });
});

// E-15：作品ページの技法と部屋の場所の名前は space.json の 10 言語を data-lang の span で出す（applyLang が出し分ける）
describe('作品ページの技法・部屋の場所（10 言語）', async () => {
  const { workPage } = await import('../scripts/generate/pages.js');
  const space = {
    id: 'w1', title: { ja: '題', en: 'Title' }, back_color: '#000',
    medium: { ja: 'キャンバスにアクリル', en: 'Acrylic on canvas', ko: '캔버스에 아크릴', fr: 'Acrylique sur toile' },
    rooms: [{ image: 'room_a.jpg', category: 'house', label: { ja: 'ソファの上の壁', en: 'Above the sofa', fr: 'Le mur au-dessus du canapé' } }],
  };
  const work = { id: 'w1', size_cm: [10, 20], medium: { ja: 'キャンバスにアクリル', en: 'Acrylic on canvas' } };
  const html = workPage({ work, space, baseUrl: 'https://example.com', allWorks: [space] });
  it('技法：ja は見せ、ほかの言語は hidden の span で並ぶ', () => {
    expect(html).toContain('<span lang="ja" data-lang="ja">キャンバスにアクリル</span>');
    expect(html).toContain('<span lang="ko" data-lang="ko" hidden>캔버스에 아크릴</span>');
    expect(html).toContain('<span lang="fr" data-lang="fr" hidden>Acrylique sur toile</span>');
  });
  it('部屋の場所の名前も 10 言語のうちある言語ぶん', () => {
    expect(html).toContain('<span lang="fr" data-lang="fr" hidden>Le mur au-dessus du canapé</span>');
  });
  it('space.json に medium が無い（古い生成物）ときは work.json の ja / en', () => {
    const old = workPage({ work, space: { ...space, medium: undefined }, baseUrl: 'https://example.com', allWorks: [space] });
    expect(old).toContain('<span lang="en" data-lang="en" hidden>Acrylic on canvas</span>');
    expect(old).not.toContain('data-lang="ko"');
  });
});

// G-1：ギャラリーの大きさの絞り込み（長辺 cm：< 30 → 小、30〜60 → 中、≥ 60 → 大）。並びは長辺の昇順
describe('ギャラリーの大きさの区分（G-1）', async () => {
  const { sizeClass, longSide, galleryWallPage } = await import('../scripts/generate/pages.js');
  it('長辺で小・中・大', () => {
    expect(sizeClass(18)).toBe('s');
    expect(sizeClass(33.3)).toBe('s');   // F4
    expect(sizeClass(41)).toBe('m');    // F6
    expect(sizeClass(53)).toBe('m');
    expect(sizeClass(60.6)).toBe('m');  // F12
    expect(sizeClass(61)).toBe('l');
    expect(sizeClass(65.2)).toBe('l');
    expect(longSide([53, 65.2])).toBe(65.2);
  });
  const works = [
    { id: 'big', title: { ja: '大' }, size_cm: [53, 65.2] },
    { id: 'mid', title: { ja: '中' }, size_cm: [41, 31.8] },
    { id: 'tiny', title: { ja: '小' }, size_cm: [18, 14] },
  ];
  const html = galleryWallPage({ works, baseUrl: 'https://example.com' });
  it('長辺の昇順に並び、data-size と data-long が付く（元の配列は変えない）', () => {
    const ids = [...html.matchAll(/class="gw-item" data-id="([^"]+)" data-size="([sml])" data-long="([\d.]+)"/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}`);
    expect(ids).toEqual(['tiny:s:18', 'mid:m:41', 'big:l:65.2']);
    expect(works[0].id).toBe('big');
  });
  it('チップ 4 つ。該当 0 の区分は disabled', () => {
    expect([...html.matchAll(/class="gw-chip" data-size="(\w+)"/g)].map((m) => m[1])).toEqual(['all', 's', 'm', 'l']);
    expect(html).not.toMatch(/gw-chip[^>]*disabled/);
    const onlySmall = galleryWallPage({ works: [works[2]], baseUrl: 'https://example.com' });
    expect(onlySmall).toMatch(/data-size="l"[^>]*disabled/);
    expect(onlySmall).not.toMatch(/data-size="s"[^>]*disabled/);
  });
  it('最初の絵は遅延せず先に読み、壁の文字は読み上げない（11-08 展示室）', () => {
    const six = galleryWallPage({ works: Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, title: { ja: `w${i}` }, size_cm: [18 + i, 14] })), baseUrl: 'https://example.com' });
    expect(six.match(/fetchpriority="high"/g)).toHaveLength(3);
    expect(six.match(/loading="lazy"/g)).toHaveLength(3);
    expect(six).toContain('<div class="gw-intro" aria-hidden="true">');
  });
  it('フッターは「© SHEER」と「記録について」（P-17）', () => {
    expect(html).toContain('<footer><span data-i18n="privacy">© SHEER</span><a class="foot-data" href="../data-note.html" data-i18n="fu_data">');
  });
});

describe('小さな物語の公開（DECISIONS 70）', () => {
  const ja = '朝、カーテンを開ける。';
  it('作家の確認の印が無ければ公開しない', () => {
    expect(publishedStory({}, { ja })).toBeNull();
    expect(publishedStory({ story_approved: false }, { ja })).toBeNull();
    expect(publishedStory({ story_approved: 'yes' }, { ja })).toBeNull();
  });
  it('印があっても、下書きの印が文に残っていれば公開しない', () => {
    expect(publishedStory({ story_approved: true }, { ja: `${ja}\n（下書き。作家が自分の言葉に直す）` })).toBeNull();
  });
  it('確認済みの文だけ公開する。物語が無ければ null', () => {
    expect(publishedStory({ story_approved: true }, { ja, en: 'Morning.' })).toEqual({ ja, en: 'Morning.' });
    expect(publishedStory({ story_approved: true }, {})).toBeNull();
  });
});

describe('生成の HTML の固定文と ui.json', () => {
  it('同じ鍵は同じ文（読み込みの途中で文が変わらない）', () => {
    for (const [k, v] of Object.entries(UI_JA as Record<string, string>)) {
      const e = (ui as Record<string, Record<string, string>>)[k];
      if (e) expect([k, v]).toEqual([k, e.ja]);
    }
  });
  it('使わなくなった旧称が残っていない', () => {
    const all = JSON.stringify(ui);
    expect(all).not.toContain('絵の中から戻ってきました');
    expect((ui as Record<string, unknown>).tagline).toBeUndefined();
  });
  it('足した文言は 10 言語そろっている', () => {
    for (const k of ['exp_load_fail', 'reload', 'rooms_load_fail', 'fu_ai_note', 'fu_need_words', 'cg_enter_fail', 'cg_js_fail', 'copy_fail', 'cg_after_head', 'fu_data']) {
      expect(Object.keys((ui as Record<string, Record<string, string>>)[k]).sort()).toEqual(['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'zh-Hans', 'zh-Hant']);
    }
  });
});

describe('古い Safari の CSS', () => {
  const css = ['src/ui/page.css', 'src/concierge/concierge.css', 'src/followup/followup.css'].map((f) => readFileSync(f, 'utf8'));
  it('dvh は @supports の 1 か所だけ（ほかは --vh100 を使う）', () => {
    const hits = css.join('\n').split('\n').filter((ln) => /\d+dvh/.test(ln));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('@supports (height: 100dvh)');
    expect(css[0]).toMatch(/--vh100: 100vh;/);
  });
  it('overflow: clip の前に hidden', () => {
    expect(css[0]).toContain('overflow: hidden; overflow: clip;');
  });
});
