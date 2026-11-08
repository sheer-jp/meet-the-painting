// 作品の登録（docs/REGISTER.md 3、4 節）。下書きの形、号数の表、項目ごとの道具とその検査、決まった順に聞く聞き役（ルールだけの版）、
// work.json への写し。純関数だけ。Pages Functions のグローバルに触れない（tests と scripts/publish-draft.mjs からも使う）
import { ROOMS } from './rooms-list.js';
import { isKana } from './romaji.js';

// ───── 号数 → cm（長辺, 短辺）。F・P・M は同じ号なら長辺が同じ。S は正方形。SM はサムホール ─────
const LONG = { 0: 18, 1: 22.7, 2: 25.8, 3: 27.3, 4: 33.3, 5: 35, 6: 41, 8: 45.5, 10: 53, 12: 60.6, 15: 65.2, 20: 72.7, 25: 80.3, 30: 91 };
const SHORT = {
  F: { 0: 14, 1: 15.8, 2: 17.9, 3: 22, 4: 24.2, 5: 27.3, 6: 31.8, 8: 38, 10: 45.5, 12: 50, 15: 53, 20: 60.6, 25: 65.2, 30: 72.7 },
  P: { 0: 12, 1: 14, 2: 16, 3: 19, 4: 22, 5: 24.2, 6: 27.3, 8: 33.3, 10: 41, 12: 45.5, 15: 50, 20: 53, 25: 60.6, 30: 65.2 },
  M: { 0: 10, 1: 12, 2: 14, 3: 16, 4: 19, 5: 22, 6: 24.2, 8: 27.3, 10: 33.3, 12: 41, 15: 45.5, 20: 50, 25: 53, 30: 60.6 },
};
export const GOU_NUMBERS = Object.keys(LONG).map(Number);

/** 号数の表（長辺, 短辺）。無ければ null @param {string} series F|P|M|S|SM @param {number} [n] */
export function gouSize(series, n) {
  const s = String(series).toUpperCase();
  if (s === 'SM') return [22.7, 15.8];
  if (n == null || !Object.prototype.hasOwnProperty.call(LONG, n)) return null;
  const long = /** @type {any} */ (LONG)[n];
  if (s === 'S') return [long, long];
  const short = /** @type {any} */ (SHORT)[s]?.[n];
  return short ? [long, short] : null;
}

/** 「F15」「f 15 号」「SM」「15号」（系列が無ければ F）を { series, n } に。読めなければ null @param {any} text */
export function parseGou(text) {
  const t = String(text ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  if (/(^|[^A-Z])SM(号)?($|[^A-Z])/.test(t) || t === 'サムホール') return { series: 'SM', n: null };
  let m = /(^|[^A-Z])([FPMS])(\d{1,2})号?/.exec(t);
  if (m) return gouSize(m[2], Number(m[3])) ? { series: m[2], n: Number(m[3]) } : null;
  m = /(^|[^\d.])(\d{1,2})号/.exec(t);
  if (m) return gouSize('F', Number(m[2])) ? { series: 'F', n: Number(m[2]) } : null;
  return null;
}

/** 号数の表示 { ja: 'F15号', en: 'F15' } @param {{ series: string, n: number|null }} g */
export const gouLabel = (g) => g.series === 'SM' ? { ja: 'SM', en: 'SM' } : { ja: `${g.series}${g.n}号`, en: `${g.series}${g.n}` };

/** 文から「65.2 × 53」のような 2 つの数を読む（cm）。読めなければ null @param {any} text */
export function parseCm(text) {
  const t = String(text ?? '').normalize('NFKC').replace(/,/g, '.');
  const m = /(\d{1,3}(?:\.\d{1,2})?)\s*(?:cm)?\s*[x×*✕xX、,/／\s]\s*(?:横|縦|高さ|幅)?\s*(\d{1,3}(?:\.\d{1,2})?)/i.exec(t);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return a > 0 && b > 0 ? [a, b] : null;
}

// 写真の縦横比と寸法の縦横比の違い（割合）。0.05 以上なら聞き直す
export const ASPECT_TOLERANCE = 0.05;
/** @param {[number, number]} size [幅, 高さ] @param {number} pw @param {number} ph */
export function aspectDiff(size, pw, ph) {
  const a = size[0] / size[1], p = pw / ph;
  return Math.abs(a / p - 1);
}
/** 長辺・短辺を写真の向きで [幅, 高さ] に並べる。写真が無ければ横長 @param {[number, number]} ls @param {number} [pw] @param {number} [ph] */
export function orient(ls, pw, ph) {
  const [long, short] = ls;
  return pw && ph && ph > pw ? [short, long] : [long, short];
}

// ───── 下書きの形 ─────
// data：{ work（確定した値。work.json の形）、proposed（作家の確認待ち：messages、moods）、skipped（「あとで」にした項目）、colors（ブラウザで写真から取った色の値）}
/** @returns {any} */
export const emptyData = () => ({ work: {}, proposed: {}, skipped: [], colors: [] });

/** D1 の行を扱いやすい形に @param {any} row */
export function draftFromRow(row) {
  if (!row) return null;
  let data;
  try { data = { ...emptyData(), ...JSON.parse(row.data || '{}') }; } catch { data = emptyData(); }
  return {
    id: row.id, work_id: row.work_id ?? null, status: row.status, data,
    photo: row.photo_key ? { type: row.photo_type, width: row.photo_w, height: row.photo_h, bytes: row.photo_bytes } : null,
    publish: { page_url: row.publish_page_url ?? null, commit: row.publish_commit ?? null, deploy_url: row.publish_deploy_url ?? null, log: row.publish_log ?? null },
    created_at: row.created_at, updated_at: row.updated_at, queued_at: row.queued_at ?? null, published_at: row.published_at ?? null,
  };
}

// 聞く順（docs/REGISTER.md 3 節）。写真は会話の前に選ぶ
export const ORDER = ['photo', 'title', 'reading', 'year', 'size', 'medium', 'price', 'messages', 'moods'];
export const FIELD_LABEL = { photo: '写真', title: '題名', reading: '題名の読み方', year: '描いた年', size: '大きさ', medium: '画材', price: '値段', messages: '想いの文', moods: '気分の言葉' };
// 「あとで」にできる項目（公開にはなくてもよいもの）
export const SKIPPABLE = ['moods', 'reading'];

/** 題名から URL（英語かローマ字）を作るのに読み方が要るか：英語の題名が無く、題名がかなと英数字だけではない（漢字がある） @param {any} d */
export function needsReading(d) {
  const t = d.data.work?.title;
  if (!t?.ja || t.en || d.data.id_source === 'manual') return false;
  return !/^[\x20-\x7e]+$/.test(t.ja) && !isKana(t.ja);
}

/** その項目の状態：done（確定）、pending（作家の確認待ち）、skipped、missing @param {any} d draftFromRow の形 @param {string} f */
export function fieldState(d, f) {
  const w = d.data.work || {};
  const p = d.data.proposed || {};
  const done = {
    photo: !!d.photo,
    title: !!w.title?.ja,
    reading: !!w.title?.ja && (!needsReading(d) || !!d.data.reading),
    year: Number.isInteger(w.year),
    size: Array.isArray(w.size_cm) && w.size_cm.length === 2,
    medium: !!w.medium?.ja,
    price: !!w.availability && (w.availability !== 'available' || Number.isInteger(w.buy?.price_jpy)),
    messages: Array.isArray(w.messages) && w.messages.length >= 3,
    moods: Array.isArray(w.moods?.ja) && w.moods.ja.length >= 3,
  }[f];
  if (done) return 'done';
  if ((f === 'messages' && p.messages) || (f === 'moods' && p.moods)) return 'pending';
  if ((d.data.skipped || []).includes(f)) return 'skipped';
  if (f === 'reading' && !w.title?.ja) return 'skipped';   // 題名のあとで聞く
  return 'missing';
}

/** 次に聞く項目。確認待ちと「あとで」は飛ばす。ほかが済んだら、「あとで」にした公開に要る項目に戻る。全部済めば null @param {any} d */
export const nextField = (d) => ORDER.find((f) => fieldState(d, f) === 'missing') ?? ORDER.find((f) => fieldState(d, f) === 'skipped' && !SKIPPABLE.includes(f)) ?? null;
/** 確認待ちの項目 @param {any} d */
export const pendingFields = (d) => ORDER.filter((f) => fieldState(d, f) === 'pending');

/** 公開の準備ができているか。足りないものの名前を返す（空なら公開できる） @param {any} d */
export function missingForPublish(d) {
  const out = ORDER.filter((f) => !['done', ...(SKIPPABLE.includes(f) ? ['skipped'] : [])].includes(fieldState(d, f))).map((f) => /** @type {any} */ (FIELD_LABEL)[f]);
  if (!d.work_id || !WORK_ID_RE.test(d.work_id)) out.push('作品の id');
  return out;
}

// ───── 作品の id（URL になる）。英語の題名から ─────
export const WORK_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
/** @param {any} text */
export function slugify(text) {
  return String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}
/** 重ならない id。taken は使われている id の集まり @param {string} base @param {Set<string>} taken */
export function uniqueId(base, taken) {
  const b = WORK_ID_RE.test(base) ? base : null;
  if (!b) return null;
  if (!taken.has(b)) return b;
  for (let i = 2; i < 100; i++) { const c = `${b}-${i}`; if (!taken.has(c)) return c; }
  return null;
}

// ───── 部屋：大きさから自動で選ぶ（scripts/generate/rooms.js の compositeRooms と同じ決め方） ─────
/** @param {[number, number]} size */
export function autoRooms(size) {
  const long = Math.max(...size);
  const perCat = /** @type {Record<string, number>} */ ({});
  const list = [...ROOMS].sort((a, b) => a.name < b.name ? -1 : 1).sort((a, b) => (a.place ? 0 : 1) - (b.place ? 0 : 1));
  return list.filter((r) => {
    if (r.disabled) return false;
    if (r.suits_cm && !(long >= r.suits_cm[0] && long <= r.suits_cm[1])) return false;
    perCat[r.category] = (perCat[r.category] || 0) + 1;
    return perCat[r.category] <= (r.place ? 3 : 2);
  }).map((r) => r.name);
}
export const roomLabel = (/** @type {string} */ name) => ROOMS.find((r) => r.name === name)?.label || name;

// ───── 道具（Claude の tool use）。入力は型で縛る（strict）。範囲や長さはここでは書けないので、サーバーの validateTool で確かめる ─────
const S = { type: 'string' };
const NS = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const obj = (/** @type {Record<string, any>} */ props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
export const AVAILABILITY = ['available', 'sold', 'not_for_sale'];
export const SKIP_FIELDS = ['title', 'reading', 'year', 'size', 'medium', 'price', 'messages', 'moods'];

export const TOOLS = [
  { name: 'set_title', description: '題名を入れる。作家が言った題名だけ。ja は日本語の題名（必須。英語だけの題名ならそのまま）。en は英語の題名（作家が言わなければ、日本語の題名の自然な英訳を入れてよい。作家は確認カードで直せる）', input_schema: obj({ ja: S, en: NS }) },
  { name: 'set_reading', description: '題名の読み方（ひらがな）。英語の題名が無く、題名に漢字があるとき、URL（ローマ字）を作るのに使う。作家が言った読み方だけ。作家は確認カードの URL で直せる', input_schema: obj({ reading: S }) },
  { name: 'set_year', description: '描いた年（西暦 4 桁）。作家が言った年だけ。推測しない', input_schema: obj({ year: { type: 'integer' } }) },
  { name: 'set_size', description: '大きさ。号で言われたら gou（例 "F15"、"P10"、"S6"、"SM"。系列を言わなければ F）。cm で言われたら width_cm と height_cm（作家の言った順のまま。縦横はサーバーが写真の向きで決める）。写真の縦横比と 5% 以上違うとエラーが返るので、作家に「写真の端が切れていませんか」と聞き直す。作家が「その寸法で合っている」と言ったときだけ confirm_mismatch を true にする', input_schema: obj({ gou: NS, width_cm: { anyOf: [{ type: 'number' }, { type: 'null' }] }, height_cm: { anyOf: [{ type: 'number' }, { type: 'null' }] }, confirm_mismatch: { type: 'boolean' } }) },
  { name: 'set_medium', description: '何に何で描いたか（例「キャンバスにアクリル」）。ja は作家の言葉どおり。en は英訳（任意）', input_schema: obj({ ja: S, en: NS }) },
  { name: 'set_price', description: '値段（税込の円、整数）。作家が言った金額だけ。「19.8 万」なら 198000', input_schema: obj({ price_jpy: { type: 'integer' } }) },
  { name: 'set_availability', description: '販売の状態。available（いま買える）、sold（売れた）、not_for_sale（非売品）', input_schema: obj({ availability: { type: 'string', enum: AVAILABILITY } }) },
  { name: 'set_buy_url', description: '作家がすでに作って貼った Stripe の支払いリンク（https://buy.stripe.com/...）。貼られたときだけ。無いときは呼ばない（公開のときに作る）。null で外す', input_schema: obj({ url: NS }) },
  { name: 'propose_messages', description: '作家が話した想いを、奥から浮かぶ文に整えた下書き。3〜10 文、1 文 40 字以内、話すような日本語。作家の言葉に無いことは足さない。作家が確認カードで直して「これでいい」を押すまで確定しない', input_schema: obj({ messages: { type: 'array', items: S } }) },
  { name: 'propose_moods', description: 'どんな気分の人に見てほしいかの言葉の下書き。words は 3〜5 語（1 語 12 字くらい）、fit は向く人・時間・場所を 1 行（任意）。作家の言葉と、渡された色の値から。作家が選んで確定する', input_schema: obj({ words: { type: 'array', items: S }, fit: NS }) },
  { name: 'set_rooms', description: '部屋で見るに使う部屋を作家が選び直したときだけ。名前は渡された部屋の一覧から', input_schema: obj({ rooms: { type: 'array', items: S } }) },
  { name: 'skip_field', description: '作家が「あとで」と言った項目を飛ばす', input_schema: obj({ field: { type: 'string', enum: SKIP_FIELDS } }) },
].map((t) => ({ ...t, strict: true }));
export const TOOL_NAMES = TOOLS.map((t) => t.name);

// 改行・タブ以外の制御文字と、向きを変える文字を消す
const clean = (/** @type {any} */ s) => String(s ?? '').replace(/[\u0000-\u0009\u000B-\u001F\u007F‪-‮⁦-⁩]/g, '').trim();
const oneLine = (/** @type {any} */ s) => clean(s).replace(/\s*\n\s*/g, ' ');
const isStr = (/** @type {any} */ v) => typeof v === 'string';
const len = (/** @type {string} */ s) => [...s].length;
export const BUY_URL_RE = /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_-]{4,80}$/;
export const LIMITS = { title: 60, titleEn: 80, medium: 60, mediumEn: 80, message: 40, messagesMin: 3, messagesMax: 10, mood: 16, moodsMin: 3, moodsMax: 5, fit: 40, priceMin: 1000, priceMax: 100_000_000 };

/**
 * 道具の入力を確かめて、下書きへの変更（patch）にする。{ ok: true, patch, note } か { ok: false, error }（error は Claude と作家に返す日本語）
 * patch は applyPatch に渡す。写真の大きさ（縦横比の照らし合わせ）は ctx.photo から
 * @param {string} name @param {any} input @param {{ photo?: { width: number, height: number } | null }} [ctx]
 * @returns {{ ok: true, patch: any, note: string } | { ok: false, error: string }}
 */
export function validateTool(name, input, ctx = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '入力の形が違います' };
  const bad = (/** @type {string} */ error) => /** @type {{ ok: false, error: string }} */ ({ ok: false, error });
  switch (name) {
    case 'set_title': {
      if (!isStr(input.ja)) return bad('題名（ja）がありません');
      const ja = oneLine(input.ja), en = input.en == null ? '' : oneLine(input.en);
      if (!ja) return bad('題名が空です');
      if (len(ja) > LIMITS.title || len(en) > LIMITS.titleEn) return bad('題名が長すぎます');
      return { ok: true, patch: { work: { title: en ? { ja, en } : { ja } } }, note: `題名：${ja}${en ? ` / ${en}` : ''}` };
    }
    case 'set_reading': {
      const r = isStr(input.reading) ? oneLine(input.reading).normalize('NFKC') : '';
      if (!r || !isKana(r) || len(r) > LIMITS.title) return bad('読み方はひらがなかカタカナで');
      return { ok: true, patch: { reading: r }, note: `読み方：${r}` };
    }
    case 'set_year': {
      const y = input.year, now = new Date().getFullYear();
      if (!Number.isInteger(y) || y < 1900 || y > now + 1) return bad(`年は 1900〜${now + 1} の 4 桁の数で`);
      return { ok: true, patch: { work: { year: y } }, note: `年：${y}` };
    }
    case 'set_size': {
      const photo = ctx.photo;
      /** @type {[number, number] | null} */
      let size = null;
      let label = null;
      if (input.gou != null && input.gou !== '') {
        if (!isStr(input.gou)) return bad('号の形が違います');
        const g = parseGou(input.gou);
        if (!g) return bad(`「${oneLine(input.gou).slice(0, 12)}」は号数の表（F・P・M・S、0〜30 号、SM）にありません`);
        const ls = /** @type {[number, number]} */ (gouSize(g.series, g.n ?? undefined));
        size = orient(ls, photo?.width, photo?.height);
        label = gouLabel(g);
      } else {
        const w = input.width_cm, h = input.height_cm;
        if (typeof w !== 'number' || typeof h !== 'number' || !(w >= 1 && w <= 500) || !(h >= 1 && h <= 500)) return bad('寸法は 1〜500 cm の数を 2 つ（幅と高さ）');
        size = [Math.round(w * 10) / 10, Math.round(h * 10) / 10];
        // 長辺から言う人が多いので、写真の向きと逆なら入れ替える
        if (photo && aspectDiff(size, photo.width, photo.height) > aspectDiff([size[1], size[0]], photo.width, photo.height)) size = [size[1], size[0]];
      }
      if (photo && input.confirm_mismatch !== true) {
        const diff = aspectDiff(size, photo.width, photo.height);
        if (diff >= ASPECT_TOLERANCE) return bad(`写真の縦横比と ${Math.round(diff * 100)}% 違います（写真 ${photo.width}×${photo.height}px、寸法 ${size[0]} × ${size[1]} cm）。写真の端が切れていませんか？ 寸法が合っていれば「合っています」と添えて、もう一度教えてください。`);
      }
      return { ok: true, patch: { work: { size_cm: size, size_label: label } }, note: `大きさ：${label ? `${label.ja} ・ ` : ''}${size[0]} × ${size[1]} cm` };
    }
    case 'set_medium': {
      if (!isStr(input.ja)) return bad('画材（ja）がありません');
      const ja = oneLine(input.ja), en = input.en == null ? '' : oneLine(input.en);
      if (!ja) return bad('画材が空です');
      if (len(ja) > LIMITS.medium || len(en) > LIMITS.mediumEn) return bad('画材の言葉が長すぎます');
      return { ok: true, patch: { work: { medium: en ? { ja, en } : { ja } } }, note: `画材：${ja}` };
    }
    case 'set_price': {
      const p = input.price_jpy;
      if (!Number.isInteger(p) || p < LIMITS.priceMin || p > LIMITS.priceMax) return bad(`値段は ${LIMITS.priceMin.toLocaleString('en-US')} 円以上の整数（税込）で`);
      return { ok: true, patch: { work: { buy: { price_jpy: p } } }, note: `値段：${p.toLocaleString('en-US')} 円（税込）` };
    }
    case 'set_availability': {
      if (!AVAILABILITY.includes(input.availability)) return bad('販売の状態は available・sold・not_for_sale のどれか');
      return { ok: true, patch: { work: { availability: input.availability } }, note: `状態：${AVAIL_JA[/** @type {'available'} */ (input.availability)]}` };
    }
    case 'set_buy_url': {
      if (input.url == null || input.url === '') return { ok: true, patch: { work: { buy: { url: null } } }, note: '支払いリンク：公開のときに作る' };
      const u = isStr(input.url) ? input.url.trim() : '';
      if (!BUY_URL_RE.test(u)) return bad('支払いリンクは https://buy.stripe.com/ で始まるものだけ');
      return { ok: true, patch: { work: { buy: { url: u } } }, note: '支払いリンク：貼られたものを使う' };
    }
    case 'propose_messages': {
      const r = checkMessages(input.messages);
      if (!r.ok) return r;
      return { ok: true, patch: { proposed: { messages: r.messages } }, note: `想いの文の下書き：${r.messages.length} 文（作家の確認待ち）` };
    }
    case 'propose_moods': {
      const r = checkMoods(input.words, input.fit);
      if (!r.ok) return r;
      return { ok: true, patch: { proposed: { moods: r.moods } }, note: `気分の言葉の下書き：${r.moods.ja.join('、')}（作家の確認待ち）` };
    }
    case 'set_rooms': {
      const r = checkRooms(input.rooms);
      if (!r.ok) return r;
      return { ok: true, patch: { work: { rooms: r.rooms } }, note: `部屋：${r.rooms.map(roomLabel).join('、')}` };
    }
    case 'skip_field': {
      if (!SKIP_FIELDS.includes(input.field)) return bad('飛ばせる項目ではありません');
      return { ok: true, patch: { skip: input.field }, note: `${/** @type {any} */ (FIELD_LABEL)[input.field]}はあとで` };
    }
    default: return bad('知らない道具です');
  }
}
export const AVAIL_JA = { available: '販売中', sold: '売約済み', not_for_sale: '非売品' };

/** 想いの文の検査。3〜10 文、1 文 40 字以内 @param {any} list @returns {{ ok: true, messages: string[] } | { ok: false, error: string }} */
export function checkMessages(list) {
  if (!Array.isArray(list)) return { ok: false, error: '文の並びがありません' };
  const messages = list.map((s) => (isStr(s) ? oneLine(s) : '')).filter(Boolean);
  if (messages.length < LIMITS.messagesMin || messages.length > LIMITS.messagesMax) return { ok: false, error: `文は ${LIMITS.messagesMin}〜${LIMITS.messagesMax} 文に（いま ${messages.length} 文）` };
  const long = messages.find((m) => len(m) > LIMITS.message);
  if (long) return { ok: false, error: `1 文は ${LIMITS.message} 字以内に（「${long.slice(0, 12)}…」が ${len(long)} 字）` };
  return { ok: true, messages };
}
/** 気分の言葉の検査 @param {any} words @param {any} fit @returns {{ ok: true, moods: { ja: string[], fit: string|null } } | { ok: false, error: string }} */
export function checkMoods(words, fit) {
  if (!Array.isArray(words)) return { ok: false, error: '気分の言葉がありません' };
  const ja = [...new Set(words.map((s) => (isStr(s) ? oneLine(s) : '')).filter(Boolean))];
  if (ja.length < LIMITS.moodsMin || ja.length > LIMITS.moodsMax) return { ok: false, error: `気分の言葉は ${LIMITS.moodsMin}〜${LIMITS.moodsMax} 語に（いま ${ja.length} 語）` };
  if (ja.some((w) => len(w) > LIMITS.mood)) return { ok: false, error: `1 語は ${LIMITS.mood} 字以内に` };
  const f = fit == null ? '' : isStr(fit) ? oneLine(fit) : null;
  if (f == null || len(f) > LIMITS.fit) return { ok: false, error: `向く人・時間・場所の 1 行は ${LIMITS.fit} 字以内に` };
  return { ok: true, moods: { ja, fit: f || null } };
}
/** 部屋の検査。一覧にあって使える部屋だけ、1〜6 室 @param {any} list @returns {{ ok: true, rooms: string[] } | { ok: false, error: string }} */
export function checkRooms(list) {
  if (!Array.isArray(list)) return { ok: false, error: '部屋の並びがありません' };
  const rooms = [...new Set(list.filter(isStr))];
  if (rooms.length < 1 || rooms.length > 6) return { ok: false, error: '部屋は 1〜6 室' };
  const usable = new Set(ROOMS.filter((r) => !r.disabled).map((r) => r.name));
  const unknown = rooms.find((r) => !usable.has(r));
  if (unknown) return { ok: false, error: `部屋「${unknown.slice(0, 30)}」は一覧にありません` };
  return { ok: true, rooms };
}

/** 下書きの data に patch を当てた新しい data を返す（元は変えない） @param {any} data @param {any} patch */
export function applyPatch(data, patch) {
  const out = { ...emptyData(), ...structuredClone(data) };
  if (patch.work) {
    for (const [k, v] of Object.entries(patch.work)) {
      if (k === 'buy') {
        const buy = { ...(out.work.buy || {}), ...v };
        for (const [bk, bv] of Object.entries(buy)) if (bv == null) delete buy[bk];
        out.work.buy = buy;
      } else if (v == null) delete out.work[k];
      else out.work[k] = v;
    }
    // 埋まった項目は「あとで」から外す
    out.skipped = out.skipped.filter((/** @type {string} */ f) => !fieldTouched(f, patch.work));
  }
  if (patch.proposed) {
    out.proposed = { ...out.proposed, ...patch.proposed };
    if (patch.proposed.messages) out.skipped = out.skipped.filter((/** @type {string} */ f) => f !== 'messages');
    if (patch.proposed.moods) out.skipped = out.skipped.filter((/** @type {string} */ f) => f !== 'moods');
  }
  if ('reading' in patch) { if (patch.reading) out.reading = patch.reading; else delete out.reading; out.skipped = out.skipped.filter((/** @type {string} */ f) => f !== 'reading'); }
  // 題名が変わったら、前の読み方は捨てる（新しい題名の読みを聞き直す）
  if (patch.work?.title && !('reading' in patch) && data.work?.title?.ja !== patch.work.title.ja) delete out.reading;
  if (patch.skip && !out.skipped.includes(patch.skip)) out.skipped = [...out.skipped, patch.skip];
  return out;
}
const fieldTouched = (/** @type {string} */ f, /** @type {any} */ w) => ({ reading: '-', title: 'title', year: 'year', size: 'size_cm', medium: 'medium', price: 'availability', messages: 'messages', moods: 'moods' }[f] in w) || (f === 'price' && w.buy?.price_jpy != null);

/** 作家が確認カードで「これでいい」を押した：下書きを確定に移す @param {any} data @param {'messages'|'moods'} which @param {any} value */
export function confirmProposal(data, which, value) {
  if (which === 'messages') {
    const r = checkMessages(value);
    if (!r.ok) return r;
    const out = applyPatch(data, { work: { messages: r.messages } });
    delete out.proposed.messages;
    return { ok: true, data: out };
  }
  const r = checkMoods(value?.ja, value?.fit);
  if (!r.ok) return r;
  const out = applyPatch(data, { work: { moods: { ja: r.moods.ja, ...(r.moods.fit ? { fit: { ja: r.moods.fit } } : {}) } } });
  delete out.proposed.moods;
  return { ok: true, data: out };
}

// ───── 聞き役の問い（ルールだけの版と、Claude が文を返さなかったとき） ─────
export const QUESTIONS = {
  photo: 'まず、絵の写真を選んでください。正面から、絵の端まで写っているものを。',
  title: 'この絵の名前は？ 英語の名前もあれば、「青い潮 / Blue Tide」のように続けてください。',
  reading: '作品の URL に使うので、題名の読み方をひらがなで教えてください。（例：いただき）',
  year: '描いた年は？（例：2026）',
  size: '大きさは？ 号でも cm でも（例：F15、65.2 × 53）。',
  medium: '何に、何で描きましたか？（例：キャンバスにアクリル、シナベニヤにミクストメディア、紙に水彩）',
  price: '値段（税込の円）と、いま買える状態かを教えてください。（例：198,000 円、売れた、非売品）',
  messages: 'この絵に込めた想いを、話すように教えてください。そこから奥に浮かぶ文を 3〜10 文に整えます。',
  moods: 'どんな気分の人に見てほしいですか？ 言葉を 3〜5 つ、「、」で区切って。（「あとで」でも大丈夫）',
};
/** 次の一言（問い、確認待ちの知らせ、終わり） @param {any} d */
export function composeNext(d) {
  const f = nextField(d);
  if (f) return /** @type {any} */ (QUESTIONS)[f];
  const pend = pendingFields(d);
  if (pend.length) return `右の確認カードで${pend.map((p) => /** @type {any} */ (FIELD_LABEL)[p]).join('と')}を直して、「これでいい」を押してください。`;
  const miss = missingForPublish(d);
  if (miss.length) return `あと、${miss.join('、')}が足りません。`;
  return '全部そろいました。確認カードを見て、よければ「公開する」を押してください。';
}

const SKIP_WORDS = /^(あとで|後で|スキップ|skip|later|飛ばす|とばす|パス)[。!！]?$/i;

/** 文の中の Stripe の支払いリンク @param {string} text */
export const findBuyUrl = (text) => /https:\/\/buy\.stripe\.com\/[A-Za-z0-9_-]{4,80}/.exec(text)?.[0] ?? null;

/** 作家の話した文を、40 字以内の文に分ける（ルールだけの版。整えはしない。作家が確認カードで直す） @param {string} text */
export function splitSentences(text) {
  const raw = clean(text).split(/\n+|(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let s of raw) {
    while (len(s) > LIMITS.message) {
      const head = [...s].slice(0, LIMITS.message).join('');
      const cut = Math.max(head.lastIndexOf('、'), head.lastIndexOf('，'), head.lastIndexOf(' '));
      const at = cut >= 8 ? cut + 1 : LIMITS.message;
      out.push([...s].slice(0, at).join('').trim());
      s = [...s].slice(at).join('').trim();
    }
    if (s) out.push(s);
  }
  return out.slice(0, LIMITS.messagesMax);
}

/**
 * ルールだけの版：いま聞いている項目への答えを、道具の呼び出しに直す。読めなければ { error }
 * @param {string} field @param {string} text @returns {{ calls: Array<{ name: string, input: any }> } | { error: string }}
 */
export function parseAnswer(field, text) {
  const t = clean(text);
  const n = t.normalize('NFKC');
  if (!t) return { error: 'もう一度お願いします。' };
  if (SKIP_WORDS.test(n.trim())) return SKIP_FIELDS.includes(field) ? { calls: [{ name: 'skip_field', input: { field } }] } : { error: 'もう一度お願いします。' };
  switch (field) {
    case 'title': {
      const [first, en] = t.split(/\s*[/／]\s*|\n+/).map((s) => s.trim()).filter(Boolean);
      // 「頂（いただき）」の読み方
      const m = /^(.+?)\s*[（(]\s*([ぁ-ゖァ-ヺー・\s]+)\s*[）)]$/.exec(first || '');
      const ja = m ? m[1].trim() : first;
      const ascii = /^[\x20-\x7e]+$/.test(ja || '');
      const calls = [{ name: 'set_title', input: { ja, en: en || (ascii ? ja : null) } }];
      if (m) calls.push({ name: 'set_reading', input: { reading: m[2].trim() } });
      return { calls };
    }
    case 'reading': {
      const r = n.trim().replace(/[。.]$/, '');
      return isKana(r) ? { calls: [{ name: 'set_reading', input: { reading: r } }] } : { error: 'ひらがなでお願いします（例：いただき）。「あとで」なら、URL は確認カードで決められます。' };
    }
    case 'year': {
      const m = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/.exec(n);
      return m ? { calls: [{ name: 'set_year', input: { year: Number(m[1]) } }] } : { error: '西暦の 4 桁でお願いします（例：2026）。' };
    }
    case 'size': {
      const g = parseGou(n);
      const sure = /合って|あって|このまま|正しい/.test(t);
      if (g) return { calls: [{ name: 'set_size', input: { gou: g.series === 'SM' ? 'SM' : `${g.series}${g.n}`, width_cm: null, height_cm: null, confirm_mismatch: sure } }] };
      const cm = parseCm(n);
      if (cm) return { calls: [{ name: 'set_size', input: { gou: null, width_cm: cm[0], height_cm: cm[1], confirm_mismatch: sure } }] };
      return { error: '号（例：F15）か、cm の 2 つの数（例：65.2 × 53）でお願いします。' };
    }
    case 'medium': return { calls: [{ name: 'set_medium', input: { ja: t.split('\n')[0], en: null } }] };
    case 'price': {
      const calls = [];
      const avail = /売れ|売約|sold/i.test(n) ? 'sold' : /非売|not\s*for\s*sale/i.test(n) ? 'not_for_sale' : 'available';
      calls.push({ name: 'set_availability', input: { availability: avail } });
      const man = /(\d+(?:\.\d+)?)\s*万/.exec(n.replace(/,/g, ''));
      const yen = /(\d{4,9})/.exec(n.replace(/[,，]/g, ''));
      const price = man ? Math.round(Number(man[1]) * 10000) : yen ? Number(yen[1]) : null;
      if (price != null) calls.push({ name: 'set_price', input: { price_jpy: price } });
      else if (avail === 'available') return { error: '値段を税込の円で教えてください（例：198,000 円）。' };
      return { calls };
    }
    case 'messages': {
      const list = splitSentences(t);
      if (list.length < LIMITS.messagesMin) return { error: `もう少しだけ聞かせてください（${LIMITS.messagesMin} 文以上になるように）。` };
      return { calls: [{ name: 'propose_messages', input: { messages: list } }] };
    }
    case 'moods': {
      const words = t.split(/[、,，/／・\n]+/).map((s) => s.trim()).filter(Boolean);
      return { calls: [{ name: 'propose_moods', input: { words: words.slice(0, LIMITS.moodsMax), fit: null } }] };
    }
    default: return { error: 'もう一度お願いします。' };
  }
}

// ───── work.json への写し（docs/WORK_FORMAT.md）。公開の手順（scripts/publish-draft.mjs）と export が使う ─────
/** @param {any} d draftFromRow の形 */
export function toWorkJson(d) {
  const w = d.data.work || {};
  const work = /** @type {Record<string, any>} */ ({ id: d.work_id });
  work.title = w.title;
  if (w.year != null) work.year = w.year;
  work.size_cm = w.size_cm;
  if (w.size_label) work.size_label = w.size_label;
  if (w.medium) work.medium = w.medium;
  work.messages = w.messages || [];
  if (w.availability) work.availability = w.availability;
  if (w.rooms?.length) work.rooms = w.rooms;
  if (w.moods?.ja?.length) work.moods = w.moods;
  // 支払いリンク：非売品・売約済みは載せない。値段は販売中のとき
  if (w.availability === 'available' && Number.isInteger(w.buy?.price_jpy)) work.buy = { price_jpy: w.buy.price_jpy, ...(w.buy.url ? { url: w.buy.url } : {}) };
  work.note = `管理画面の登録（下書き ${d.id}）から作った。`;
  return work;
}

/** 支払いリンクの一行（確認カード） @param {any} w */
export function payLine(w) {
  if (w.availability === 'not_for_sale') return '非売品なので、支払いリンクは作りません';
  if (w.availability === 'sold') return '売約済みなので、支払いリンクは作りません';
  const p = w.buy?.price_jpy;
  if (!Number.isInteger(p)) return '値段が決まったら、支払いリンクを作ります';
  return w.buy?.url ? `貼られた支払いリンクを使います（${p.toLocaleString('en-US')}円）` : `支払いリンクを作ります（${p.toLocaleString('en-US')}円）`;
}
