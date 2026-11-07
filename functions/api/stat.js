// 計測の数える口（E-14）：POST /api/stat、本文 { ev, id, via, sid, lang }。KV（STATS）の数を +1 する
// 匿名 id（sid）があれば、構造化した出来事を D1 にも書く（docs/ADMIN.md 2 節）。KV の数と D1 の出来事は別々に失敗してよい
// IP・UA・会話の文は保存しない（IP は isolate の中の回数制限にだけ使い、KV にも D1 にも書かない）。Cookie も使わない
import { normalizeEvent, statKeys, jstDate, DAY_TTL } from '../_lib/stats.js';
import { normalizeJourney, insertEvent, maybePurge } from '../_lib/events.js';
import { readCatalog } from '../_lib/catalog.js';

const RATE_LIMIT = 60;            // IP ごと 1 分あたりの回数
const RATE_WINDOW = 60_000;
const MAX_BODY = 512;             // 本文の上限（バイト）
const CATALOG_TTL = 600_000;
const DEV_ORIGINS = ['http://localhost:5173', 'https://localhost:5173'];

// isolate の中だけのレート制限（recommend.js と同じ仕組み。厳密でなくてよい）
const hits = new Map();
function rateLimited(ip, now = Date.now()) {
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > RATE_WINDOW) hits.delete(k);
  const e = hits.get(ip);
  if (!e || now - e.start > RATE_WINDOW) { hits.set(ip, { start: now, count: 1 }); return false; }
  e.count++;
  return e.count > RATE_LIMIT;
}

// 許す origin：同じ origin と localhost:5173 だけ
function allowedOrigin(req) {
  const origin = req.headers.get('Origin');
  if (!origin) return null;
  if (origin === new URL(req.url).origin) return origin;
  return DEV_ORIGINS.includes(origin) ? origin : null;
}

function corsHeaders(req, origin) {
  if (!origin || origin === new URL(req.url).origin) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const empty = (status, headers) => new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

// 作品 id がカタログにあるか（勝手な id で KV の鍵を増やさない）。カタログが読めなければ形の検査だけで通す
let catalogMemo = null;   // { at, ids }
async function knownIds(req, env) {
  const now = Date.now();
  if (catalogMemo && now - catalogMemo.at < CATALOG_TTL) return catalogMemo.ids;
  try {
    const url = new URL('/catalog.json', req.url);
    const res = env.ASSETS ? await env.ASSETS.fetch(new Request(url)) : await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const ids = new Set((data?.works || []).map((w) => w.id));
    catalogMemo = { at: now, ids };
    return ids;
  } catch { return null; }
}

// get → put で +1（厳密でなくてよい）。数は値と metadata の両方に入れる（見る口は list の metadata だけで読める）
async function bump(kv, key, ttl) {
  const n = (parseInt(await kv.get(key), 10) || 0) + 1;
  await kv.put(key, String(n), ttl ? { expirationTtl: ttl, metadata: { n } } : { metadata: { n } });
}

export async function onRequestOptions({ request }) {
  const origin = allowedOrigin(request);
  return empty(origin ? 204 : 403, corsHeaders(request, origin));
}

export async function onRequestPost(ctx) {
  const { request: req, env } = ctx;
  const origin = allowedOrigin(req);
  const cors = corsHeaders(req, origin);
  if (!origin) return empty(403, cors);
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) return empty(429, { ...cors, 'Retry-After': '60' });

  let body;
  try {
    const text = await req.text();   // sendBeacon は text/plain で来るので Content-Type は見ない
    if (text.length > MAX_BODY) return empty(400, cors);
    body = JSON.parse(text);
  } catch { return empty(400, cors); }
  const ev = normalizeEvent(body);
  // 出来事の検査はカタログを読むので waitUntil の中で。ここでは名前だけ見る（知らない名前は 400）
  const journeyName = typeof body?.ev === 'string' && typeof body?.sid === 'string';
  if (!ev && !journeyName) return empty(400, cors);

  const counted = (async () => {
    if (!ev || !env.STATS) return;   // KV が無い環境では数えない
    if (ev.id) {
      const ids = await knownIds(req, env);
      if (ids && !ids.has(ev.id)) return;
    }
    const [dKey, tKey] = statKeys(ev, jstDate());
    // KV は同じ鍵に 1 秒 1 回までなので、重なると失敗することがある。数え漏れは許す
    await Promise.allSettled([bump(env.STATS, dKey, DAY_TTL), bump(env.STATS, tKey, 0)]);
  })().catch(() => {});
  const logged = (async () => {
    if (!env.DB || !journeyName) return;
    const j = normalizeJourney(body, await readCatalog(req, env));
    if (!j) return;
    await insertEvent(env.DB, j);
    await maybePurge(env.DB);
  })().catch((e) => console.error('出来事を保存できない', String(e)));
  const work = Promise.all([counted, logged]);
  if (typeof ctx.waitUntil === 'function') ctx.waitUntil(work); else await work;
  return empty(204, cors);
}
