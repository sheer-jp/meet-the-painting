// npm run generate [-- <id>]：works/<id>/ から流れ場・主要色・翻訳・QR・作品ページを生成する
import sharp from 'sharp';
import QRCode from 'qrcode';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { kmeans, toHex, textColor, backColor, brightCenter } from './color.js';
import { structureTensorFlow, flowToRGB, motionFromFlow, reliefFromGray, toGray8 } from './flow.js';
import { translateAll } from './translate.js';
import { publishedStory } from './story.js';

// 文字を白にする絵の明るさの上限（L*）。6 作品：New Chapter 67 だけ墨、ほかは白（docs/EXPERIENCE.md 3 節 T3）
const TEXT_DARK_LSTAR = 60;
import { workPage, galleryPage, galleryWallPage, cardSvg } from './pages.js';
import { compositeRooms } from './rooms.js';
import { titleJaEn } from './catalog.js';

// Claude API の鍵：ANTHROPIC_API_KEY か、別名 ENTER_CLAUDE_API_KEY（クラウドのセッションでは ANTHROPIC_API_KEY がセッション側に取られて空になることがある）
if (!process.env.ANTHROPIC_API_KEY && process.env.ENTER_CLAUDE_API_KEY) process.env.ANTHROPIC_API_KEY = process.env.ENTER_CLAUDE_API_KEY;

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const BASE_URL = (process.env.BASE_URL || 'https://sheer-jp.github.io/enter-the-painting').replace(/\/$/, '');
const FLOW_W = 256;
// swell / dots / bleed：絵ごとの性格（docs/FLUID_PER_WORK.md 1 節）。既定 0
const LOOK_DEFAULT = { relief: 0.5, gloss: 0.18, sharpness: 96, bloom: 0.04, grain: 0.02, vivid: 0.45, swell: 0, dots: 0, bleed: 0 };
export const FLOW_SIGMA_DEFAULT = 6;

// 常時の駆動の向き [x, y]（v は下 → 上）を正規化。無い・長さ 0 なら null（従来どおり）
/** @param {any} d @returns {[number, number] | null} */
export function normalizeDriveDir(d) {
  if (!Array.isArray(d) || d.length < 2) return null;
  const x = Number(d[0]), y = Number(d[1]), l = Math.hypot(x, y);
  if (!Number.isFinite(l) || l < 1e-6) return null;
  return [+(x / l).toFixed(4), +(y / l).toFixed(4)];
}

// space.json の fluid（overrides と色・流れ場からの自動値）。docs/WORK_FORMAT.md の overrides
/** @param {any} [ov] @param {any} [motion] @returns {any} */
export function fluidSpec(ov = {}, motion = { vorticity: 0.5, speed: 0.4 }) {
  const fluid = {
    vorticity: ov.vorticity ?? motion.vorticity, speed: ov.speed ?? motion.speed, quality: ov.quality || 'high', restore: ov.restore ?? 0.014, drive: ov.drive ?? 0.3, tempo: ov.tempo ?? 0.6,
    // 質感（docs/FLUID_LOOK.md 2 節のパラメータ）。作品ごとに overrides.look で上書き
    look: { ...LOOK_DEFAULT, ...(ov.look || {}) },
  };
  const dir = normalizeDriveDir(ov.drive_dir);
  if (dir) fluid.drive_dir = dir;
  // 時間の弧（docs/FLUID_PER_WORK.md 5 節）。無ければ出さない（従来どおり一定）
  const arc = ov.arc;
  if (arc && Number.isFinite(Number(arc.peak_s)) && Number.isFinite(Number(arc.calm_s))) fluid.arc = { peak_s: Number(arc.peak_s), calm_s: Number(arc.calm_s) };
  return fluid;
}

async function generateWork(id) {
  const dir = join(ROOT, 'works', id);
  const gen = join(dir, 'generated');
  mkdirSync(gen, { recursive: true });
  const work = JSON.parse(readFileSync(join(dir, 'work.json'), 'utf8'));
  if (work.id !== id) throw new Error(`${id}/work.json の id が一致しない: ${work.id}`);
  const src = join(dir, 'painting.jpg');
  if (!existsSync(src)) throw new Error(`${id}/painting.jpg が無い`);
  console.log(`[${id}] ${work.title?.ja || ''}`);

  // 1. 縮小（1 サイズ）
  const meta = await sharp(src).metadata();
  const aspect = meta.width / meta.height;
  await sharp(src).rotate().resize({ width: 1024 }).jpeg({ quality: 88, mozjpeg: true }).toFile(join(gen, 'painting_1024.jpg'));
  // 「他の作品」の帯とギャラリーの小さな表示用（srcset で 1024 と出し分け。AUDIT-1 P1-5）
  await sharp(src).rotate().resize({ width: 480 }).jpeg({ quality: 82, mozjpeg: true }).toFile(join(gen, 'painting_480.jpg'));
  // 流体の色場の初期値用：元の写真の解像度をそのまま（長辺 2048 まで。写真が小さければ拡大しない）
  const longSide = Math.max(meta.width, meta.height);
  const fullW = longSide > 2048 ? Math.round(meta.width * 2048 / longSide) : meta.width;
  await sharp(src).rotate().resize({ width: fullW, withoutEnlargement: true }).jpeg({ quality: 90, mozjpeg: true }).toFile(join(gen, 'painting_full.jpg'));
  if (longSide < 2000) console.warn(`  写真の長辺が ${longSide}px しかない。2000px 以上で撮り直すと流体の中の絵がきれいになる`);
  // ページの背景用：強くぼかした小さな画像（CSS で拡大して使う）
  await sharp(src).rotate().resize({ width: 96 }).blur(6).jpeg({ quality: 70 }).toFile(join(gen, 'painting_blur.jpg'));

  // 2. 主要色
  const small = await sharp(src).rotate().resize({ width: 96 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const palette = kmeans(new Uint8Array(small.data), work.overrides?.palette_k ?? 6);
  const paletteHex = palette.map((p) => toHex(p.rgb));
  // 入りの渦の中心：最も明るい主要色の重心
  const bright = brightCenter(new Uint8Array(small.data), small.info.width, small.info.height, palette);

  // 3. 筆致の流れ場
  const flowH = Math.round(FLOW_W / aspect);
  const g = await sharp(src).rotate().resize({ width: FLOW_W, height: flowH, fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const gray = new Float32Array(g.data.length);
  for (let i = 0; i < gray.length; i++) gray[i] = g.data[i];
  const flow = structureTensorFlow(gray, FLOW_W, flowH, work.overrides?.flow_sigma ?? FLOW_SIGMA_DEFAULT);   // 大きめに平滑化：渦が細かくなりすぎない
  await sharp(Buffer.from(flowToRGB(flow)), { raw: { width: FLOW_W, height: flowH, channels: 3 } }).png().toFile(join(gen, 'flow.png'));
  const motion = motionFromFlow(flow);
  // 絵の具の厚みの初期値（docs/FLUID_LOOK.md 2 節）。flow.png と同じ大きさ
  const relief = reliefFromGray(gray, FLOW_W, flowH, flow.str);
  await sharp(Buffer.from(toGray8(relief)), { raw: { width: FLOW_W, height: flowH, channels: 1 } }).png().toFile(join(gen, 'relief.png'));

  // 4. 部屋の合成（文章は次の翻訳にまとめて通す）
  const rooms = await compositeRooms({ root: ROOT, work, paintingPath: join(gen, 'painting_1024.jpg'), outDir: gen });
  // 古い寄りの画像（room_<name>_close.jpg）は使わなくなったので消す
  for (const f of readdirSync(gen)) if (/^room_.+_close\.jpg$/.test(f)) unlinkSync(join(gen, f));
  // 部屋の文章（比較の一文など）を翻訳キャッシュに通す。en はコードで組み立てたもの
  const ROOM_TEXTS = ['compare', 'compare2', 'about', 'note'];
  const roomTexts = [...new Map(rooms.flatMap((r) => ROOM_TEXTS.map((k) => r[k]).filter(Boolean)).map((x) => [x.ja, x])).values()];   // 同じ文は 1 回だけ

  // 5. 翻訳（メッセージ、物語、部屋の文章）。題名は固有名詞なので訳さない（ja と en だけ。他の言語は pick() の en フォールバック。AUDIT-1 P1-7）
  const messages = (work.messages || []).map((ja, i) => ({ ja, en: work.messages_en?.[i] }));
  const texts = [...messages];
  const storyPath = join(gen, 'stories.json');
  let stories = existsSync(storyPath) ? JSON.parse(readFileSync(storyPath, 'utf8')) : {};
  // 小さな物語の下書き：無ければ Claude API で 1 本（キーが無ければスキップ）。作家が直したものは再生成で消えない
  if (!stories.ja && messages.length && process.env.ANTHROPIC_API_KEY) {
    const { draftStory } = await import('./claude.js');
    stories = { ja: await draftStory({ title: work.title?.ja || id, messages: messages.map((m) => m.ja), note: work.note }, process.env.ANTHROPIC_API_KEY) };
    writeFileSync(storyPath, JSON.stringify(stories, null, 2) + '\n');
    console.log('  小さな物語を下書きした → generated/stories.json（作家が直す）');
  }
  // 公開するのは作家が確認した物語だけ（work.json の story_approved。DECISIONS 70）。下書きは訳さず、space.json・ページ・カタログ・案内役に渡さない
  const story = publishedStory(work, stories);
  if (story) texts.push({ ja: story.ja, en: story.en });
  else if (stories.ja) console.log('  小さな物語は未確認なので公開しない（確認したら work.json に "story_approved": true）');
  texts.push(...roomTexts);
  // 技法・号数・部屋の場所の名前（E-15）。work.json / rooms/*.json の { ja, en } を 10 言語に。文字列（古い形）は訳さずそのまま
  const isMulti = (v) => v && typeof v === 'object' && typeof v.ja === 'string' && v.ja;
  const labels = [work.medium, work.size_label, work.statement, ...rooms.map((r) => r.label)].filter(isMulti);
  texts.push(...new Map(labels.map((x) => [x.ja, { ja: x.ja, en: x.en }])).values());
  const tr = await translateAll(texts, join(gen, 'translations.json'));
  const multi = (v) => isMulti(v) ? { ...tr(v.ja), ja: v.ja, ...(v.en ? { en: v.en } : {}) } : (v ?? null);
  for (const r of rooms) for (const k of ROOM_TEXTS) if (r[k]) r[k] = { ...tr(r[k].ja), ja: r[k].ja, en: r[k].en };
  for (const r of rooms) if (isMulti(r.label)) r.label = multi(r.label);

  // 声の各文の開始秒。無ければ等間隔（文字数に比例）
  const at = [];
  if (work.audio?.voice_at?.length === messages.length) at.push(...work.audio.voice_at);
  else {
    let s = 0;
    for (const m of messages) { at.push(+s.toFixed(1)); s += Math.max(4, m.ja.length * 0.25) + 3; }
  }

  // 6. space.json
  const ov = work.overrides || {};
  // 絵の平均の明るさ L*（painting_1024 の平均 RGB → 線形 → Y → L*）
  const lstar = await (async () => {
    const st = await sharp(join(gen, 'painting_1024.jpg')).stats();
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const [r, g, b] = st.channels.map((ch) => lin(ch.mean / 255));
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return Y <= 0.008856 ? Y * 903.3 : Math.pow(Y, 1 / 3) * 116 - 16;
  })();
  const space = {
    id, title: work.title?.ja ? { ja: work.title.ja, ...(work.title.en ? { en: work.title.en } : {}) } : { ja: id },
    size_cm: work.size_cm, aspect: +aspect.toFixed(4), year: work.year ?? null,
    painting: 'painting_1024.jpg', painting_full: 'painting_full.jpg', painting_blur: 'painting_blur.jpg',
    source_px: [meta.width, meta.height],
    palette: paletteHex,
    // 文字色は絵の平均の明るさ（L*）で決める：濃い絵は白、淡い絵は墨（11-07 作家「濃い絵に黒文字は見づらい。淡い絵なら黒でもいい」）。overrides.text_color で上書き可
    luma: +lstar.toFixed(1), text_color: ov.text_color || (lstar < TEXT_DARK_LSTAR ? '#ffffff' : '#141210'), back_color: ov.back_color || backColor(palette),
    bright_center: bright,
    flow: { texture: 'flow.png', strength: ov.flow_strength ?? 0.6, edge_density: motion.edge_density, sigma: ov.flow_sigma ?? FLOW_SIGMA_DEFAULT },
    relief: { texture: 'relief.png' },
    fluid: fluidSpec(ov, motion),
    space: { radius_m: ov.radius_m ?? 2.5, melt_distance_m: ov.melt_distance_m ?? 1.0 },
    audio: { voice: work.audio?.voice && existsSync(join(dir, work.audio.voice)) ? work.audio.voice : null, ambient: work.audio?.ambient || 'calm' },
    messages: messages.map((m, i) => ({ at: at[i], ...tr(m.ja), ja: m.ja, ...(m.en ? { en: m.en } : {}) })),
    story: story ? { ...tr(story.ja), ja: story.ja } : null,
    size_label: multi(work.size_label || null),
    medium: multi(work.medium || null),
    statement: multi(work.statement || null),   // 作品の一文（この絵の意味と、絵の世界での動き。作家の語りから）
    rooms, availability: work.availability || null, contact: work.contact || null,
    generated_at: new Date().toISOString(),
  };
  writeFileSync(join(gen, 'space.json'), JSON.stringify(space, null, 2) + '\n');

  // 7. QR（作品ページ + ?from=qr）とカード
  const url = `${BASE_URL}/w/${id}/?from=qr`;
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  writeFileSync(join(gen, 'qr.svg'), qrSvg);
  await QRCode.toFile(join(gen, 'qr.png'), url, { margin: 1, width: 1024, errorCorrectionLevel: 'M' });
  const inner = qrSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(qrSvg);
  const scale = vb ? 100 / +vb[1] : 1;
  writeFileSync(join(gen, 'card.svg'), cardSvg({ work, space, qrSvgInner: `<g transform="scale(${scale})">${inner}</g>`, url: `${BASE_URL}/w/${id}/` }));

  console.log(`  palette ${paletteHex.join(' ')}  motion ${JSON.stringify(motion)}  messages ${messages.length}  rooms ${rooms.length}`);
  return { work, space };
}

async function main() {
  const arg = process.argv[2];
  const worksDir = join(ROOT, 'works');
  const ids = arg ? [arg] : readdirSync(worksDir).filter((d) => statSync(join(worksDir, d)).isDirectory() && existsSync(join(worksDir, d, 'painting.jpg')));
  const all = [];
  for (const id of ids) all.push(await generateWork(id));
  // ページ（指定 id だけのときも、他の作品の space.json を読んでギャラリーを作り直す）
  const everyId = readdirSync(worksDir).filter((d) => existsSync(join(worksDir, d, 'generated', 'space.json')));
  const every = everyId.map((id) => ({ work: JSON.parse(readFileSync(join(worksDir, id, 'work.json'), 'utf8')), space: JSON.parse(readFileSync(join(worksDir, id, 'generated', 'space.json'), 'utf8')) }));
  const allWorks = every.map((e) => e.space);
  for (const { work, space } of every) {
    const pdir = join(ROOT, 'w', work.id);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, 'index.html'), workPage({ work, space, baseUrl: BASE_URL, allWorks }));
  }
  writeFileSync(join(ROOT, 'index.html'), galleryPage({ works: allWorks, baseUrl: BASE_URL }));
  mkdirSync(join(ROOT, 'gallery'), { recursive: true });   // ギャラリー（docs/ENTRANCE.md 4 節）。/ は受付
  writeFileSync(join(ROOT, 'gallery', 'index.html'), galleryWallPage({ works: allWorks, baseUrl: BASE_URL }));
  writeFileSync(join(ROOT, 'public', 'works.json'), JSON.stringify(allWorks.map((s) => ({ id: s.id, title: titleJaEn(s.title, s.id), size_cm: s.size_cm })), null, 2) + '\n');
  await (await import('./catalog.js')).writeCatalog(ROOT);   // 気分から絵をすすめる（docs/RECOMMEND.md 8.3）
  await (await import('./og.js')).writeOg({ root: ROOT, works: allWorks });   // ファビコンと SNS カード（E-16）
  console.log(`ページ生成：${every.length} 作品、BASE_URL=${BASE_URL}`);
}

// テストから fluidSpec などを読むときは実行しない
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e) => { console.error(e); process.exit(1); });
