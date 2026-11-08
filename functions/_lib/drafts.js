// 作品の登録の下書き（docs/REGISTER.md 4 節）：D1 の work_drafts と、R2 の WORK_UPLOADS（写真）。会話の文は置かない
import { draftFromRow, slugify, uniqueId, WORK_ID_RE } from './register.js';
import { romanize, isKana } from './romaji.js';

export const DRAFT_ID_RE = /^[A-Za-z0-9_-]{16,40}$/;
export const STATUSES = ['draft', 'queued', 'building', 'published', 'failed'];
const COLS = 'id, work_id, status, data, photo_key, photo_type, photo_w, photo_h, photo_bytes, publish_page_url, publish_commit, publish_deploy_url, publish_log, created_at, updated_at, queued_at, published_at';

/** ランダムな下書きの id（24 文字） */
export function newDraftId() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 登録が使えるか。DB と表（migrations/0004）と R2（WORK_UPLOADS）がそろっているとき。isolate の中に 60 秒持つ
 * reason：no_db（D1 が無い）、no_table（表がまだ）、no_bucket（R2 がまだ）
 * @type {{ at: number, ok: boolean, reason: string|null } | null}
 */
let readyMemo = null;
/** @param {any} env @param {number} [now] @returns {Promise<{ ok: boolean, reason: string|null }>} */
export async function registerReady(env, now = Date.now()) {
  if (!env?.DB) return { ok: false, reason: 'no_db' };
  if (!env?.WORK_UPLOADS) return { ok: false, reason: 'no_bucket' };
  if (readyMemo && readyMemo.ok && now - readyMemo.at < 60_000) return readyMemo;
  let ok = false;
  try { await env.DB.prepare('SELECT id FROM work_drafts LIMIT 1').first(); ok = true; }
  catch (e) { console.error('下書きの表を読めない', String(e)); }
  readyMemo = { at: now, ok, reason: ok ? null : 'no_table' };
  return readyMemo;
}
export function resetRegisterReadyMemo() { readyMemo = null; }

/** @param {any} db @param {string} id */
export async function getDraft(db, id) {
  if (!DRAFT_ID_RE.test(id)) return null;
  return draftFromRow(await db.prepare(`SELECT ${COLS} FROM work_drafts WHERE id = ?`).bind(id).first());
}

/** 新しい順。公開済みも含む（一覧に出す） @param {any} db @param {number} [limit] */
export async function listDrafts(db, limit = 100) {
  const r = await db.prepare(`SELECT ${COLS} FROM work_drafts ORDER BY updated_at DESC LIMIT ?`).bind(limit).all();
  return (r.results || []).map(draftFromRow);
}

/** @param {any} db @param {number} [now] */
export async function createDraft(db, now = Date.now()) {
  const id = newDraftId();
  await db.prepare('INSERT INTO work_drafts (id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, 'draft', JSON.stringify({ work: {}, proposed: {}, skipped: [], colors: [] }), now, now).run();
  return getDraft(db, id);
}

/** 中身（data と work_id）を書く。下書きの状態（draft・failed）のときだけ。書けなければ false @param {any} db @param {any} d @param {number} [now] */
export async function saveDraft(db, d, now = Date.now()) {
  const r = await db.prepare("UPDATE work_drafts SET data = ?, work_id = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'failed')").bind(JSON.stringify(d.data), d.work_id ?? null, now, d.id).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** 使われている作品の id（公開済みのカタログと、ほかの下書き） @param {any} db @param {any} catalog @param {string} [exceptDraft] */
export async function takenIds(db, catalog, exceptDraft) {
  const taken = new Set((catalog?.works || []).map((/** @type {any} */ w) => w.id));
  const r = await db.prepare('SELECT work_id FROM work_drafts WHERE work_id IS NOT NULL AND id != ?').bind(exceptDraft ?? '').all();
  for (const x of r.results || []) taken.add(x.work_id);
  return taken;
}

/**
 * 作品の id（URL）の案。英語の題名 → かなの題名のローマ字 → 読み方のローマ字 → 仮（work-<年>）の順。作家が自分で決めた id（manual）は変えない
 * 題名や読み方が変われば作り直す。data.id_source に作り方（en／romaji／fallback／manual）を残す
 * @param {any} d @param {Set<string>} taken
 */
export function ensureWorkId(d, taken) {
  if (d.data.id_source === 'manual' && d.work_id) return d;
  const t = d.data.work?.title;
  if (!t?.ja) return d;
  const fromEn = slugify(t.en || '') || (/^[\x20-\x7e]+$/.test(t.ja) ? slugify(t.ja) : '');
  const fromKana = !fromEn && isKana(t.ja) ? slugify(romanize(t.ja)) : '';
  const fromReading = !fromEn && !fromKana && d.data.reading ? slugify(romanize(d.data.reading)) : '';
  const [base, source] = fromEn.length >= 2 ? [fromEn, 'en'] : fromKana.length >= 2 ? [fromKana, 'romaji'] : fromReading.length >= 2 ? [fromReading, 'romaji'] : [`work-${String(d.data.work.year || new Date().getFullYear())}`, 'fallback'];
  // いまの id がこの案（か、その番号つき）なら、そのまま
  if (d.work_id && (d.work_id === base || new RegExp(`^${base}-\\d+$`).test(d.work_id)) && d.data.id_source === source) return d;
  const id = uniqueId(base, taken);
  return id ? { ...d, work_id: id, data: { ...d.data, id_source: source } } : d;
}

/** 作家が id を直したとき @param {any} id @param {Set<string>} taken */
export function checkWorkId(id, taken) {
  if (typeof id !== 'string' || !WORK_ID_RE.test(id)) return { ok: false, error: 'id は英小文字・数字・ハイフンで 2〜48 文字（先頭は英数字）' };
  if (taken.has(id)) return { ok: false, error: `「${id}」はもう使われています` };
  return { ok: true, id };
}

export const photoKey = (/** @type {string} */ id) => `drafts/${id}/painting`;

/** 画面に返す形（写真は URL で） @param {any} d */
export const publicDraft = (d) => d && ({ ...d, photo: d.photo ? { ...d.photo, url: `/api/admin/works/${d.id}/photo?v=${d.updated_at}` } : null });
