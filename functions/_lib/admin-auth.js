// 管理ページの認証（docs/ADMIN.md 5 節）。純関数と WebCrypto だけ。Pages Functions のグローバルに触れない（vitest から偽の JWKS でテストする）

export const COOKIE_NAME = '__Host-mtp_admin';
export const SESSION_MS = 24 * 3600_000;
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const MAX_TOKEN = 8192;
const MIN_SECRET = 32;
const enc = new TextEncoder();

/** @param {ArrayBuffer|Uint8Array} buf */
function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(/** @type {any} */ (buf))) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** @param {string} s */
function unb64url(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const jsonOf = (/** @type {string} */ s) => JSON.parse(new TextDecoder().decode(unb64url(s)));

// 許可リスト：カンマ区切り。前後の空白と大文字小文字は見ない
/** @param {string|undefined} list */
export function parseAllowlist(list) {
  return new Set(String(list ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}
/** @param {any} env @param {string} email */
export function isAllowed(env, email) {
  return typeof email === 'string' && !!email && parseAllowlist(env?.ADMIN_EMAILS).has(email.trim().toLowerCase());
}

// 設定がそろっているか。欠けていれば閉じる（fail closed）
/** @param {any} env */
export function adminConfigured(env) {
  return !!env?.GOOGLE_CLIENT_ID && parseAllowlist(env?.ADMIN_EMAILS).size > 0 && String(env?.ADMIN_SESSION_SECRET ?? '').length >= MIN_SECRET;
}

// ───── Google の ID トークン ─────
// JWKS：isolate の中に持つ（max-age まで、最大 6 時間）。知らない kid は 60 秒に 1 回だけ取り直す（鍵の入れ替えに追いつくため）
/** @type {{ at: number, ttl: number, keys: any[] } | null} */
let jwksMemo = null;
export async function fetchGoogleKeys(force = false, now = Date.now(), doFetch = fetch) {
  if (jwksMemo && now - jwksMemo.at < (force ? 60_000 : jwksMemo.ttl)) return jwksMemo.keys;
  const res = await doFetch(JWKS_URL);
  if (!res.ok) { console.error('Google の公開鍵を取得できない', res.status); throw new Error(`jwks ${res.status}`); }
  const data = await res.json();
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  jwksMemo = { at: now, ttl: Math.min(m ? Number(m[1]) * 1000 : 3600_000, 6 * 3600_000), keys: Array.isArray(data?.keys) ? data.keys : [] };
  return jwksMemo.keys;
}

/**
 * ID トークンを検証して { email } を返す。だめなら null（理由は外に出さない）
 * @param {string} token
 * @param {{ clientId: string, getKeys?: (force: boolean) => Promise<any[]>, now?: number }} o
 */
export async function verifyGoogleIdToken(token, o) {
  const { clientId, getKeys = fetchGoogleKeys, now = Date.now() } = o;
  if (!clientId || typeof token !== 'string' || token.length > MAX_TOKEN) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = jsonOf(parts[0]);
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null;   // none や HS256 への差し替えを通さない
    let jwk = (await getKeys(false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await getKeys(true)).find((k) => k.kid === header.kid);
    if (!jwk || jwk.kty !== 'RSA') return null;
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const p = jsonOf(parts[1]);
    if (!ISSUERS.includes(p?.iss)) return null;
    if (p.aud !== clientId) return null;
    if (typeof p.exp !== 'number' || p.exp * 1000 <= now) return null;
    if (typeof p.nbf === 'number' && p.nbf * 1000 > now + 60_000) return null;
    if (p.email_verified !== true) return null;
    if (typeof p.email !== 'string' || !p.email) return null;
    return { email: p.email };
  } catch { return null; }
}

// ───── セッションの Cookie：<payload>.<HMAC> ─────
/** @param {string} secret */
const hmacKey = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

/** @param {string} email @param {string} secret @param {number} [now] */
export async function signSession(email, secret, now = Date.now()) {
  const payload = b64url(enc.encode(JSON.stringify({ e: email, x: now + SESSION_MS, n: b64url(crypto.getRandomValues(new Uint8Array(9))) })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** 署名と期限を確かめて email を返す。だめなら null @param {string|null|undefined} value @param {string} secret @param {number} [now] */
export async function verifySession(value, secret, now = Date.now()) {
  if (!value || !secret || String(secret).length < MIN_SECRET || value.length > 1024) return null;
  const i = value.lastIndexOf('.');
  if (i <= 0) return null;
  try {
    const payload = value.slice(0, i);
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(value.slice(i + 1)), enc.encode(payload));
    if (!ok) return null;
    const p = jsonOf(payload);
    if (typeof p?.x !== 'number' || p.x <= now || typeof p.e !== 'string' || !p.e) return null;
    return p.e;
  } catch { return null; }
}

/** @param {string} value */
export const sessionCookie = (value) => `${COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
export const clearCookie = () => `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/** @param {Request} req */
export function readCookie(req) {
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim();
  }
  return null;
}

// 書き込みの CSRF：SameSite=Strict に加えて、Origin が同じで、Sec-Fetch-Site があるなら same-origin
/** @param {Request} req */
export function sameOriginWrite(req) {
  if (req.headers.get('Origin') !== new URL(req.url).origin) return false;
  const site = req.headers.get('Sec-Fetch-Site');
  return !site || site === 'same-origin';
}

// Cookie から管理者を決める。署名、期限、許可リストを毎回見る
/** @param {Request} req @param {any} env */
export async function currentAdmin(req, env) {
  if (!adminConfigured(env)) return null;
  const email = await verifySession(readCookie(req), env.ADMIN_SESSION_SECRET);
  return email && isAllowed(env, email) ? { email } : null;
}

// 管理の API の応答に必ず付けるヘッダ
export const ADMIN_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };
/** @param {number} status @param {any} obj @param {Record<string,string>} [extra] */
export const adminJson = (status, obj, extra) => new Response(JSON.stringify(obj), { status, headers: { ...ADMIN_HEADERS, ...extra } });

/** isolate の中の回数制限（厳密でなくてよい。既存の API と同じ仕組み） @param {number} limit @param {number} [windowMs] */
export function makeRateLimit(limit, windowMs = 60_000) {
  const hits = new Map();
  return (/** @type {string} */ key, now = Date.now()) => {
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    const e = hits.get(key);
    if (!e || now - e.start > windowMs) { hits.set(key, { start: now, count: 1 }); return false; }
    e.count++;
    return e.count > limit;
  };
}

// 回数制限の鍵。IP は保存しない（isolate のメモリにだけ）。IPv6 は 1 回線に /64 が割り当たるので、前半の 64 ビットで数える
/** @param {string|null|undefined} ip */
export function ipKey(ip) {
  const s = String(ip ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (!s.includes(':')) return s;
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
// 本文を読む前に Content-Length で大きすぎる要求を断る（無い・嘘のときのために、読んだあとの長さの検査も残す）
/** @param {Request} req @param {number} max */
export function bodyTooLarge(req, max) {
  const n = Number(req.headers.get('Content-Length'));
  return Number.isFinite(n) && n > max;
}
