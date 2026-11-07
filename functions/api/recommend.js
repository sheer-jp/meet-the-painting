// 気分から絵をすすめる：Claude API の中継（Cloudflare Pages Functions。docs/RECOMMEND.md 8.4、docs/ENTRANCE.md 5.2）
// サイト本体と同じ origin の /api/recommend。会話の文はどこにも保存しない。要求の本文や会話をログに出さない
// 保存するのは、案内役の問いがストックのどれだったかだけ（docs/ADMIN.md 2 節。文そのものは残さない）
import { buildBody, validateRequest, FALLBACK_BETA, supportsFallbacks } from '../_lib/prompt.js';
import { relayEvents, sse } from '../_lib/relay.js';
import { fetchStatuses, withoutSold } from '../_lib/works-status.js';
import { recordAsked } from '../_lib/events.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const CATALOG_TTL = 600_000;      // カタログを isolate の中に持つ時間（ミリ秒）
const RATE_LIMIT = 10;            // IP ごと 1 分あたりの回数
const RATE_WINDOW = 60_000;
const MAX_BODY = 16_000;          // 要求の本文の上限（バイト）
// 同じ origin のほかに許す origin（npm run dev の Vite から叩けるように）
const DEV_ORIGINS = ['http://localhost:5173', 'https://localhost:5173'];
const RETRY_DELAY = 800;          // 上流の一時的な失敗のあと、再試行までの待ち（ミリ秒）

// 合言葉（docs/ENTRANCE.md 3.1）。expected が空なら照合しない（true）。値はログに出さない
// 長さで早く抜けないよう、両方を最後まで比べる
export function checkPassphrase(expected, given) {
  const want = String(expected ?? '');
  if (!want) return true;
  const got = String(given ?? '');
  const n = Math.max(want.length, got.length);
  let diff = want.length ^ got.length;
  for (let i = 0; i < n; i++) diff |= (want.charCodeAt(i) || 0) ^ (got.charCodeAt(i) || 0);
  return diff === 0;
}

// 再試行してよい上流の状態（混雑・一時的な失敗）
export const retryableStatus = (status) => status === 429 || status === 529 || (status >= 500 && status <= 599);

// Claude API へ送る。例外か 429 / 5xx / 529 なら 800ms 待って 1 回だけ再試行する。最後の応答（または null）を返す
// ログは状態コードと再試行の有無だけ。本文は出さない
export async function fetchUpstream(doFetch, delay = RETRY_DELAY) {
  let res = null;
  try { res = await doFetch(); } catch (e) { console.error('Claude API に届かない。再試行する', String(e)); }
  if (res && res.ok) return res;
  if (res && !retryableStatus(res.status)) {
    // 4xx は要求の組み立ての問題なので、上流のエラー文（Anthropic の type と message。会話の本文は含まれない）をログに出して原因を追えるようにする
    if (!res.ok) { try { const err = await res.clone().json(); console.error('Claude API の状態', res.status, '（再試行しない）', err?.error?.type, String(err?.error?.message || '').slice(0, 300)); } catch { console.error('Claude API の状態', res.status, '（再試行しない）'); } }
    return res;
  }
  if (res) { console.error('Claude API の状態', res.status, '。再試行する'); try { await res.body?.cancel(); } catch { /* 読まずに捨てる */ } }
  await new Promise((r) => setTimeout(r, delay));
  try { res = await doFetch(); } catch (e) { console.error('Claude API に届かない（再試行後）', String(e)); return null; }
  if (!res.ok) console.error('Claude API の状態（再試行後）', res.status);
  return res;
}

// isolate の中だけのレート制限（厳密でなくてよい）
const hits = new Map();
function rateLimited(ip, now = Date.now()) {
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > RATE_WINDOW) hits.delete(k);
  const e = hits.get(ip);
  if (!e || now - e.start > RATE_WINDOW) { hits.set(ip, { start: now, count: 1 }); return false; }
  e.count++;
  return e.count > RATE_LIMIT;
}

// 許す origin：同じ origin、localhost:5173、ALLOWED_ORIGINS（任意。カンマ区切り）
function allowedOrigin(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return null;
  if (origin === new URL(req.url).origin) return origin;
  const extra = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...DEV_ORIGINS, ...extra].includes(origin) ? origin : null;
}

// 同じ origin なら CORS のヘッダは要らない。別の origin（dev サーバー）のときだけ付ける
function corsHeaders(req, origin) {
  if (!origin || origin === new URL(req.url).origin) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Passphrase',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (status, obj, cors) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });

// カタログ：同じ配信の /catalog.json。env.ASSETS（Pages の静的ファイル）から読み、isolate の中に 10 分持つ
let catalogMemo = null;   // { at, data }
async function loadCatalog(req, env) {
  const now = Date.now();
  if (catalogMemo && now - catalogMemo.at < CATALOG_TTL) return catalogMemo.data;
  const url = new URL('/catalog.json', req.url);
  // 自分の origin への fetch はループになりやすいので、使えるなら ASSETS を使う
  const res = env.ASSETS ? await env.ASSETS.fetch(new Request(url)) : await fetch(url);
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const data = await res.json();
  catalogMemo = { at: now, data };
  return data;
}

export async function onRequestOptions({ request, env }) {
  const origin = allowedOrigin(request, env);
  return new Response(null, { status: origin ? 204 : 403, headers: corsHeaders(request, origin) });
}

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  try { return await handle(request, env, ctx); } catch (e) {
    console.error('想定外の失敗', String(e));
    return json(502, { error: 'upstream' }, corsHeaders(request, allowedOrigin(request, env)));
  }
}

async function handle(req, env, ctx) {
  const origin = allowedOrigin(req, env);
  const cors = corsHeaders(req, origin);
  if (!origin) return json(403, { error: 'bad_request' }, cors);

  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) return json(429, { error: 'rate_limited' }, { ...cors, 'Retry-After': '60' });
  // 合言葉は回数制限のあとで比べる（総当たりも回数制限に掛かるように）
  if (!checkPassphrase(env.PASSPHRASE, req.headers.get('X-Passphrase'))) return json(403, { error: 'passphrase' }, cors);

  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json(400, { error: 'bad_request' }, cors);
    body = JSON.parse(text);
  } catch { return json(400, { error: 'bad_request' }, cors); }
  // 往復の上限はカタログを読む前に既定値で一度確かめ、読んだあとカタログの値で確かめる
  if (validateRequest(body, [2, 10])) return json(400, { error: 'bad_request' }, cors);

  let catalog;
  try { catalog = await loadCatalog(req, env); } catch (e) {
    console.error('catalog の取得に失敗', String(e));
    return json(502, { error: 'upstream' }, cors);
  }
  // 売れた絵はすすめない。販売状況を取れないときは全作品のまま（会話を止めない）
  try { catalog = withoutSold(catalog, await fetchStatuses(3000)); } catch (e) { console.error('販売状況を取れない', String(e)); }
  const turns = Array.isArray(catalog.turns) && catalog.turns.length === 2 ? catalog.turns : [2, 4];
  // 上限は 1 回だけ超えてよい（受付の「別のにする」で AI に「別の絵を」の 1 往復を足すため。docs/ENTRANCE.md 3.1）
  if (validateRequest(body, [turns[0], turns[1] + 1])) return json(400, { error: 'bad_request' }, cors);

  if (!env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY が無い');
    return json(502, { error: 'upstream' }, cors);
  }
  const model = env.CLAUDE_MODEL || 'claude-sonnet-5-5';
  const headers = { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
  if (supportsFallbacks(model)) headers['anthropic-beta'] = FALLBACK_BETA;
  const upBody = JSON.stringify(buildBody(catalog, body.lang, body.messages, model, body.seed || undefined));
  const up = await fetchUpstream(() => fetch(API_URL, { method: 'POST', headers, body: upBody }));
  if (!up || !up.ok || !up.body) {   // 状態コードは fetchUpstream がログに出す（本文は出さない）
    return json(502, { error: 'upstream' }, cors);
  }

  // 最初の出来事を待つ：文が来る前の拒否は 422、失敗は 502
  const events = relayEvents(up.body, { lang: body.lang });
  const first = await events.next().catch(() => ({ value: { error: true }, done: false }));
  if (first.done) return json(502, { error: 'upstream' }, cors);
  if ('refusal' in first.value) { events.return(undefined); return json(422, { error: 'refusal' }, cors); }
  if ('error' in first.value) { events.return(undefined); return json(502, { error: 'upstream' }, cors); }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode(sse(obj)));
      let ended = false;
      let said = '';   // 問いの照合だけに使う（保存しない）
      const handleEv = (ev) => {
        if ('text' in ev) { said += ev.text; send({ text: ev.text }); }
        else if ('recommend' in ev) send({ recommend: ev.recommend });
        else if ('refusal' in ev) send({ error: 'refusal' });
        else if ('error' in ev) { send({ error: 'upstream' }); send({ done: true }); ended = true; }
        else if ('done' in ev) { send({ done: true }); ended = true; }
      };
      try {
        handleEv(first.value);
        while (!ended) {
          const r = await events.next();
          if (r.done) break;
          handleEv(r.value);
        }
        if (!ended) { send({ error: 'upstream' }); send({ done: true }); }
      } catch (e) {
        console.error('中継が途中で切れた', String(e));
        try { send({ error: 'upstream' }); send({ done: true }); } catch { /* 閉じたあと */ }
      } finally {
        try { await events.return(undefined); } catch { /* すでに閉じた */ }
        try { controller.close(); } catch { /* 相手が先に切った */ }
        // どの問いが使われたかを記録（失敗しても、なくても、会話には関係ない）
        try {
          const job = recordAsked(env, { sid: body.sid, lang: body.lang, seed: body.seed || undefined, catalog, text: said }).catch((e) => console.error('問いを記録できない', String(e)));
          if (typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
        } catch { /* 同上 */ }
      }
    },
    // ブラウザが切った（見切り、ページ移動、「もう一度」）ら上流も止める。読み続けると出力トークンが無駄になる
    cancel() {
      try { events.return(undefined); } catch { /* すでに閉じた */ }
      try { up.body.cancel(); } catch { /* すでに閉じた */ }
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', ...cors } });
}
