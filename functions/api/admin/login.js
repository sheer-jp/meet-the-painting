// ID とパスワードを確かめて Cookie を渡す（docs/ADMIN.md 5 節）。パスワードは保存しない。ログにもエラーにも出さない
import { adminConfigured, adminJson, adminUsername, bodyTooLarge, checkCredentials, clearLoginFailures, loginBlocked, recordLoginFailure, sameOriginWrite, sessionCookie, signSession, LOGIN_WINDOW_MS } from '../../_lib/admin-auth.js';

const MAX_BODY = 2048;
const MAX_FIELD = 512;
const retryAfter = { 'Retry-After': String(LOGIN_WINDOW_MS / 1000) };

export async function onRequestPost({ request: req, env }) {
  if (!sameOriginWrite(req)) return adminJson(403, { error: 'csrf' });
  if (!adminConfigured(env)) return adminJson(503, { error: 'not_configured' });
  const ip = req.headers.get('CF-Connecting-IP');
  if (await loginBlocked(env, ip)) return adminJson(429, { error: 'rate_limited' }, retryAfter);
  if (bodyTooLarge(req, MAX_BODY)) return adminJson(400, { error: 'bad_request' });
  let username, password;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return adminJson(400, { error: 'bad_request' });
    ({ username, password } = JSON.parse(text) ?? {});
  } catch { return adminJson(400, { error: 'bad_request' }); }
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || username.length > MAX_FIELD || password.length > MAX_FIELD) return adminJson(400, { error: 'bad_request' });
  // ID 違いとパスワード違いは同じ応答（同じだけ PBKDF2 を回す）
  if (!await checkCredentials(env, username, password)) {
    await recordLoginFailure(env, ip);
    return adminJson(401, { error: 'invalid' });
  }
  await clearLoginFailures(env, ip);
  return adminJson(200, { ok: true }, { 'Set-Cookie': sessionCookie(await signSession(adminUsername(env), env.ADMIN_SESSION_SECRET)) });
}
