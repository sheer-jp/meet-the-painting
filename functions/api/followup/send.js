// 感想を保存する：「作家に届ける」を押したときだけ呼ばれる（docs/ADMIN.md 3 節）。IP・UA は保存しない。本文をログに出さない
// 保存できなければ失敗と返す（ブラウザは「届けられなかった」と言い、文を残す）
import { readCatalog } from '../../_lib/catalog.js';
import { validateSend } from '../../_lib/followup.js';
import { dbReady } from '../../_lib/events.js';
import { makeRateLimit, ipKey, bodyTooLarge } from '../../_lib/admin-auth.js';

const MAX_BODY = 4096;
const DAILY_CAP = 1000;   // 1 日の上限（荒らしで保存先を埋めないため）
const limited = makeRateLimit(5);
const limitedDay = makeRateLimit(20, 86400_000);   // 同じ回線から 1 日に送れる数。1 人で全体の上限を使い切れないように（isolate のメモリだけ。IP は保存せず、ハッシュも残さない）

const json = (status, obj, extra) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

export async function onRequestPost({ request: req, env }) {
  if (req.headers.get('Origin') !== new URL(req.url).origin) return json(403, { error: 'bad_request' });
  const ip = ipKey(req.headers.get('CF-Connecting-IP'));
  if (limited(ip)) return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  if (bodyTooLarge(req, MAX_BODY)) return json(400, { error: 'bad_request' });
  let fb;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json(400, { error: 'bad_request' });
    fb = validateSend(JSON.parse(text));
  } catch { return json(400, { error: 'bad_request' }); }
  if (!fb) return json(400, { error: 'bad_request' });
  const catalog = await readCatalog(req, env);
  if (catalog && !catalog.works?.some((w) => w.id === fb.work)) return json(400, { error: 'bad_request' });
  if (!await dbReady(env)) return json(503, { error: 'unavailable' });
  if (limitedDay(ip)) return json(429, { error: 'rate_limited' });
  try {
    const now = Date.now();
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE created_at > ?').bind(now - 86400_000).first();
    if ((count?.n ?? 0) >= DAILY_CAP) return json(429, { error: 'full' });
    // 同じ id の再送は 1 件のまま。前の応答が届かなかったあとで文を直して送り直したら、直した文を残す（id はブラウザが作る 128 ビットの乱数）
    await env.DB.prepare('INSERT INTO feedback (id, created_at, work_id, reaction, body, lang, place, sid) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body, reaction = excluded.reaction')
      .bind(fb.id, now, fb.work, fb.reaction, fb.text, fb.lang, fb.place, fb.sid).run();
    return json(200, { ok: true });
  } catch (e) {
    console.error('感想を保存できない', String(e));
    return json(503, { error: 'unavailable' });
  }
}
