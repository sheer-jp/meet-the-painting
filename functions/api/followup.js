// 感想チャットの返事：Claude に 1 回聞いて JSON で返す（docs/ADMIN.md 3 節）。何も保存しない。本文をログに出さない
// 失敗しても 200 で reply: null を返す。ブラウザは定型文に落ちる
import { readCatalog } from '../_lib/catalog.js';
import { validateChat, followupBody, cleanReply } from '../_lib/followup.js';
import { makeRateLimit, ipKey, bodyTooLarge } from '../_lib/admin-auth.js';
import { dbReady, takeDaily } from '../_lib/events.js';
import { fetchUpstream, checkPassphrase } from './recommend.js';
import { FALLBACK_BETA, supportsFallbacks } from '../_lib/prompt.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_BODY = 2048;
const UPSTREAM_MS = 9000;
export const AI_DAILY_CAP = 500;       // Claude に聞く回数の 1 日の上限（全体）。超えたら定型文。費用の上限（1 回 1 円未満）
const limited = makeRateLimit(6);
const limitedDay = makeRateLimit(40, 86400_000);   // 同じ回線から 1 日に聞ける回数（isolate のメモリだけ。IP は保存しない）

const json = (status, obj, extra) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

export async function onRequestPost({ request: req, env }) {
  if (req.headers.get('Origin') !== new URL(req.url).origin) return json(403, { error: 'bad_request' });
  // 感想を保存できない環境ではカードを出さない（/api/followup/config）。直接呼ばれても Claude を動かさない
  if (!await dbReady(env)) return json(503, { error: 'unavailable' });
  const ip = ipKey(req.headers.get('CF-Connecting-IP'));
  if (limited(ip)) return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  if (bodyTooLarge(req, MAX_BODY)) return json(400, { error: 'bad_request' });
  let chat;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json(400, { error: 'bad_request' });
    chat = validateChat(JSON.parse(text));
  } catch { return json(400, { error: 'bad_request' }); }
  if (!chat) return json(400, { error: 'bad_request' });

  const catalog = await readCatalog(req, env);
  const work = catalog?.works?.find((w) => w.id === chat.work);
  if (catalog && !work) return json(400, { error: 'bad_request' });
  // 合言葉の実験中は、受付と同じ人だけが Claude を使える
  if (!work || !env.ANTHROPIC_API_KEY || !checkPassphrase(env.PASSPHRASE, req.headers.get('X-Passphrase'))) return json(200, { reply: null });

  // 検査を通った要求だけを数える。上限を超えたら定型文（ブラウザは 200 の reply: null で定型文に落ちる）
  if (limitedDay(ip) || !await takeDaily(env.DB, 'followup_ai', AI_DAILY_CAP)) return json(200, { reply: null });

  try {
    const model = env.CLAUDE_MODEL || 'claude-sonnet-5-5';
    const headers = { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
    if (supportsFallbacks(model)) headers['anthropic-beta'] = FALLBACK_BETA;
    const body = { ...followupBody(work, chat, model), ...(supportsFallbacks(model) ? { fallbacks: 'default' } : {}) };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_MS);
    const up = await fetchUpstream(() => fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal }));
    clearTimeout(timer);
    if (!up || !up.ok) return json(200, { reply: null });
    return json(200, { reply: cleanReply(await up.json()) });
  } catch (e) {
    console.error('感想の返事を作れない', String(e));
    return json(200, { reply: null });
  }
}
