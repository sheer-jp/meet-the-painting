// 構造化した出来事（docs/ADMIN.md 1、2 節）。自由入力の文は扱わない。保存するのはストックの文か、決まった語だけ
import { pickQuestions, LANG_NAMES } from './prompt.js';

export const RETENTION_MS = 180 * 86400_000;
export const OTHER_OPENER = 'その他の選択肢';
export const OTHER_QUESTION = 'その他の問い';
export const OTHER_QUESTION_FOREIGN = 'その他の問い（日本語以外）';
const SID_RE = /^[A-Za-z0-9_-]{16,32}$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const RULE_LABELS = { morning: '朝', day: '昼', night: '夜', warm: '暖かい色', cool: '涼しい色', vivid: '鮮やかな色', soft: 'やわらかな色', quiet: '静か', lively: 'にぎやか' };
const ENUM_VIA = ['concierge', 'page', 'gallery'];
export const REACTIONS = ['love', 'curious', 'unsure'];
export const PLACES = ['story_end', 'after', 'exit', 'rooms', 'dwell', 'link'];

// ブラウザから受け付ける出来事。cg_question は無い（サーバーが応答の文から決める）
// needId：作品 id が要る。detail：via の欄の扱い（無し／決まった語の配列／'opener'／'rule'）
export const JOURNEY = {
  concierge_start: {},
  cg_opener: { detail: 'opener' },
  cg_write: {},
  cg_free: {},
  cg_rule: { detail: 'rule' },
  concierge_recommend: { needId: true },
  concierge_other: {},
  concierge_skip: {},
  enter: { needId: true, detail: ENUM_VIA },
  gallery_pick: { needId: true },
  work_view: { needId: true, detail: ['concierge', 'gallery', 'direct', 'qr'] },   // qr：会場の絵の横の QR（?from=qr）
  buy_click: { needId: true },
  fu_shown: { needId: true, detail: PLACES },
  fu_reaction: { needId: true, detail: [...REACTIONS, 'write'] },
  fu_free: { needId: true },
  fu_close: { needId: true },
  fu_sent: { needId: true },
};

const squeeze = (/** @type {any} */ s) => String(s ?? '').replace(/\s+/g, '');

// 押された選択肢の文（どの言語でも）を、カタログのプールの日本語の文に戻す。プールに無ければ「その他の選択肢」（自由入力を混ぜない）
/** @param {any} text @param {any} catalog */
export function resolveOpener(text, catalog) {
  const want = squeeze(text);
  if (!want) return OTHER_OPENER;
  for (const key of ['openers_pool', 'openers']) {
    const pool = catalog?.[key];
    if (!pool) continue;
    for (const [lang, list] of Object.entries(pool)) {
      if (lang === 'kinds' || !Array.isArray(list)) continue;
      const i = list.findIndex((s) => squeeze(s) === want);
      if (i >= 0 && typeof pool.ja?.[i] === 'string') return pool.ja[i];
    }
  }
  return OTHER_OPENER;
}

/**
 * /api/stat の本文を保存する形に直す。だめなら null。カタログが読めないとき（catalog が null）は作品 id は形だけ見る
 * @param {any} body
 * @param {any} catalog
 * @returns {{ sid: string, ev: string, work_id: string|null, detail: string|null, lang: string|null } | null}
 */
export function normalizeJourney(body, catalog) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.ev !== 'string' || !Object.prototype.hasOwnProperty.call(JOURNEY, body.ev)) return null;
  if (typeof body.sid !== 'string' || !SID_RE.test(body.sid)) return null;
  const def = /** @type {any} */ (JOURNEY)[body.ev];
  let work_id = null;
  if (def.needId) {
    if (typeof body.id !== 'string' || !ID_RE.test(body.id)) return null;
    if (catalog && !catalog.works?.some((/** @type {any} */ w) => w.id === body.id)) return null;
    work_id = body.id;
  } else if (body.id != null) return null;
  let detail = null;
  if (def.detail === 'opener') detail = resolveOpener(body.via, catalog);
  else if (def.detail === 'rule') {
    detail = Object.prototype.hasOwnProperty.call(RULE_LABELS, body.via) ? /** @type {any} */ (RULE_LABELS)[body.via] : null;
    if (!detail) return null;
  } else if (Array.isArray(def.detail)) {
    if (!def.detail.includes(body.via)) return null;
    detail = body.via;
  } else if (body.via != null) return null;
  const lang = typeof body.lang === 'string' && Object.prototype.hasOwnProperty.call(LANG_NAMES, body.lang) ? body.lang : null;
  return { sid: body.sid, ev: body.ev, work_id, detail, lang };
}

/** @param {any} db @param {{ sid: string, ev: string, work_id: string|null, detail: string|null, lang: string|null }} e @param {number} [now] */
export function insertEvent(db, e, now = Date.now()) {
  return db.prepare('INSERT INTO events (at, sid, ev, work_id, detail, lang) VALUES (?, ?, ?, ?, ?, ?)').bind(now, e.sid, e.ev, e.work_id, e.detail, e.lang).run();
}

// 期限切れを消す。Pages Functions に定期実行が無いので、書き込みのついでにまれに
/** @param {any} db @param {number} [now] */
export function purgeOld(db, now = Date.now()) {
  return db.prepare('DELETE FROM events WHERE at < ?').bind(now - RETENTION_MS).run();
}
/** @param {any} db @param {number} [rate] @param {() => number} [rand] */
export async function maybePurge(db, rate = 0.005, rand = Math.random) {
  if (rand() < rate) await purgeOld(db);
}

// ───── 案内役の問い：応答の文から、ストックのどの問いかを決める。文そのものは保存しない ─────
const grams = (/** @type {string} */ s) => {
  const t = s.replace(/[\s。、，．！？!?…「」『』（）()]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
/** 文字の 2-gram の Dice 係数 @param {string} a @param {string} b */
export function similarity(a, b) {
  const x = grams(a), y = grams(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return (2 * n) / (x.size + y.size);
}

const MATCH_AT = 0.4;
// 応答の中の最後の問いの文（「？」か「?」で終わる）。無ければ null
/** @param {string} text */
export function lastQuestion(text) {
  const list = String(text ?? '').split(/\n+|(?<=[。！!])/).map((s) => s.trim()).filter((s) => /[？?؟]$/.test(s));
  return list.length ? list[list.length - 1] : null;
}
/**
 * 応答の文から、出来事の detail を決める。問いが無ければ null（おすすめの回など）
 * @param {string} text @param {string[]} candidates その会話の候補（pickQuestions）@param {string} lang
 */
export function askedQuestion(text, candidates, lang) {
  const q = lastQuestion(text);
  if (!q) return null;
  if (lang !== 'ja') return OTHER_QUESTION_FOREIGN;
  let best = null, score = 0;
  for (const c of candidates) { const s = similarity(q, c); if (s > score) { score = s; best = c; } }
  return best && score >= MATCH_AT ? best : OTHER_QUESTION;
}

// 受付の応答が終わったところで呼ぶ。失敗しても会話に影響させない
/** @param {any} env @param {{ sid: any, lang: string, seed?: string, catalog: any, text: string }} o */
export async function recordAsked(env, o) {
  if (!env?.DB || typeof o.sid !== 'string' || !SID_RE.test(o.sid)) return;
  const detail = askedQuestion(o.text, pickQuestions(o.catalog, o.seed), o.lang);
  if (!detail) return;
  await insertEvent(env.DB, { sid: o.sid, ev: 'cg_question', work_id: null, detail, lang: o.lang });
}

// 表まで作られているか（migrations を当てる前は false）。isolate の中に 60 秒持つ
/** @type {{ at: number, ok: boolean } | null} */
let readyMemo = null;
/** @param {any} env @param {number} [now] */
export async function dbReady(env, now = Date.now()) {
  if (!env?.DB) return false;
  if (readyMemo && now - readyMemo.at < 60_000) return readyMemo.ok;
  let ok = false;
  try { await env.DB.prepare('SELECT id FROM feedback LIMIT 1').first(); ok = true; }
  catch (e) { console.error('感想の表を読めない', String(e)); }
  readyMemo = { at: now, ok };
  return ok;
}
export function resetDbReadyMemo() { readyMemo = null; }

// ───── 1 日の上限（日本時間で数える）。表 daily_counts に数を持つ（migrations/0002）。KV は書き込みの上限が低いので使わない ─────
/**
 * 1 回分を数え、上限の内なら true。数えられないとき（表が無いなど）は false（費用と書き込みを増やさない側に倒す）
 * @param {any} db @param {string} name @param {number} cap @param {number} [now]
 */
export async function takeDaily(db, name, cap, now = Date.now()) {
  try {
    const day = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
    const row = await db.prepare('INSERT INTO daily_counts (day, name, n) VALUES (?, ?, 1) ON CONFLICT (day, name) DO UPDATE SET n = n + 1 RETURNING n').bind(day, name).first();
    if (Math.random() < 0.002) await db.prepare('DELETE FROM daily_counts WHERE day < ?').bind(new Date(now - 7 * 86400_000 + 9 * 3600_000).toISOString().slice(0, 10)).run();
    return (row?.n ?? Infinity) <= cap;
  } catch (e) {
    console.error('1 日の数を数えられない', String(e));
    return false;
  }
}
