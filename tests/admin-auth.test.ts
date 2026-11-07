import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { verifyGoogleIdToken, signSession, verifySession, adminConfigured, isAllowed, sameOriginWrite, currentAdmin, COOKIE_NAME, sessionCookie, SESSION_MS } from '../functions/_lib/admin-auth.js';
import { onRequest as guard } from '../functions/api/admin/_middleware.js';
import { onRequestPost as login } from '../functions/api/admin/login.js';
import { onRequestGet as config } from '../functions/api/admin/config.js';

// 偽の JWKS：RSA の鍵を作り、自分で ID トークンに署名する
const CLIENT = 'test-client.apps.googleusercontent.com';
const NOW = 1_800_000_000_000;
const SECRET = 'x'.repeat(40);
const b64 = (v: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v as ArrayBuffer);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
let pair: CryptoKeyPair; let other: CryptoKeyPair; let jwk: JsonWebKey;
const getKeys = async () => [{ ...jwk, kid: 'k1' }];
const genPair = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
beforeAll(async () => { pair = await genPair(); other = await genPair(); jwk = await crypto.subtle.exportKey('jwk', pair.publicKey); });

async function token(claims: Record<string, unknown> = {}, { key = pair.privateKey, header = { alg: 'RS256', kid: 'k1' } as Record<string, unknown> } = {}) {
  const payload = { iss: 'https://accounts.google.com', aud: CLIENT, exp: NOW / 1000 + 600, email: 'owner@example.com', email_verified: true, ...claims };
  const head = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head));
  return `${head}.${b64(sig)}`;
}
const verify = (t: string) => verifyGoogleIdToken(t, { clientId: CLIENT, getKeys, now: NOW });

describe('Google の ID トークンの検証', () => {
  it('正しいトークンは通り、メールアドレスを返す', async () => {
    expect(await verify(await token())).toEqual({ email: 'owner@example.com' });
    expect(await verify(await token({ iss: 'accounts.google.com' }))).toEqual({ email: 'owner@example.com' });
  });
  it('別の鍵の署名は拒否', async () => { expect(await verify(await token({}, { key: other.privateKey }))).toBeNull(); });
  it('本文を書き換えたら拒否', async () => {
    const [h, , s] = (await token()).split('.');
    const forged = b64(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, exp: NOW / 1000 + 600, email: 'attacker@example.com', email_verified: true }));
    expect(await verify(`${h}.${forged}.${s}`)).toBeNull();
  });
  it('alg の差し替え（none、HS256）は拒否', async () => {
    const payload = b64(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, exp: NOW / 1000 + 600, email: 'owner@example.com', email_verified: true }));
    expect(await verify(`${b64(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${payload}.`)).toBeNull();
    expect(await verify(`${b64(JSON.stringify({ alg: 'HS256', kid: 'k1' }))}.${payload}.AAAA`)).toBeNull();
  });
  it('知らない kid は拒否', async () => { expect(await verify(await token({}, { header: { alg: 'RS256', kid: 'zz' } }))).toBeNull(); });
  it('aud 違いは拒否', async () => { expect(await verify(await token({ aud: 'other.apps.googleusercontent.com' }))).toBeNull(); });
  it('iss 違いは拒否', async () => { expect(await verify(await token({ iss: 'https://evil.example.com' }))).toBeNull(); });
  it('期限切れは拒否', async () => { expect(await verify(await token({ exp: NOW / 1000 - 1 }))).toBeNull(); });
  it('exp が無ければ拒否', async () => { expect(await verify(await token({ exp: undefined }))).toBeNull(); });
  it('未検証のメールは拒否（文字列の "true" も）', async () => {
    expect(await verify(await token({ email_verified: false }))).toBeNull();
    expect(await verify(await token({ email_verified: 'true' }))).toBeNull();
  });
  it('壊れたトークンは例外にならず拒否', async () => {
    for (const t of ['', 'a', 'a.b', 'a.b.c', '...', '!!.!!.!!']) expect(await verify(t)).toBeNull();
    expect(await verifyGoogleIdToken(undefined as unknown as string, { clientId: CLIENT, getKeys, now: NOW })).toBeNull();
  });
  it('JWKS を取れないときは拒否', async () => {
    const t = await token();
    expect(await verifyGoogleIdToken(t, { clientId: CLIENT, getKeys: async () => { throw new Error('down'); }, now: NOW })).toBeNull();
  });
  it('クライアント ID が空なら拒否', async () => {
    expect(await verifyGoogleIdToken(await token({ aud: '' }), { clientId: '', getKeys, now: NOW })).toBeNull();
  });
});

describe('セッションの Cookie', () => {
  it('署名したものは通り、期限が切れたら拒否', async () => {
    const v = await signSession('a@example.com', SECRET, NOW);
    expect(await verifySession(v, SECRET, NOW + 1000)).toBe('a@example.com');
    expect(await verifySession(v, SECRET, NOW + SESSION_MS + 1)).toBeNull();
  });
  it('本文、署名、秘密の違いは拒否', async () => {
    const v = await signSession('a@example.com', SECRET, NOW);
    const [p, s] = v.split('.');
    const forged = b64(JSON.stringify({ e: 'b@example.com', x: NOW + 9e9, n: 'zz' }));
    expect(await verifySession(`${forged}.${s}`, SECRET, NOW)).toBeNull();
    expect(await verifySession(`${p}.${s.slice(0, -2)}AA`, SECRET, NOW)).toBeNull();
    expect(await verifySession(`${p}.`, SECRET, NOW)).toBeNull();
    expect(await verifySession(p, SECRET, NOW)).toBeNull();
    expect(await verifySession(v, 'y'.repeat(40), NOW)).toBeNull();
    expect(await verifySession(v, 'short', NOW)).toBeNull();
    expect(await verifySession(null, SECRET, NOW)).toBeNull();
  });
  it('属性は HttpOnly、Secure、SameSite=Strict、Path=/', () => {
    const c = sessionCookie('abc');
    expect(c.startsWith('__Host-')).toBe(true);
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) expect(c).toContain(a);
    expect(c).not.toContain('Domain=');
  });
});

describe('許可リストと設定', () => {
  const env = { GOOGLE_CLIENT_ID: CLIENT, ADMIN_EMAILS: ' Owner@Example.com , b@example.com ', ADMIN_SESSION_SECRET: SECRET };
  it('大文字小文字と空白を見ない。無いメールは拒否', () => {
    expect(isAllowed(env, 'owner@example.com')).toBe(true);
    expect(isAllowed(env, 'OWNER@EXAMPLE.COM')).toBe(true);
    expect(isAllowed(env, 'c@example.com')).toBe(false);
    expect(isAllowed(env, '')).toBe(false);
    expect(isAllowed({}, 'owner@example.com')).toBe(false);
  });
  it('どれかが欠ければ閉じる', () => {
    expect(adminConfigured(env)).toBe(true);
    expect(adminConfigured({ ...env, GOOGLE_CLIENT_ID: '' })).toBe(false);
    expect(adminConfigured({ ...env, ADMIN_EMAILS: ' , ' })).toBe(false);
    expect(adminConfigured({ ...env, ADMIN_SESSION_SECRET: 'short' })).toBe(false);
    expect(adminConfigured({})).toBe(false);
  });
});

describe('門番（_middleware.js）', () => {
  const env = { GOOGLE_CLIENT_ID: CLIENT, ADMIN_EMAILS: 'owner@example.com', ADMIN_SESSION_SECRET: SECRET };
  const ctxOf = (path: string, init: RequestInit = {}, e: Record<string, unknown> = env) => {
    let called = false;
    return { ctx: { request: new Request(`https://meet.example.com${path}`, init), env: e, data: {} as Record<string, unknown>, next: async () => { called = true; return new Response('{}', { status: 200 }); } }, called: () => called };
  };
  const cookie = async (email: string, secret = SECRET) => `${COOKIE_NAME}=${await signSession(email, secret)}`;

  it('Cookie が無ければ 401。次へ進まない', async () => {
    const c = ctxOf('/api/admin/summary');
    expect((await guard(c.ctx)).status).toBe(401);
    expect(c.called()).toBe(false);
  });
  it('正しい Cookie なら通る', async () => {
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: await cookie('owner@example.com') } });
    expect((await guard(c.ctx)).status).toBe(200);
    expect(c.called()).toBe(true);
    expect(c.ctx.data.admin).toEqual({ email: 'owner@example.com' });
  });
  it('改ざんした Cookie は 401', async () => {
    const good = await cookie('owner@example.com');
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: `${good.slice(0, -3)}AAA` } });
    expect((await guard(c.ctx)).status).toBe(401);
  });
  it('別の秘密で署名した Cookie は 401', async () => {
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: await cookie('owner@example.com', 'z'.repeat(40)) } });
    expect((await guard(c.ctx)).status).toBe(401);
  });
  it('許可リストから外れたら、有効な Cookie でも 401', async () => {
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: await cookie('removed@example.com') } });
    expect((await guard(c.ctx)).status).toBe(401);
  });
  it('設定が欠けていれば 503（閉じる）', async () => {
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: await cookie('owner@example.com') } }, { ...env, ADMIN_SESSION_SECRET: '' });
    expect((await guard(c.ctx)).status).toBe(503);
    expect(c.called()).toBe(false);
  });
  it('書き込みは Origin が違えば 403、Sec-Fetch-Site が cross-site でも 403', async () => {
    const headers = { Cookie: await cookie('owner@example.com') };
    const a = ctxOf('/api/admin/feedback/abcdefghijklmnop', { method: 'DELETE', headers });
    expect((await guard(a.ctx)).status).toBe(403);
    const b = ctxOf('/api/admin/feedback/abcdefghijklmnop', { method: 'DELETE', headers: { ...headers, Origin: 'https://evil.example.com' } });
    expect((await guard(b.ctx)).status).toBe(403);
    const c = ctxOf('/api/admin/feedback/abcdefghijklmnop', { method: 'DELETE', headers: { ...headers, Origin: 'https://meet.example.com', 'Sec-Fetch-Site': 'cross-site' } });
    expect((await guard(c.ctx)).status).toBe(403);
    const d = ctxOf('/api/admin/feedback/abcdefghijklmnop', { method: 'DELETE', headers: { ...headers, Origin: 'https://meet.example.com', 'Sec-Fetch-Site': 'same-origin' } });
    expect((await guard(d.ctx)).status).toBe(200);
  });
  it('どの応答にも noindex と no-store が付く', async () => {
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: await cookie('owner@example.com') } });
    const r = await guard(c.ctx);
    expect(r.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });
  it('config と login だけは Cookie なしで通る', async () => {
    for (const p of ['/api/admin/config', '/api/admin/login']) expect((await guard(ctxOf(p).ctx)).status).toBe(200);
    for (const p of ['/api/admin/me', '/api/admin/feedback', '/api/admin/journey', '/api/admin/whatever', '/api/admin/config/x']) expect((await guard(ctxOf(p).ctx)).status).toBe(401);
  });
  it('currentAdmin は設定が欠ければ null', async () => {
    const req = new Request('https://meet.example.com/', { headers: { Cookie: await cookie('owner@example.com') } });
    expect(await currentAdmin(req, env)).toEqual({ email: 'owner@example.com' });
    expect(await currentAdmin(req, {})).toBeNull();
  });
});

describe('login と config', () => {
  const env = { GOOGLE_CLIENT_ID: CLIENT, ADMIN_EMAILS: 'owner@example.com', ADMIN_SESSION_SECRET: SECRET };
  it('設定が欠けていれば login は 503。config はメールアドレスを返さない', async () => {
    const req = new Request('https://meet.example.com/api/admin/login', { method: 'POST', headers: { Origin: 'https://meet.example.com' }, body: '{"credential":"x"}' });
    expect((await login({ request: req, env: {} })).status).toBe(503);
    const off = await (await config({ env: {} })).json();
    expect(off).toEqual({ configured: false, clientId: null });
    const on = await (await config({ env })).text();
    expect(on).toContain(CLIENT);
    expect(on).not.toContain('owner@example.com');
  });
  it('Origin が違えば login は 403', async () => {
    const req = new Request('https://meet.example.com/api/admin/login', { method: 'POST', headers: { Origin: 'https://evil.example.com' }, body: '{"credential":"x"}' });
    expect((await login({ request: req, env })).status).toBe(403);
  });
  it('sameOriginWrite は Origin が無ければ false', () => {
    expect(sameOriginWrite(new Request('https://meet.example.com/x', { method: 'POST' }))).toBe(false);
  });
});

describe('login（Google の鍵を偽物に差し替えて）', () => {
  const env = { GOOGLE_CLIENT_ID: CLIENT, ADMIN_EMAILS: 'owner@example.com', ADMIN_SESSION_SECRET: SECRET };
  const post = (credential: string, ip: string) => new Request('https://meet.example.com/api/admin/login', { method: 'POST', headers: { Origin: 'https://meet.example.com', 'CF-Connecting-IP': ip }, body: JSON.stringify({ credential }) });
  const fresh = (c: Record<string, unknown> = {}) => token({ exp: Date.now() / 1000 + 600, ...c });
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }] }), { headers: { 'cache-control': 'max-age=60' } }));
  });
  it('許可されたメールには Cookie を渡す。その Cookie で門番を通れる', async () => {
    const r = await login({ request: post(await fresh(), '192.0.2.1'), env });
    expect(r.status).toBe(200);
    const set = r.headers.get('Set-Cookie')!;
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', COOKIE_NAME]) expect(set).toContain(a);
    const value = set.split(';')[0];
    const ctx = { request: new Request('https://meet.example.com/api/admin/me', { headers: { Cookie: value } }), env, data: {} as Record<string, unknown>, next: async () => new Response('{}') };
    expect((await guard(ctx)).status).toBe(200);
  });
  it('許可外のメールは 403、未検証は 401、aud 違いは 401。Cookie を渡さない', async () => {
    const a = await login({ request: post(await fresh({ email: 'stranger@example.com' }), '192.0.2.2'), env });
    expect(a.status).toBe(403); expect(a.headers.get('Set-Cookie')).toBeNull();
    const b = await login({ request: post(await fresh({ email_verified: false }), '192.0.2.3'), env });
    expect(b.status).toBe(401); expect(b.headers.get('Set-Cookie')).toBeNull();
    const c = await login({ request: post(await fresh({ aud: 'other' }), '192.0.2.4'), env });
    expect(c.status).toBe(401); expect(c.headers.get('Set-Cookie')).toBeNull();
  });
});
