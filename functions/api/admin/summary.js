// 数と流れ：GET /api/admin/summary?days=30。門番（_middleware.js）を通ったあとだけ来る
import { adminJson } from '../../_lib/admin-auth.js';
import { dbReady, purgeOld } from '../../_lib/events.js';
import { readCatalog } from '../../_lib/catalog.js';
import { parseDays, summarize } from '../../_lib/admin-data.js';

const MAX_ROWS = 50_000;

export async function onRequestGet({ request: req, env, waitUntil }) {
  const days = parseDays(new URL(req.url).searchParams.get('days'));
  const catalog = await readCatalog(req, env);
  const works = (catalog?.works || []).map((w) => ({ id: w.id, title: w.title?.ja || w.title?.en || w.id, image: w.image, url: w.url }));
  if (!await dbReady(env)) return adminJson(200, { db: false, days, works, ...summarize([], [], works) });
  const now = Date.now();
  const since = now - days * 86400_000;
  try {
    const [ev, fb] = await env.DB.batch([
      env.DB.prepare('SELECT sid, ev, work_id, detail, lang, at FROM events WHERE at >= ? ORDER BY at, id LIMIT ?').bind(since, MAX_ROWS),
      env.DB.prepare('SELECT work_id, reaction, COUNT(*) AS n FROM feedback WHERE created_at >= ? GROUP BY work_id, reaction').bind(since),
    ]);
    const rows = ev.results || [];
    if (typeof waitUntil === 'function') waitUntil(purgeOld(env.DB, now).catch((e) => console.error('古い出来事を消せない', String(e))));
    return adminJson(200, { db: true, days, truncated: rows.length >= MAX_ROWS, works, ...summarize(rows, fb.results || [], works) });
  } catch (e) {
    console.error('集計に失敗', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}
