// Google の ID トークンを受け取り、検証して Cookie を渡す（docs/ADMIN.md 5 節）。トークンは保存しない。ログにも出さない
import { adminConfigured, adminJson, bodyTooLarge, ipKey, isAllowed, makeRateLimit, sameOriginWrite, sessionCookie, signSession, verifyGoogleIdToken } from '../../_lib/admin-auth.js';

const limited = makeRateLimit(10);

export async function onRequestPost({ request: req, env }) {
  if (!adminConfigured(env)) return adminJson(503, { error: 'not_configured' });
  if (!sameOriginWrite(req)) return adminJson(403, { error: 'csrf' });
  if (limited(ipKey(req.headers.get('CF-Connecting-IP')))) return adminJson(429, { error: 'rate_limited' });
  if (bodyTooLarge(req, 10_000)) return adminJson(400, { error: 'bad_request' });
  let credential;
  try {
    const text = await req.text();
    if (text.length > 10_000) return adminJson(400, { error: 'bad_request' });
    credential = JSON.parse(text)?.credential;
  } catch { return adminJson(400, { error: 'bad_request' }); }
  const who = await verifyGoogleIdToken(credential, { clientId: env.GOOGLE_CLIENT_ID });
  if (!who) return adminJson(401, { error: 'invalid_token' });
  if (!isAllowed(env, who.email)) return adminJson(403, { error: 'not_allowed' });
  return adminJson(200, { email: who.email }, { 'Set-Cookie': sessionCookie(await signSession(who.email, env.ADMIN_SESSION_SECRET)) });
}
