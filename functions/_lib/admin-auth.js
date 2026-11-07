// 管理ページの認証（docs/ADMIN.md 5 節）。ID とパスワード。純関数と WebCrypto だけ。Pages Functions のグローバルに触れない（scripts/admin-password.mjs からも使う）

export const COOKIE_NAME = '__Host-mtp_admin';
export const SESSION_MS = 24 * 3600_000;
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

// ───── パスワード（PBKDF2-SHA256）。形式は pbkdf2$<回数>$<salt>$<hash>（salt と hash は base64url） ─────
export const PBKDF2_ITERATIONS = 100_000;   // Cloudflare Workers の WebCrypto の上限
const PBKDF2_MIN = 10_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
export const MIN_PASSWORD = 12;

const derive = async (/** @type {string} */ password, /** @type {Uint8Array} */ salt, /** @type {number} */ iterations) => {
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BYTES * 8));
};

/** @param {string} password @param {{ iterations?: number, salt?: Uint8Array }} [o] */
export async function hashPassword(password, o = {}) {
  const iterations = o.iterations ?? PBKDF2_ITERATIONS;
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return `pbkdf2$${iterations}$${b64url(salt)}$${b64url(await derive(password, salt, iterations))}`;
}

// 形が正しければ中身を返す。だめなら null（設定が壊れているものとして閉じる）
/** @param {unknown} stored */
export function parsePasswordHash(stored) {
  const m = /^pbkdf2\$(\d{1,7})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(String(stored ?? '').trim());
  if (!m) return null;
  const iterations = Number(m[1]);
  if (iterations < PBKDF2_MIN || iterations > PBKDF2_ITERATIONS) return null;
  try {
    const salt = unb64url(m[2]), hash = unb64url(m[3]);
    if (salt.length < SALT_BYTES || hash.length !== HASH_BYTES) return null;
    return { iterations, salt, hash };
  } catch { return null; }
}

// 定数時間の比較（長さで早く抜けない）
/** @param {Uint8Array} a @param {Uint8Array} b */
function sameBytes(a, b) {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
// 文字列は SHA-256 にしてから比べる（長さを漏らさない）
/** @param {string} a @param {string} b */
async function sameText(a, b) {
  const [x, y] = await Promise.all([a, b].map((t) => crypto.subtle.digest('SHA-256', enc.encode(t))));
  return sameBytes(new Uint8Array(x), new Uint8Array(y));
}

/** @param {string} password @param {string} stored */
export async function verifyPassword(password, stored) {
  const p = parsePasswordHash(stored);
  if (!p) return false;
  return sameBytes(await derive(password, p.salt, p.iterations), p.hash);
}

// 設定の ID（Secret に入れるときに付いた改行を許す）
/** @param {any} env */
export const adminUsername = (env) => String(env?.ADMIN_USERNAME ?? '').trim();

// ID とパスワードの確かめ。ID が違っても同じだけ PBKDF2 を回し、応答も時間も区別しない
/** @param {any} env @param {string} username @param {string} password */
export async function checkCredentials(env, username, password) {
  const [idOk, pwOk] = await Promise.all([sameText(username, adminUsername(env)), verifyPassword(password, env?.ADMIN_PASSWORD_HASH)]);
  return idOk && pwOk;
}

// 設定がそろっているか。欠けていれば閉じる（fail closed）
/** @param {any} env */
export function adminConfigured(env) {
  return !!adminUsername(env) && !!parsePasswordHash(env?.ADMIN_PASSWORD_HASH) && String(env?.ADMIN_SESSION_SECRET ?? '').length >= MIN_SECRET;
}

// ───── セッションの Cookie：<payload>.<HMAC> ─────
/** @param {string} secret */
const hmacKey = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

/** @param {string} name @param {string} secret @param {number} [now] */
export async function signSession(name, secret, now = Date.now()) {
  const payload = b64url(enc.encode(JSON.stringify({ e: name, x: now + SESSION_MS, n: b64url(crypto.getRandomValues(new Uint8Array(9))) })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** 署名と期限を確かめて ID を返す。だめなら null @param {string|null|undefined} value @param {string} secret @param {number} [now] */
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

// Cookie から管理者を決める。署名、期限、いまの ID と同じかを毎回見る（ID を変えれば古い Cookie は切れる）
/** @param {Request} req @param {any} env */
export async function currentAdmin(req, env) {
  if (!adminConfigured(env)) return null;
  const name = await verifySession(readCookie(req), env.ADMIN_SESSION_SECRET);
  return name && await sameText(name, adminUsername(env)) ? { name } : null;
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

// ───── ログインの失敗の回数（総当たり対策）。IP の /64 ごとに 15 分で 10 回まで ─────
// isolate のメモリ（IP の鍵）と、D1（無ければ KV）の短命の数（日替わりの salt でハッシュした鍵）の両方で数える。生の IP は保存しない
export const LOGIN_MAX_FAILS = 10;
export const LOGIN_WINDOW_MS = 15 * 60_000;
const memFails = new Map();
const memCount = (/** @type {string} */ key, /** @type {number} */ now) => { const e = memFails.get(key); return e && now - e.start < LOGIN_WINDOW_MS ? e.n : 0; };
function memAdd(/** @type {string} */ key, /** @type {number} */ now) {
  if (memFails.size > 5000) for (const [k, v] of memFails) if (now - v.start >= LOGIN_WINDOW_MS) memFails.delete(k);
  const e = memFails.get(key);
  if (!e || now - e.start >= LOGIN_WINDOW_MS) memFails.set(key, { start: now, n: 1 }); else e.n++;
}
export function resetLoginMemory() { memFails.clear(); }

// 日替わりの鍵：HMAC(秘密, 日付 + IP の /64)。秘密と日付が無ければ元の IP に戻せない
/** @param {any} env @param {string} ip @param {number} now */
async function failKey(env, ip, now) {
  const day = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(`login-fail:${env.ADMIN_SESSION_SECRET}`), enc.encode(`${day}|${ip}`));
  return b64url(sig).slice(0, 32);
}
/** 保存先の数を読む。読めなければ null（メモリの数だけで守る）@param {any} env @param {string} key @param {number} now */
async function storedFails(env, key, now) {
  try {
    if (env.DB) { const r = await env.DB.prepare('SELECT n FROM login_failures WHERE key = ? AND first_at > ?').bind(key, now - LOGIN_WINDOW_MS).first(); return r?.n ?? 0; }
    if (env.STATS) return parseInt(await env.STATS.get(`lf:${key}`), 10) || 0;
  } catch { console.error('ログインの失敗の数を読めない'); }
  return null;
}
/** ブロック中か @param {any} env @param {string|null} ip @param {number} [now] */
export async function loginBlocked(env, ip, now = Date.now()) {
  const raw = ipKey(ip);
  if (memCount(raw, now) >= LOGIN_MAX_FAILS) return true;
  return ((await storedFails(env, await failKey(env, raw, now), now)) ?? 0) >= LOGIN_MAX_FAILS;
}
/** 失敗を 1 回数える。期限の切れた行はこのときに消す @param {any} env @param {string|null} ip @param {number} [now] */
export async function recordLoginFailure(env, ip, now = Date.now()) {
  const raw = ipKey(ip);
  memAdd(raw, now);
  const key = await failKey(env, raw, now);
  try {
    if (env.DB) {
      const old = now - LOGIN_WINDOW_MS;
      await env.DB.prepare('DELETE FROM login_failures WHERE first_at <= ?').bind(old).run();
      await env.DB.prepare('INSERT INTO login_failures (key, first_at, n) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET n = n + 1').bind(key, now).run();
    } else if (env.STATS) {
      const n = (parseInt(await env.STATS.get(`lf:${key}`), 10) || 0) + 1;
      await env.STATS.put(`lf:${key}`, String(n), { expirationTtl: LOGIN_WINDOW_MS / 1000 });
    }
  } catch { console.error('ログインの失敗の数を書けない'); }
}
/** 成功したら数を消す @param {any} env @param {string|null} ip @param {number} [now] */
export async function clearLoginFailures(env, ip, now = Date.now()) {
  const raw = ipKey(ip);
  memFails.delete(raw);
  const key = await failKey(env, raw, now);
  try {
    if (env.DB) await env.DB.prepare('DELETE FROM login_failures WHERE key = ?').bind(key).run();
    else if (env.STATS) await env.STATS.delete(`lf:${key}`);
  } catch { console.error('ログインの失敗の数を消せない'); }
}
