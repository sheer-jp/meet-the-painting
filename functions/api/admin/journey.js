// 1 つの会話の流れ：GET /api/admin/journey?sid=<匿名 id>。感想の「この人の流れ」から開く
import { adminJson } from '../../_lib/admin-auth.js';
import { dbReady } from '../../_lib/events.js';
import { readCatalog } from '../../_lib/catalog.js';
import { describeEvent } from '../../_lib/admin-data.js';

export async function onRequestGet({ request: req, env }) {
  const sid = new URL(req.url).searchParams.get('sid') || '';
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(sid)) return adminJson(400, { error: 'bad_request' });
  if (!await dbReady(env)) return adminJson(200, { items: [] });
  try {
    const catalog = await readCatalog(req, env);
    const title = (id) => catalog?.works?.find((w) => w.id === id)?.title?.ja || id;
    const r = await env.DB.prepare('SELECT ev, work_id, detail, at FROM events WHERE sid = ? ORDER BY at, id LIMIT 200').bind(sid).all();
    return adminJson(200, { items: (r.results || []).map((e) => ({ at: e.at, text: describeEvent(e, title) })) });
  } catch (e) {
    console.error('流れを読めない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}
