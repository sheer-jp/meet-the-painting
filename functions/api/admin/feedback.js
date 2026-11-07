// 届いた感想：GET /api/admin/feedback?days=30&work=<id>&reaction=<r>&before=<ms>。新しい順に 50 件ずつ
import { adminJson } from '../../_lib/admin-auth.js';
import { dbReady, REACTIONS } from '../../_lib/events.js';
import { parseDays } from '../../_lib/admin-data.js';

const PAGE = 50;

export async function onRequestGet({ request: req, env }) {
  if (!await dbReady(env)) return adminJson(200, { db: false, items: [], next: null });
  const q = new URL(req.url).searchParams;
  const now = Date.now();
  // 感想は作家が消すまで残るので、いちばん長い期間（180 日）では全部出す
  const days = parseDays(q.get('days'));
  const where = ['created_at >= ?'];
  const args = [days >= 180 ? 0 : now - days * 86400_000];
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
      const seen = new Set(items.map((x) => x.id));
      for (const x of same.results || []) if (!seen.has(x.id)) items.push(x);
    }
    return adminJson(200, { db: true, items, next });
  } catch (e) {
    console.error('感想を読めない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}
