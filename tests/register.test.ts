// 作品の登録（docs/REGISTER.md、R1・R2）：号数の表、縦横比、写真の検査、道具の入力の検査、聞き役（ルールだけの版と Claude の差し替え）、
// 下書きの API（ローカルの SQLite を D1 の代わりに）、公開専用のトークン
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import sharp from 'sharp';
// vite（vitest 2）は node:sqlite を組み込みと見ないので require で読む
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { gouSize, parseGou, parseCm, aspectDiff, orient, validateTool, applyPatch, confirmProposal, emptyData, fieldState, nextField, missingForPublish, parseAnswer, splitSentences, toWorkJson, slugify, uniqueId, autoRooms, payLine, TOOLS, GOU_NUMBERS } from '../functions/_lib/register.js';
import { ROOMS } from '../functions/_lib/rooms-list.js';
import { sniffType, cleanJpeg, cleanPng, checkPhoto } from '../functions/_lib/image.js';
import { validateChatBody, claudeTurn, rulesTurn, chatBody } from '../functions/_lib/register-chat.js';
import { resetRegisterReadyMemo, ensureWorkId } from '../functions/_lib/drafts.js';
import { resetCatalogMemo } from '../functions/_lib/catalog.js';
import { signSession, COOKIE_NAME, hashPassword } from '../functions/_lib/admin-auth.js';
import { onRequest as guard } from '../functions/api/admin/_middleware.js';
import { onRequestGet as worksConfig } from '../functions/api/admin/works/config.js';
import { onRequestGet as worksList, onRequestPost as worksCreate } from '../functions/api/admin/works/index.js';
import { handleChat } from '../functions/api/admin/works/chat.js';
import { onRequestGet as draftGet, onRequestPatch as draftPatch, onRequestDelete as draftDelete } from '../functions/api/admin/works/[id].js';
import { onRequestPut as photoPut, onRequestGet as photoGet } from '../functions/api/admin/works/[id]/photo.js';
import { onRequestPost as queuePost } from '../functions/api/admin/works/[id]/queue.js';
import { onRequestGet as exportGet } from '../functions/api/admin/works/[id]/export.js';
import { onRequestPost as resultPost } from '../functions/api/admin/works/[id]/result.js';

// ───── テスト用の写真：無地と単純な図形だけ（作家の絵は使わない） ─────
const flat = (w: number, h: number, fmt: 'jpeg' | 'png' = 'jpeg') => {
  const img = sharp({ create: { width: w, height: h, channels: 3, background: '#c23a2b' } });
  return (fmt === 'jpeg' ? img.jpeg() : img.png()).toBuffer();
};

describe('号数 → cm の表', () => {
  it('作品台帳にある 4 点と一致する（F0 18×14、F4 33.3×24.2、F10 53×45.5、F15 65.2×53）', () => {
    expect(gouSize('F', 0)).toEqual([18, 14]);
    expect(gouSize('F', 4)).toEqual([33.3, 24.2]);
    expect(gouSize('F', 10)).toEqual([53, 45.5]);
    expect(gouSize('F', 15)).toEqual([65.2, 53]);
  });
  it('F・P・M・S の 0〜30 号がそろい、同じ号は長辺が同じ、短辺は F > P > M、S は正方形', () => {
    expect(GOU_NUMBERS).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30]);
    for (const n of GOU_NUMBERS) {
      const [f, p, m, s] = ['F', 'P', 'M', 'S'].map((x) => gouSize(x, n) as [number, number]);
      expect(f[0]).toBe(p[0]); expect(p[0]).toBe(m[0]);
      expect(f[1]).toBeGreaterThan(p[1]); expect(p[1]).toBeGreaterThan(m[1]);
      expect(s).toEqual([f[0], f[0]]);
    }
    expect(gouSize('F', 7)).toBeNull();
    expect(gouSize('F', 50)).toBeNull();
    expect(gouSize('SM')).toEqual([22.7, 15.8]);
  });
  it('号の書き方のゆれを読む（全角、号の有無、系列なしは F）', () => {
    expect(parseGou('F15')).toEqual({ series: 'F', n: 15 });
    expect(parseGou('ｆ１５号')).toEqual({ series: 'F', n: 15 });
    expect(parseGou('P 10 号です')).toEqual({ series: 'P', n: 10 });
    expect(parseGou('15号')).toEqual({ series: 'F', n: 15 });
    expect(parseGou('SM')).toEqual({ series: 'SM', n: null });
    expect(parseGou('F7')).toBeNull();
    expect(parseGou('65.2 × 53')).toBeNull();
    expect(parseCm('65.2 × 53')).toEqual([65.2, 53]);
    expect(parseCm('６５．２ｘ５３ｃｍ')).toEqual([65.2, 53]);
    expect(parseCm('幅 30cm、高さ 40cm')).toEqual([30, 40]);
  });
});

describe('写真の縦横比との照らし合わせ', () => {
  it('写真の向きで縦横を決める（縦長なら [短辺, 長辺]）', () => {
    expect(orient([65.2, 53], 1600, 2000)).toEqual([53, 65.2]);
    expect(orient([65.2, 53], 2000, 1600)).toEqual([65.2, 53]);
  });
  it('5% 未満は通り、5% 以上は聞き直す（エラーに縦横比の違いと「写真の端」）', () => {
    const photo = { width: 1626, height: 2000 };   // 53 : 65.2 にほぼ同じ
    expect(aspectDiff([53, 65.2], photo.width, photo.height)).toBeLessThan(0.01);
    const ok = validateTool('set_size', { gou: 'F15', width_cm: null, height_cm: null, confirm_mismatch: false }, { photo });
    expect(ok).toMatchObject({ ok: true, patch: { work: { size_cm: [53, 65.2], size_label: { ja: 'F15号', en: 'F15' } } } });
    const ng = validateTool('set_size', { gou: 'S15', width_cm: null, height_cm: null, confirm_mismatch: false }, { photo });
    expect(ng.ok).toBe(false);
    expect(!ng.ok && ng.error).toMatch(/写真の縦横比と \d+% 違います.*写真の端/);
    // 作家が「合っている」と言えば通す
    expect(validateTool('set_size', { gou: 'S15', width_cm: null, height_cm: null, confirm_mismatch: true }, { photo }).ok).toBe(true);
    // ちょうど 5% は聞き直す側
    const p2 = { width: 2000, height: 1000 };
    expect(validateTool('set_size', { gou: null, width_cm: 210, height_cm: 100, confirm_mismatch: false }, { photo: p2 }).ok).toBe(false);
    expect(validateTool('set_size', { gou: null, width_cm: 209.8, height_cm: 100, confirm_mismatch: false }, { photo: p2 }).ok).toBe(true);
  });
  it('cm を長辺から言っても、写真の向きに合わせて入れ替える', () => {
    const r = validateTool('set_size', { gou: null, width_cm: 65.2, height_cm: 53, confirm_mismatch: false }, { photo: { width: 1626, height: 2000 } });
    expect(r).toMatchObject({ ok: true, patch: { work: { size_cm: [53, 65.2] } } });
  });
});

describe('写真の検査（中身で種類、EXIF を消す、15MB まで）', () => {
  it('JPEG：EXIF（APP1）を消し、縦横を読み、画素はそのまま読める', async () => {
    const src = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#20406a' } }).jpeg().withExif({ IFD0: { ImageDescription: 'secret-place', Copyright: 'x' } }).toBuffer();
    expect(src.includes(Buffer.from('Exif'))).toBe(true);
    const r = cleanJpeg(new Uint8Array(src));
    expect(r).not.toBeNull();
    expect(r!.width).toBe(2000); expect(r!.height).toBe(1500);
    expect(Buffer.from(r!.bytes).includes(Buffer.from('Exif'))).toBe(false);
    expect(Buffer.from(r!.bytes).includes(Buffer.from('secret-place'))).toBe(false);
    const meta = await sharp(Buffer.from(r!.bytes)).metadata();
    expect(meta.exif).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([2000, 1500]);
  });
  it('PNG：文字のチャンクを消し、縦横を読む', async () => {
    const src = await sharp({ create: { width: 1700, height: 1700, channels: 3, background: '#eeeeee' } }).png().withMetadata().toBuffer();
    const withText = Buffer.concat([src.subarray(0, 33), pngChunk('tEXt', 'Comment\0secret'), src.subarray(33)]);
    const r = cleanPng(new Uint8Array(withText));
    expect(r!.removed).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(r!.bytes).includes(Buffer.from('secret'))).toBe(false);
    expect((await sharp(Buffer.from(r!.bytes)).metadata()).width).toBe(1700);
  });
  it('種類：拡張子ではなく中身。HEIC は heic、ほかは type。小さい・大きい・壊れた・15MB 超を断る', async () => {
    expect(sniffType(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toBe('image/heic');
    expect(checkPhoto(new TextEncoder().encode('<svg onload=alert(1)>'))).toEqual({ ok: false, error: 'type' });
    expect(checkPhoto(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toEqual({ ok: false, error: 'heic' });
    expect(checkPhoto(new Uint8Array(await flat(1200, 900)))).toEqual({ ok: false, error: 'small' });
    expect(checkPhoto(new Uint8Array(await flat(3000, 2000)))).toEqual({ ok: false, error: 'big' });
    expect(checkPhoto(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4]))).toEqual({ ok: false, error: 'broken' });
    expect(checkPhoto(new Uint8Array(15 * 1024 * 1024 + 1))).toEqual({ ok: false, error: 'too_large' });
    const ok = checkPhoto(new Uint8Array(await flat(2000, 1600, 'png')));
    expect(ok).toMatchObject({ ok: true, type: 'image/png', width: 2000, height: 1600 });
  });
});

function pngChunk(type: string, text: string) {
  const data = Buffer.from(text, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);   // CRC は見ない（消すだけなので）
}

describe('道具の入力の検査（サーバーでもう一度）', () => {
  it('道具はすべて strict で、入力は additionalProperties: false と required がそろう（範囲の制約は書かない）', () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of ['set_title', 'set_year', 'set_size', 'set_medium', 'set_price', 'set_availability', 'set_buy_url', 'propose_messages', 'propose_moods', 'set_rooms']) expect(names).toContain(n);
    for (const t of TOOLS) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect([...t.input_schema.required].sort()).toEqual(Object.keys(t.input_schema.properties).sort());
      expect(JSON.stringify(t.input_schema)).not.toMatch(/minimum|maximum|minLength|maxLength|minItems|maxItems/);
    }
  });
  it('型と範囲の外は断る', () => {
    expect(validateTool('set_year', { year: '2026' }).ok).toBe(false);
    expect(validateTool('set_year', { year: 1850 }).ok).toBe(false);
    expect(validateTool('set_year', { year: 2026 })).toMatchObject({ ok: true, patch: { work: { year: 2026 } } });
    expect(validateTool('set_title', { ja: '  ', en: null }).ok).toBe(false);
    expect(validateTool('set_title', { ja: 'あ'.repeat(61), en: null }).ok).toBe(false);
    expect(validateTool('set_title', { ja: '青い‮潮', en: 'Blue Tide' })).toMatchObject({ ok: true, patch: { work: { title: { ja: '青い潮', en: 'Blue Tide' } } } });
    expect(validateTool('set_price', { price_jpy: 19.8 }).ok).toBe(false);
    expect(validateTool('set_price', { price_jpy: 500 }).ok).toBe(false);
    expect(validateTool('set_availability', { availability: 'reserved' }).ok).toBe(false);
    expect(validateTool('set_buy_url', { url: 'https://evil.example.com/pay' }).ok).toBe(false);
    expect(validateTool('set_buy_url', { url: 'javascript:alert(1)' }).ok).toBe(false);
    expect(validateTool('set_buy_url', { url: 'https://buy.stripe.com/test_abc123' }).ok).toBe(true);
    expect(validateTool('set_size', { gou: 'F7', width_cm: null, height_cm: null, confirm_mismatch: false }).ok).toBe(false);
    expect(validateTool('set_size', { gou: null, width_cm: 0, height_cm: 10, confirm_mismatch: false }).ok).toBe(false);
    expect(validateTool('set_rooms', { rooms: ['living-sofa', 'no-such-room'] }).ok).toBe(false);
    expect(validateTool('set_rooms', { rooms: ['studio-desk'] }).ok).toBe(false);   // 使わないと決めた部屋
    expect(validateTool('unknown_tool', {}).ok).toBe(false);
    expect(validateTool('set_year', null).ok).toBe(false);
  });
  it('想いの文は 3〜10 文、1 文 40 字以内。気分の言葉は 3〜5 語', () => {
    expect(validateTool('propose_messages', { messages: ['一。', '二。'] }).ok).toBe(false);
    expect(validateTool('propose_messages', { messages: ['あ'.repeat(41), 'い', 'う'] }).ok).toBe(false);
    expect(validateTool('propose_messages', { messages: Array(11).fill('文。') }).ok).toBe(false);
    expect(validateTool('propose_messages', { messages: ['一つ目。', '二つ目。', '三つ目。'] })).toMatchObject({ ok: true, patch: { proposed: { messages: ['一つ目。', '二つ目。', '三つ目。'] } } });
    expect(validateTool('propose_moods', { words: ['朝', '光'], fit: null }).ok).toBe(false);
    expect(validateTool('propose_moods', { words: ['朝の光', '静けさ', '新しい章'], fit: '新しいことを始める朝に' })).toMatchObject({ ok: true });
  });
  it('下書きは確認を押すまで確定しない（proposed → work）', () => {
    let data = applyPatch(emptyData(), { proposed: { messages: ['一つ目。', '二つ目。', '三つ目。'] } });
    const d = { id: 'x', work_id: null, photo: null, data };
    expect(fieldState(d, 'messages')).toBe('pending');
    const r = confirmProposal(data, 'messages', ['一つ目を直した。', '二つ目。', '三つ目。']);
    expect(r.ok).toBe(true);
    data = (r as { ok: true; data: any }).data;
    expect(data.work.messages[0]).toBe('一つ目を直した。');
    expect(data.proposed.messages).toBeUndefined();
    expect(fieldState({ ...d, data }, 'messages')).toBe('done');
  });
});

// 全部そろえた下書き（photo は 53:65.2 の縦長）
const PHOTO = { type: 'image/jpeg', width: 1626, height: 2000, bytes: 1000 };
function fullDraft() {
  let data = emptyData();
  const calls: [string, any][] = [
    ['set_title', { ja: 'テストの青', en: 'Test Blue' }], ['set_year', { year: 2026 }],
    ['set_size', { gou: 'F15', width_cm: null, height_cm: null, confirm_mismatch: false }], ['set_medium', { ja: 'キャンバスにアクリル', en: null }],
    ['set_availability', { availability: 'available' }], ['set_price', { price_jpy: 198000 }],
  ];
  for (const [n, i] of calls) { const v = validateTool(n, i, { photo: PHOTO }); if (!v.ok) throw new Error(v.error); data = applyPatch(data, v.patch); }
  data = (confirmProposal(data, 'messages', ['一つ目の文。', '二つ目の文。', '三つ目の文。']) as any).data;
  return { id: 'draft_aaaaaaaaaaaaaaaa', work_id: 'test-blue', status: 'draft', photo: PHOTO, data };
}

describe('聞く順と、公開に要るもの', () => {
  it('写真 → 題名 → 年 → 大きさ → 画材 → 値段 → 想い → 気分。気分は「あとで」でも公開できる', () => {
    const d: any = { id: 'x', work_id: null, photo: null, data: emptyData() };
    expect(nextField(d)).toBe('photo');
    expect(nextField({ ...d, photo: PHOTO })).toBe('title');
    const full = fullDraft();
    expect(nextField(full)).toBe('moods');
    expect(missingForPublish(full)).toEqual(['気分の言葉']);
    const skipped = { ...full, data: applyPatch(full.data, { skip: 'moods' }) };
    expect(nextField(skipped)).toBeNull();
    expect(missingForPublish(skipped)).toEqual([]);
    expect(missingForPublish({ ...skipped, work_id: null })).toEqual(['作品の id']);
  });
  it('支払いリンクの一行', () => {
    expect(payLine({ availability: 'available', buy: { price_jpy: 198000 } })).toBe('支払いリンクを作ります（198,000円）');
    expect(payLine({ availability: 'available', buy: { price_jpy: 22000, url: 'https://buy.stripe.com/x' } })).toBe('貼られた支払いリンクを使います（22,000円）');
    expect(payLine({ availability: 'not_for_sale' })).toMatch(/非売品/);
  });
  it('work.json の形（docs/WORK_FORMAT.md）。非売品には buy を載せない', () => {
    const w = toWorkJson(fullDraft());
    expect(w).toMatchObject({ id: 'test-blue', title: { ja: 'テストの青', en: 'Test Blue' }, year: 2026, size_cm: [53, 65.2], size_label: { ja: 'F15号', en: 'F15' }, medium: { ja: 'キャンバスにアクリル' }, availability: 'available', buy: { price_jpy: 198000 } });
    expect(w.messages).toHaveLength(3);
    expect(w.buy.url).toBeUndefined();
    const nfs = fullDraft(); nfs.data.work.availability = 'not_for_sale';
    expect(toWorkJson(nfs).buy).toBeUndefined();
  });
  it('id は英語の題名から。重なれば番号', () => {
    expect(slugify('The Flower Within')).toBe('the-flower-within');
    expect(slugify('Café & Rêve!')).toBe('cafe-and-reve');
    expect(uniqueId('harmoney', new Set(['harmoney', 'harmoney-2']))).toBe('harmoney-3');
    const d: any = { id: 'x', work_id: null, photo: PHOTO, data: { ...emptyData(), work: { title: { ja: '頂', en: 'Itadaki' } } } };
    expect(ensureWorkId(d, new Set(['itadaki'])).work_id).toBe('itadaki-2');
  });
  it('部屋の一覧は rooms/*.json と同じ。自動の選び方は generate と同じ（長辺で選ぶ）', () => {
    const files = readdirSync('rooms').filter((f) => f.endsWith('.json') && f !== 'REFERENCES.json').sort();
    expect(ROOMS.map((r) => r.name)).toEqual(files.map((f) => f.replace(/\.json$/, '')));
    for (const r of ROOMS) {
      const j = JSON.parse(readFileSync(`rooms/${r.name}.json`, 'utf8'));
      expect(r.suits_cm).toEqual(j.suits_cm ?? null);
      expect(r.disabled).toBe(!!j.disabled);
      expect(r.place).toBe(!!j.hang?.place);
    }
    expect(autoRooms([18, 14])).toEqual(['desk-easel', 'entrance-console', 'shelf-lean', 'sideboard-easel']);
    expect(autoRooms([53, 65.2]).every((n) => ROOMS.find((r) => r.name === n)!.suits_cm![0] <= 65.2)).toBe(true);
  });
});

describe('聞き役：ルールだけの版（API キーが無いとき）', () => {
  it('作家の答えを道具に直す', () => {
    expect(parseAnswer('title', '青い潮 / Blue Tide')).toEqual({ calls: [{ name: 'set_title', input: { ja: '青い潮', en: 'Blue Tide' } }] });
    expect(parseAnswer('year', '去年、2025年です')).toEqual({ calls: [{ name: 'set_year', input: { year: 2025 } }] });
    expect(parseAnswer('size', 'F15です')).toMatchObject({ calls: [{ name: 'set_size', input: { gou: 'F15' } }] });
    expect(parseAnswer('price', '19.8万円で販売中')).toEqual({ calls: [{ name: 'set_availability', input: { availability: 'available' } }, { name: 'set_price', input: { price_jpy: 198000 } }] });
    expect(parseAnswer('price', '非売品です')).toEqual({ calls: [{ name: 'set_availability', input: { availability: 'not_for_sale' } }] });
    expect(parseAnswer('moods', '朝の光、静けさ、新しい章')).toMatchObject({ calls: [{ name: 'propose_moods', input: { words: ['朝の光', '静けさ', '新しい章'] } }] });
    expect(parseAnswer('moods', 'あとで')).toEqual({ calls: [{ name: 'skip_field', input: { field: 'moods' } }] });
    expect(parseAnswer('title', 'あとで')).toEqual({ calls: [{ name: 'skip_field', input: { field: 'title' } }] });
  });
  it('話した想いを 40 字以内の文に分ける（足さない）', () => {
    const s = splitSentences('海辺の町で描いた。朝の光が水面で割れるとき、青が緑に変わる一瞬があって、それをどうしても手のひらに収まる大きさに閉じ込めたかった。\nまた見に来てほしい');
    expect(s.length).toBeGreaterThanOrEqual(3);
    expect(s.every((x) => [...x].length <= 40)).toBe(true);
    expect(s.join('')).toBe('海辺の町で描いた。朝の光が水面で割れるとき、青が緑に変わる一瞬があって、それをどうしても手のひらに収まる大きさに閉じ込めたかった。また見に来てほしい');
  });
  it('会話を最後まで通すと全部の項目が埋まる（想いと気分は確認待ち）', () => {
    let d: any = { id: 'draft_aaaaaaaaaaaaaaaa', work_id: null, status: 'draft', photo: PHOTO, data: emptyData() };
    const answers = ['テストの青 / Test Blue', '2026', 'F15', 'キャンバスにアクリル', '198,000円', '色が混ざる瞬間が好きだった。朝の光みたいに見えた。見た人が少し元気になればいい。', '朝の光、静けさ、新しい章'];
    const replies: string[] = [];
    for (const a of answers) { const r = rulesTurn(d, a, null); d = r.draft; replies.push(r.reply); }
    expect(replies[0]).toContain('描いた年');
    expect(replies[1]).toContain('大きさ');
    expect(replies[4]).toContain('想い');
    expect(fieldState(d, 'messages')).toBe('pending');
    expect(fieldState(d, 'moods')).toBe('pending');
    expect(replies[6]).toContain('これでいい');
    expect(d.data.work.size_cm).toEqual([53, 65.2]);
  });
  it('「あとで」にした項目は、ほかが済んだら最後にもう一度聞く（公開に要るものだけ）', () => {
    let d: any = { id: 'x', work_id: null, status: 'draft', photo: PHOTO, data: emptyData() };
    d = rulesTurn(d, 'あとで', null).draft;
    expect(nextField(d)).toBe('year');
    const full = fullDraft();
    const back = { ...full, data: applyPatch({ ...full.data, work: { ...full.data.work, title: undefined } }, { skip: 'title' }) };
    delete back.data.work.title;
    expect(nextField(back)).toBe('moods');   // まだの項目が先
    back.data = applyPatch(back.data, { skip: 'moods' });
    expect(nextField(back)).toBe('title');   // 気分の言葉は「あとで」のままでよいので、題名に戻る
  });
  it('大きさが写真と合わなければ聞き直し、値を入れない', () => {
    const d: any = { id: 'x', work_id: null, status: 'draft', photo: PHOTO, data: applyPatch(emptyData(), { work: { title: { ja: 'a' }, year: 2026 } }) };
    const r = rulesTurn(d, 'S15', null);
    expect(r.reply).toMatch(/写真の端/);
    expect(r.draft.data.work.size_cm).toBeUndefined();
  });
  it('支払いリンクを貼れば、どの問いの途中でも拾う', () => {
    const d: any = { id: 'x', work_id: null, status: 'draft', photo: PHOTO, data: emptyData() };
    const r = rulesTurn(d, 'https://buy.stripe.com/test_abcd1234', null);
    expect(r.draft.data.work.buy.url).toBe('https://buy.stripe.com/test_abcd1234');
    expect(r.reply).toContain('支払いリンク');
  });
});

describe('聞き役：Claude（応答を差し替え。道具の呼び出しを固定で返す）', () => {
  const chat = { messages: [{ role: 'user', content: '題名は「テストの青」、英語で Test Blue。2026 年に描いた F15 です' }], colors: ['#c23a2b'], focus: null };
  const base = () => ({ id: 'draft_aaaaaaaaaaaaaaaa', work_id: null, status: 'draft', photo: PHOTO, data: emptyData() });
  it('道具を当て、エラーは is_error で返し、応答をそのまま次の往復に入れる', async () => {
    const bodies: any[] = [];
    const responses = [
      { stop_reason: 'tool_use', content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: 't1', name: 'set_title', input: { ja: 'テストの青', en: 'Test Blue' } },
        { type: 'tool_use', id: 't2', name: 'set_year', input: { year: 2026 } },
        { type: 'tool_use', id: 't3', name: 'set_size', input: { gou: 'S15', width_cm: null, height_cm: null, confirm_mismatch: false } },
      ] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '題名と年を記録しました。大きさは写真と少し合わないので、写真の端が切れていませんか？' }] },
    ];
    const r = await claudeTurn(base(), chat, 'claude-sonnet-5-5', async (b) => { bodies.push(structuredClone(b)); return responses.shift(); });
    expect(r.reply).toContain('写真の端');
    expect(r.applied).toEqual(['set_title', 'set_year']);
    expect(r.errors[0]).toMatch(/縦横比/);
    expect(r.draft.data.work.title).toEqual({ ja: 'テストの青', en: 'Test Blue' });
    expect(r.draft.data.work.size_cm).toBeUndefined();
    // 2 回目の要求：1 回目の応答をそのまま（思考の塊も）、結果は 1 つの user に
    const second = bodies[1].messages;
    expect(second[1].role).toBe('assistant');
    expect(second[1].content[0].type).toBe('thinking');
    expect(second[2].role).toBe('user');
    expect(second[2].content.map((c: any) => c.tool_use_id)).toEqual(['t1', 't2', 't3']);
    expect(second[2].content[2].is_error).toBe(true);
    // 本文：モデル、strict の道具、auto、写真は入れない（色の値だけ）
    expect(bodies[0].model).toBe('claude-sonnet-5-5');
    expect(bodies[0].tool_choice).toEqual({ type: 'auto' });
    expect(bodies[0].tools.every((t: any) => t.strict)).toBe(true);
    expect(bodies[0].fallbacks).toBe('default');
    expect(JSON.stringify(bodies[0])).not.toMatch(/"type":"image"|base64/);
    expect(bodies[0].system[1].text).toContain('#c23a2b');
  });
  it('道具だけで文が無ければ、ルールの問いで続ける。拒否と途中切れは道具を当てない', async () => {
    const r = await claudeTurn(base(), chat, 'claude-sonnet-5-5', async (b) => b.messages.length === 1
      ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'set_title', input: { ja: 'テストの青', en: null } }] }
      : { stop_reason: 'end_turn', content: [] });
    expect(r.reply).toContain('描いた年');
    const refused = await claudeTurn(base(), chat, 'claude-sonnet-5-5', async () => ({ stop_reason: 'refusal', content: [{ type: 'tool_use', id: 't', name: 'set_year', input: { year: 2026 } }] }));
    expect(refused.reply).toBeNull();
    expect(refused.draft.data.work.year).toBeUndefined();
    const cut = await claudeTurn(base(), chat, 'claude-sonnet-5-5', async () => ({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 't', name: 'set_year', input: { year: 2026 } }] }));
    expect(cut.draft.data.work.year).toBeUndefined();
    const down = await claudeTurn(base(), chat, 'claude-sonnet-5-5', async () => null);
    expect(down.reply).toBeNull();
  });
  it('会話の本文の検査：最後は user、長さ、色は #rrggbb だけ', () => {
    expect(validateChatBody({ id: 'draft_aaaaaaaaaaaaaaaa', messages: [{ role: 'user', content: 'こんにちは' }] })).not.toBeNull();
    expect(validateChatBody({ id: 'draft_aaaaaaaaaaaaaaaa', messages: [{ role: 'assistant', content: 'x' }] })).toBeNull();
    expect(validateChatBody({ id: 'draft_aaaaaaaaaaaaaaaa', messages: [{ role: 'user', content: 'あ'.repeat(1201) }] })).toBeNull();
    expect(validateChatBody({ id: 'draft_aaaaaaaaaaaaaaaa', messages: [{ role: 'user', content: 'a' }], colors: ['red'] })).toBeNull();
    expect(validateChatBody({ id: 'bad', messages: [{ role: 'user', content: 'a' }] })).toBeNull();
    expect(validateChatBody({ id: 'draft_aaaaaaaaaaaaaaaa', messages: [{ role: 'user', content: 'a' }], focus: 'photo' })).toBeNull();
    expect(chatBody(base(), { messages: [{ role: 'user', content: 'a' }], colors: [], focus: 'size' }, 'claude-sonnet-5-5').system[1].text).toContain('「大きさ」を直したい');
  });
});

// ───── 下書きの API：ローカルの SQLite を D1 の代わりに（migrations をそのまま流す）、R2 は Map ─────
function d1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'));
  const wrap = (sql: string) => {
    let args: any[] = [];
    const s = {
      bind(...a: any[]) { args = a.map((x) => (x === undefined ? null : x)); return s; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
    return s;
  };
  return { prepare: wrap, raw: db };
}
function r2() {
  const m = new Map<string, Uint8Array>();
  return {
    m,
    async put(k: string, v: Uint8Array) { m.set(k, new Uint8Array(v)); },
    async get(k: string) { const v = m.get(k); return v ? { body: new Blob([v as Uint8Array<ArrayBuffer>]).stream(), arrayBuffer: async () => v.slice().buffer } : null; },
    async delete(k: string) { m.delete(k); },
  };
}
const ORIGIN = 'https://meet.example.com';
const CATALOG = { works: [{ id: 'harmoney', title: { ja: 'Harmoney' }, image: 'works/harmoney/generated/painting_1024.jpg', url: 'w/harmoney/' }] };
let env: any;
const SECRET = 's'.repeat(48);
const TOKEN = 'p'.repeat(40);
beforeAll(async () => { (globalThis as any).__hash = await hashPassword('test-password-only-here', { iterations: 10_000 }); });
beforeEach(() => {
  resetRegisterReadyMemo(); resetCatalogMemo();
  env = { DB: d1(), WORK_UPLOADS: r2(), ASSETS: { fetch: async () => new Response(JSON.stringify(CATALOG)) }, ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: (globalThis as any).__hash, ADMIN_SESSION_SECRET: SECRET, PUBLISH_TOKEN: TOKEN };
});
const req = (path: string, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, init);
const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });
const ctx = (path: string, init: RequestInit = {}, params: Record<string, string> = {}, data: any = { admin: { name: 'owner' } }) => ({ request: req(path, init), env, params, data });
const patch = (id: string, body: unknown) => draftPatch(ctx(`/api/admin/works/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, { id }));

describe('下書きの API', () => {
  it('表か R2 が無ければ「登録はまだ使えません」の理由を返し、作れない', async () => {
    const e2 = { ...env, WORK_UPLOADS: undefined };
    expect((await json(await worksConfig({ env: e2 } as any))).body).toMatchObject({ ready: false, reason: 'no_bucket' });
    resetRegisterReadyMemo();
    const db = new DatabaseSync(':memory:');
    const e3 = { ...env, DB: { prepare: (sql: string) => ({ bind: () => ({}), first: async () => db.prepare(sql).get() }) } };
    expect((await json(await worksConfig({ env: e3 } as any))).body).toMatchObject({ ready: false, reason: 'no_table' });
    resetRegisterReadyMemo();
    expect((await worksCreate({ env: e2 } as any)).status).toBe(503);
    const list = await json(await worksList({ request: req('/api/admin/works'), env: e2 } as any));
    expect(list.body.ready).toBe(false);
    expect(list.body.works[0].id).toBe('harmoney');   // 作品の一覧は出せる
  });

  it('作る → 写真 → 会話（ルールだけの版）で全部埋める → 確認 → 公開の待ち → 書き出し → 結果', async () => {
    const created = await json(await worksCreate({ env } as any));
    expect(created.status).toBe(201);
    const id = created.body.draft.id;
    // 写真が無いと会話はできない
    const early = await handleChat(req('/api/admin/works/chat', { method: 'POST', body: JSON.stringify({ id, messages: [{ role: 'user', content: 'こんにちは' }] }) }), env);
    expect(early.status).toBe(409);
    // 写真（EXIF 付きの無地。縦長 53:65.2 に近い）
    const src = await sharp({ create: { width: 1626, height: 2000, channels: 3, background: '#2a4a7a' } }).jpeg().withExif({ IFD0: { ImageDescription: 'gps-here' } }).toBuffer();
    const put = await json(await photoPut(ctx(`/api/admin/works/${id}/photo`, { method: 'PUT', body: new Uint8Array(src), headers: { 'Content-Type': 'image/jpeg' } }, { id })));
    expect(put.status).toBe(200);
    expect(put.body.draft.photo).toMatchObject({ width: 1626, height: 2000, type: 'image/jpeg' });
    expect(Buffer.from(env.WORK_UPLOADS.m.get(`drafts/${id}/painting`)).includes(Buffer.from('gps-here'))).toBe(false);
    const got = await photoGet(ctx(`/api/admin/works/${id}/photo`, {}, { id }));
    expect(got.headers.get('Content-Type')).toBe('image/jpeg');
    // SVG を写真と偽っても断る
    const svg = await photoPut(ctx(`/api/admin/works/${id}/photo`, { method: 'PUT', body: '<svg/>', headers: { 'Content-Type': 'image/jpeg' } }, { id }));
    expect(svg.status).toBe(415);

    const history: any[] = [];
    const say = async (text: string) => {
      history.push({ role: 'user', content: text });
      const r = await json(await handleChat(req('/api/admin/works/chat', { method: 'POST', body: JSON.stringify({ id, messages: history, colors: ['#2a4a7a'] }) }), env));
      expect(r.status).toBe(200);
      history.push({ role: 'assistant', content: r.body.reply });
      return r.body;
    };
    for (const a of ['テストの青 / Test Blue', '2026', 'F15', 'キャンバスにアクリル', '198,000円']) await say(a);
    let last = await say('色が混ざる瞬間が好きだった。朝の光みたいに見えた。見た人が少し元気になればいい。');
    expect(last.mode).toBe('rules');
    expect(last.draft.work_id).toBe('test-blue');
    expect(last.draft.data.proposed.messages.length).toBe(3);
    last = await say('あとで');
    expect(last.view.missing).toEqual(['想いの文']);
    // 会話の文は保存しない：表のどこにも作家の文が無い
    const row = env.DB.raw.prepare('SELECT * FROM work_drafts WHERE id = ?').get(id);
    expect(JSON.stringify(row)).not.toContain('history');
    expect(row.data).not.toContain('こんにちは');

    // まだ公開できない
    expect((await queuePost(ctx(`/api/admin/works/${id}/queue`, { method: 'POST' }, { id }))).status).toBe(422);
    const conf = await json(await patch(id, { confirm: 'messages', value: ['色が混ざる瞬間が好きだった。', '朝の光みたいに見えた。', '見た人が少し元気になればいい。'] }));
    expect(conf.body.view.missing).toEqual([]);
    expect(conf.body.view.pay_line).toBe('支払いリンクを作ります（198,000円）');
    // id は重なれば断る
    expect((await patch(id, { work_id: 'harmoney' })).status).toBe(422);
    expect((await patch(id, { work_id: 'Bad ID' })).status).toBe(422);
    // 道具で 1 項目を直す（同じ検査）
    expect((await patch(id, { tool: 'set_year', input: { year: 3000 } })).status).toBe(422);
    expect((await json(await patch(id, { tool: 'set_year', input: { year: 2025 } }))).body.draft.data.work.year).toBe(2025);

    const q = await json(await queuePost(ctx(`/api/admin/works/${id}/queue`, { method: 'POST' }, { id })));
    expect(q.status).toBe(200);
    expect(q.body.draft.status).toBe('queued');
    expect(q.body.message).toContain('公開の準備ができました');
    // queued のあいだは直せない
    expect((await patch(id, { tool: 'set_year', input: { year: 2024 } })).status).toBe(409);

    // 書き出し（公開専用のトークンを通った data.publisher）
    const ex = await json(await exportGet(ctx('/api/admin/works/next/export', {}, { id: 'next' }, { publisher: true })));
    expect(ex.status).toBe(200);
    expect(ex.body.id).toBe(id);
    expect(ex.body.work).toMatchObject({ id: 'test-blue', year: 2025, size_cm: [53, 65.2], buy: { price_jpy: 198000 } });
    expect(Buffer.from(ex.body.photo.base64, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // Cookie の管理者は書き出せない
    expect((await exportGet(ctx(`/api/admin/works/${id}/export`, {}, { id }))).status).toBe(401);

    const post = (body: unknown) => resultPost(ctx(`/api/admin/works/${id}/result`, { method: 'POST', body: JSON.stringify(body) }, { id }, { publisher: true }));
    expect((await post({ status: 'published' })).status).toBe(409);   // building を通らずに published にしない
    expect((await post({ status: 'building' })).status).toBe(200);
    expect((await exportGet(ctx('/api/admin/works/next/export', {}, { id: 'next' }, { publisher: true }))).status).toBe(204);
    expect((await post({ status: 'published', commit: 'abc1234', page_url: 'https://meet.sheerarts.com/w/test-blue/', log: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') })).status).toBe(200);
    const fin = env.DB.raw.prepare('SELECT status, publish_commit, publish_log, published_at FROM work_drafts WHERE id = ?').get(id);
    expect(fin.status).toBe('published');
    expect(fin.publish_commit).toBe('abc1234');
    expect(fin.publish_log.split('\n')).toHaveLength(40);
    expect(fin.published_at).toBeGreaterThan(0);
    // 公開済みは消せない
    expect((await draftDelete(ctx(`/api/admin/works/${id}`, { method: 'DELETE' }, { id }))).status).toBe(409);
  });

  it('公開は 1 件ずつ：ほかが building なら 409。捨てると写真もすぐ消える', async () => {
    const a = (await json(await worksCreate({ env } as any))).body.draft.id;
    const b = (await json(await worksCreate({ env } as any))).body.draft.id;
    env.DB.raw.prepare("UPDATE work_drafts SET status = 'building' WHERE id = ?").run(a);
    env.DB.raw.prepare("UPDATE work_drafts SET status = 'queued' WHERE id = ?").run(b);
    const r = await resultPost(ctx(`/api/admin/works/${b}/result`, { method: 'POST', body: JSON.stringify({ status: 'building' }) }, { id: b }, { publisher: true }));
    expect(r.status).toBe(409);
    expect((await resultPost(ctx(`/api/admin/works/${b}/result`, { method: 'POST', body: JSON.stringify({ status: 'failed', commit: 'not-a-sha' }) }, { id: b }, { publisher: true }))).status).toBe(400);
    const c = (await json(await worksCreate({ env } as any))).body.draft.id;
    await env.WORK_UPLOADS.put(`drafts/${c}/painting`, new Uint8Array([1]));
    expect((await draftDelete(ctx(`/api/admin/works/${c}`, { method: 'DELETE' }, { id: c }))).status).toBe(200);
    expect(env.WORK_UPLOADS.m.has(`drafts/${c}/painting`)).toBe(false);
    expect((await draftGet(ctx(`/api/admin/works/${c}`, {}, { id: c }))).status).toBe(404);
  });

  it('Claude があれば道具で埋める（応答の差し替え）。失敗したらルールだけの版で続ける', async () => {
    const id = (await json(await worksCreate({ env } as any))).body.draft.id;
    await photoPut(ctx(`/api/admin/works/${id}/photo`, { method: 'PUT', body: new Uint8Array(await flat(1626, 2000)), headers: { 'Content-Type': 'image/jpeg' } }, { id }));
    env.ANTHROPIC_API_KEY = 'test-key';
    const body = JSON.stringify({ id, messages: [{ role: 'user', content: '題名はテストの青、Test Blue。2026 年' }] });
    const ai = await json(await handleChat(req('/api/admin/works/chat', { method: 'POST', body }), env, {
      callClaude: async (b: any) => b.messages.length === 1
        ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'set_title', input: { ja: 'テストの青', en: 'Test Blue' } }, { type: 'tool_use', id: 'b', name: 'set_year', input: { year: 2026 } }] }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text: '記録しました。大きさは？' }] },
    }));
    expect(ai.body.mode).toBe('ai');
    expect(ai.body.reply).toBe('記録しました。大きさは？');
    expect(ai.body.draft.data.work.year).toBe(2026);
    expect(ai.body.draft.work_id).toBe('test-blue');
    const down = await json(await handleChat(req('/api/admin/works/chat', { method: 'POST', body: JSON.stringify({ id, messages: [{ role: 'user', content: 'F15' }] }) }), env, { callClaude: async () => null }));
    expect(down.body.mode).toBe('rules');
    expect(down.body.draft.data.work.size_cm).toEqual([53, 65.2]);
  });
});

describe('公開専用のトークン（門番）', () => {
  const run = async (path: string, init: RequestInit = {}, e = env) => {
    let called = false;
    const c = { request: req(path, init), env: e, data: {} as any, next: async () => { called = true; return new Response('{}'); } };
    const res = await guard(c);
    return { status: res.status, called, data: c.data };
  };
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  it('export と result だけをトークンで通す。Origin が無くても通す（スクリプトから）', async () => {
    const a = await run('/api/admin/works/abcdefghijklmnop/export', { headers: bearer(TOKEN) });
    expect(a).toMatchObject({ status: 200, called: true, data: { publisher: true } });
    const b = await run('/api/admin/works/next/result', { method: 'POST', headers: bearer(TOKEN), body: '{}' });
    expect(b.status).toBe(200);
  });
  it('違うトークン、無いトークン、短い Secret、空の Secret は 401', async () => {
    expect((await run('/api/admin/works/next/export', { headers: bearer(`${TOKEN}x`) })).status).toBe(401);
    expect((await run('/api/admin/works/next/export')).status).toBe(401);
    expect((await run('/api/admin/works/next/export', { headers: bearer('short') }, { ...env, PUBLISH_TOKEN: 'short' })).status).toBe(401);
    expect((await run('/api/admin/works/next/export', { headers: bearer('') }, { ...env, PUBLISH_TOKEN: '' })).status).toBe(401);
  });
  it('トークンはほかの API では通らない。Cookie では export を通さない', async () => {
    for (const p of ['/api/admin/works', '/api/admin/works/next', '/api/admin/summary', '/api/admin/works/next/queue', '/api/admin/works/next/photo']) {
      const r = await run(p, { headers: bearer(TOKEN) });
      expect(r.status, p).toBe(401);
      expect(r.called).toBe(false);
    }
    const cookie = `${COOKIE_NAME}=${await signSession('owner', SECRET)}`;
    expect((await run('/api/admin/works/next/export', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await run('/api/admin/works', { headers: { Cookie: cookie } })).status).toBe(200);
  });
});
