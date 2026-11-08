// 届いた感想：GET /api/admin/feedback?range=today|7|30|all&work=<id>&reaction=<r>&before=<ms>。新しい順に 50 件ずつ（以前の ?days= も読み替える）
// 各感想に from（qr：会場の QR から来た会話／online：それ以外／null：会話の記録が無いか、180 日で消えた）を付ける
import { adminJson } from '../../_lib/admin-auth.js';
import { dbReady, REACTIONS } from '../../_lib/events.js';
import { parseRange, rangeBounds } from '../../_lib/admin-data.js';

const PAGE = 50;
const SID_CHUNK = 90;   // D1 のバインドは 1 文 100 まで

/** @param {any} db @param {string[]} sids @returns {Promise<Map<string, 'qr'|'online'>>} */
async function sourcesOf(db, sids) {
  const out = new Map();
  for (let i = 0; i < sids.length; i += SID_CHUNK) {
    const part = sids.slice(i, i + SID_CHUNK);
    const r = await db.prepare(`SELECT sid, MAX(CASE WHEN ev = 'work_view' AND detail = 'qr' THEN 1 ELSE 0 END) AS qr FROM events WHERE sid IN (${part.map(() => '?').join(',')}) GROUP BY sid`).bind(...part).all();
    for (const x of r.results || []) out.set(x.sid, x.qr ? 'qr' : 'online');
  }
  return out;
}

export async function onRequestGet({ request: req, env }) {
  if (!await dbReady(env)) return adminJson(200, { db: false, items: [], next: null });
  const q = new URL(req.url).searchParams;
  // 期間は summary と同じ境目（日本時間）。感想は作家が消すまで残るので、全期間では全部出す
  const range = parseRange(q.get('range'), q.get('days'));
  const where = ['created_at >= ?'];
  const args = [range === 'all' ? 0 : rangeBounds(range).since];
  const work = q.get('work');
  if (work && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(work)) { where.push('work_id = ?'); args.push(work); }
  const reaction = q.get('reaction');
  if (reaction && REACTIONS.includes(reaction)) { where.push('reaction = ?'); args.push(reaction); }
  const before = Number(q.get('before'));
  if (Number.isFinite(before) && before > 0) { where.push('created_at < ?'); args.push(before); }
  try {
    const r = await env.DB.prepare(`SELECT id, created_at, work_id, reaction, body, lang, place, sid FROM feedback WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).bind(...args, PAGE + 1).all();
    const list = r.results || [];
    const items = list.slice(0, PAGE);
    // 同じミリ秒の感想を飛ばさないよう、ページの終わりと同じ時刻のものは次のページに回さず、この回で全部返す
    let next = list.length > PAGE ? items[items.length - 1].created_at : null;
    if (next != null && list[PAGE].created_at === next) {
      const same = await env.DB.prepare(`SELECT id, created_at, work_id, reaction, body, lang, place, sid FROM feedback WHERE ${where.join(' AND ')} AND created_at = ?`).bind(...args, next).all();
      const seen = new Set(items.map((/** @type {any} */ x) => x.id));
      for (const x of same.results || []) if (!seen.has(x.id)) items.push(x);
    }
    // どこから来たか。読めなくても感想は出す（from は null）
    let src = new Map();
    try { src = await sourcesOf(env.DB, [...new Set(items.map((/** @type {any} */ x) => x.sid).filter(Boolean))]); } catch (e) { console.error('感想の出どころを読めない', String(e)); }
    return adminJson(200, { db: true, items: items.map((/** @type {any} */ x) => ({ ...x, from: (x.sid && src.get(x.sid)) || null })), next });
  } catch (e) {
    console.error('感想を読めない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}
