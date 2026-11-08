// 数と流れ：GET /api/admin/summary?range=today|7|30|all（以前の ?days= も読み替える）。門番（_middleware.js）を通ったあとだけ来る
import { adminJson } from '../../_lib/admin-auth.js';
import { dbReady, purgeOld } from '../../_lib/events.js';
import { readCatalog } from '../../_lib/catalog.js';
import { funnelOf, parseRange, rangeBounds, summarize, timeline } from '../../_lib/admin-data.js';

const MAX_ROWS = 50_000;
const EV_COLS = 'SELECT sid, ev, work_id, detail, lang, at FROM events';

export async function onRequestGet({ request: req, env, waitUntil }) {
  const q = new URL(req.url).searchParams;
  const range = parseRange(q.get('range'), q.get('days'));
  const now = Date.now();
  const b = rangeBounds(range, now);
  const catalog = await readCatalog(req, env);
  // 小さな絵は 480px の版（作品ページの生成物にある）。無ければ元の画像
  const works = (catalog?.works || []).map((w) => ({ id: w.id, title: w.title?.ja || w.title?.en || w.id, image: w.image, thumb: typeof w.image === 'string' ? w.image.replace(/painting_1024\.jpg$/, 'painting_480.jpg') : null, url: w.url }));
  const base = { range, bounds: b, catalog: works };
  if (!await dbReady(env)) return adminJson(200, { db: false, ...base, ...summarize([], [], works), ...timeline([], [], b), funnel: funnelOf([]), prev: null });
  // 感想は作家が消すまで残るので、全期間では全部
  const fbSince = range === 'all' ? 0 : b.since;
  try {
    const stmts = [
      env.DB.prepare(`${EV_COLS} WHERE at >= ? ORDER BY at, id LIMIT ?`).bind(b.since, MAX_ROWS),
      env.DB.prepare('SELECT work_id, reaction, COUNT(*) AS n FROM feedback WHERE created_at >= ? GROUP BY work_id, reaction').bind(fbSince),
      env.DB.prepare('SELECT created_at FROM feedback WHERE created_at >= ?').bind(b.since),
    ];
    // 前の同じ長さの期間（タイルの差）。行は別に読む（1 つの問い合わせで 2 倍に広げると、上限で新しい行から欠けるため）
    if (b.prevSince != null) {
      stmts.push(
        env.DB.prepare(`${EV_COLS} WHERE at >= ? AND at < ? ORDER BY at, id LIMIT ?`).bind(b.prevSince, b.prevUntil, MAX_ROWS),
        env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE created_at >= ? AND created_at < ?').bind(b.prevSince, b.prevUntil),
      );
    }
    const [ev, fb, fbAt, pev, pfb] = await env.DB.batch(stmts);
    const rows = ev.results || [];
    if (typeof waitUntil === 'function') waitUntil(purgeOld(env.DB, now).catch((e) => console.error('古い出来事を消せない', String(e))));
    const prev = pev ? { ...summarize(pev.results || []).totals, feedback: Number(pfb?.results?.[0]?.n ?? 0) } : null;
    return adminJson(200, {
      db: true, ...base,
      truncated: rows.length >= MAX_ROWS || (pev?.results?.length ?? 0) >= MAX_ROWS,
      ...summarize(rows, fb.results || [], works),
      ...timeline(rows, (fbAt.results || []).map((/** @type {any} */ r) => Number(r.created_at)), b),
      funnel: funnelOf(rows),
      prev,
    });
  } catch (e) {
    console.error('集計に失敗', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}
