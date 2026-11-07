// 計測の見る口（E-14）：GET /api/stats?key=<STATS_KEY>。作家だけが見る。累計と直近 30 日（日本時間）の数を返す
// STATS_KEY（Pages の Secret）が無い・一致しないときは 404。数のほかには何も持っていない
import { checkStatsKey, summarize, jstDate } from '../_lib/stats.js';
import { ipKey } from '../_lib/admin-auth.js';

const RATE_LIMIT = 30;
const RATE_WINDOW = 60_000;
const DAYS = 30;

const hits = new Map();
function rateLimited(ip, now = Date.now()) {
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > RATE_WINDOW) hits.delete(k);
  const e = hits.get(ip);
  if (!e || now - e.start > RATE_WINDOW) { hits.set(ip, { start: now, count: 1 }); return false; }
  e.count++;
  return e.count > RATE_LIMIT;
}

const notFound = () => new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

// prefix の鍵を全部（1000 件ごとに cursor で続ける）
async function listAll(kv, prefix) {
  const out = [];
  let cursor;
  for (let i = 0; i < 100; i++) {
    const r = await kv.list({ prefix, cursor });
    out.push(...r.keys);
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return out;
}

export async function onRequestGet({ request, env }) {
  const ip = ipKey(request.headers.get('CF-Connecting-IP'));
  if (rateLimited(ip)) return notFound();
  const given = new URL(request.url).searchParams.get('key');
  if (!checkStatsKey(env.STATS_KEY, given) || !env.STATS) return notFound();
  const now = Date.now();
  const since = jstDate(now - (DAYS - 1) * 86400_000);
  const [t, d] = await Promise.all([listAll(env.STATS, 't:'), listAll(env.STATS, 'd:')]);
  const { total, days } = summarize([...t, ...d], since);
  return new Response(JSON.stringify({ today: jstDate(now), since, total, days }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}
