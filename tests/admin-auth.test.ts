// 管理ページの認証（docs/ADMIN.md 5 節）：パスワード、セッションの Cookie、門番、ログイン
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { hashPassword, verifyPassword, parsePasswordHash, checkCredentials, signSession, verifySession, adminConfigured, sameOriginWrite, currentAdmin, sessionCookie, clearCookie, readCookie, resetLoginMemory, COOKIE_NAME, SESSION_MS, LOGIN_MAX_FAILS, LOGIN_WINDOW_MS, PBKDF2_ITERATIONS } from '../functions/_lib/admin-auth.js';
import { onRequest as guard } from '../functions/api/admin/_middleware.js';
import { onRequestPost as login } from '../functions/api/admin/login.js';
import { onRequestGet as config } from '../functions/api/admin/config.js';
import { onRequestPost as logout } from '../functions/api/admin/logout.js';

const NOW = 1_800_000_000_000;
const b64 = (x: string) => btoa(x).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const SECRET = 'x'.repeat(48);
const USER = 'sheer-admin';
const PASSWORD = 'test-password-only-here';
let HASH = '';
let env: Record<string, unknown>;
beforeAll(async () => {
  HASH = await hashPassword(PASSWORD, { iterations: 10_000 });   // テストは回数を下げて速く
  env = { ADMIN_USERNAME: USER, ADMIN_PASSWORD_HASH: HASH, ADMIN_SESSION_SECRET: SECRET };
});

describe('パスワードのハッシュ', () => {
  it('形式は pbkdf2$<回数>$<salt>$<hash>。回数の既定は Workers の上限 100,000。salt は毎回違う', async () => {
    const a = await hashPassword(PASSWORD), b = await hashPassword(PASSWORD);
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    expect(a).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(PASSWORD);
  });
  it('正しいパスワードだけ通る', async () => {
    expect(await verifyPassword(PASSWORD, HASH)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}x`, HASH)).toBe(false);
    expect(await verifyPassword('', HASH)).toBe(false);
  });
  it('形式の破損は拒否', async () => {
    const [p, n, salt, h] = HASH.split('$');
    for (const bad of ['', 'plain-text', `${p}$${n}$${salt}`, `sha1$${n}$${salt}$${h}`, `${p}$abc$${salt}$${h}`, `${p}$100$${salt}$${h}`, `${p}$100001$${salt}$${h}`, `${p}$${n}$!!!$${h}`, `${p}$${n}$${salt}$${h.slice(0, 10)}`, `${p}$${n}$AAAA$${h}`]) {
      expect(parsePasswordHash(bad)).toBeNull();
      expect(await verifyPassword(PASSWORD, bad)).toBe(false);
    }
    expect(parsePasswordHash(null)).toBeNull();
    expect(parsePasswordHash(`${HASH}\n`)).not.toBeNull();   // Secret の末尾の改行は許す
  });
  it('checkCredentials：ID 違いもパスワード違いも false。ID が違っても PBKDF2 を回す', async () => {
    expect(await checkCredentials(env, USER, PASSWORD)).toBe(true);
    expect(await checkCredentials(env, `${USER}x`, PASSWORD)).toBe(false);
    expect(await checkCredentials(env, USER, 'wrong')).toBe(false);
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    await checkCredentials(env, 'nobody', 'wrong');
    expect(derive).toHaveBeenCalledTimes(1);
    await checkCredentials(env, USER, 'wrong');
    expect(derive).toHaveBeenCalledTimes(2);
    derive.mockRestore();
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

describe('設定', () => {
  it('どれかが欠ける、ハッシュが壊れている、秘密が短ければ閉じる', () => {
    expect(adminConfigured(env)).toBe(true);
    expect(adminConfigured({ ...env, ADMIN_USERNAME: ' ' })).toBe(false);
    expect(adminConfigured({ ...env, ADMIN_PASSWORD_HASH: '' })).toBe(false);
    expect(adminConfigured({ ...env, ADMIN_PASSWORD_HASH: 'plain-text-password' })).toBe(false);
    expect(adminConfigured({ ...env, ADMIN_SESSION_SECRET: 'short' })).toBe(false);
    expect(adminConfigured({})).toBe(false);
    expect(adminConfigured(undefined)).toBe(false);
  });
});

describe('門番（_middleware.js）', () => {
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
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: await cookie('sheer-admin') } });
    expect((await guard(c.ctx)).status).toBe(200);
    expect(c.called()).toBe(true);
    expect(c.ctx.data.admin).toEqual({ name: 'sheer-admin' });
  });
  it('改ざんした Cookie は 401', async () => {
    const good = await cookie('sheer-admin');
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: `${good.slice(0, -3)}AAA` } });
    expect((await guard(c.ctx)).status).toBe(401);
  });
  it('別の秘密で署名した Cookie は 401', async () => {
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: await cookie('sheer-admin', 'z'.repeat(40)) } });
    expect((await guard(c.ctx)).status).toBe(401);
  });
  it('ID を変えたら、古い Cookie は 401', async () => {
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: await cookie('removed@example.com') } });
    expect((await guard(c.ctx)).status).toBe(401);
  });
  it('設定が欠けていれば 503（閉じる）', async () => {
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: await cookie('sheer-admin') } }, { ...env, ADMIN_SESSION_SECRET: '' });
    expect((await guard(c.ctx)).status).toBe(503);
    expect(c.called()).toBe(false);
  });
  it('書き込みは Origin が違えば 403、Sec-Fetch-Site が cross-site でも 403', async () => {
    const headers = { Cookie: await cookie('sheer-admin') };
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
    const c = ctxOf('/api/admin/summary', { headers: { Cookie: await cookie('sheer-admin') } });
    const r = await guard(c.ctx);
    expect(r.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });
  it('config と login だけは Cookie なしで通る', async () => {
    for (const p of ['/api/admin/config', '/api/admin/login']) expect((await guard(ctxOf(p).ctx)).status).toBe(200);
    for (const p of ['/api/admin/me', '/api/admin/feedback', '/api/admin/journey', '/api/admin/whatever', '/api/admin/config/x']) expect((await guard(ctxOf(p).ctx)).status).toBe(401);
  });
  it('currentAdmin は設定が欠ければ null', async () => {
    const req = new Request('https://meet.example.com/', { headers: { Cookie: await cookie('sheer-admin') } });
    expect(await currentAdmin(req, env)).toEqual({ name: 'sheer-admin' });
    expect(await currentAdmin(req, {})).toBeNull();
  });
});

describe('login と config', () => {
  const ORIGIN = 'https://meet.example.com';
  let ipN = 0;
  const post = (body: unknown, o: { ip?: string; origin?: string | null; headers?: Record<string, string> } = {}) => new Request(`${ORIGIN}/api/admin/login`, {
    method: 'POST',
    headers: { ...(o.origin === null ? {} : { Origin: o.origin ?? ORIGIN }), 'CF-Connecting-IP': o.ip ?? `192.0.2.${++ipN}`, ...o.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const good = { username: USER, password: PASSWORD };
  beforeEach(() => { resetLoginMemory(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('正しい組なら Cookie を渡す。その Cookie で門番を通れる', async () => {
    const r = await login({ request: post(good), env });
    expect(r.status).toBe(200);
    const set = r.headers.get('Set-Cookie')!;
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `${COOKIE_NAME}=`]) expect(set).toContain(a);
    expect(COOKIE_NAME.startsWith('__Host-')).toBe(true);
    expect(SESSION_MS).toBeLessThanOrEqual(24 * 3600_000);
    const ctx = { request: new Request(`${ORIGIN}/api/admin/me`, { headers: { Cookie: set.split(';')[0] } }), env, data: {} as Record<string, unknown>, next: async () => new Response('{}') };
    expect((await guard(ctx)).status).toBe(200);
  });
  it('ID 違いとパスワード違いは同じ応答（同じ状態コード、同じ本文）。Cookie を渡さない', async () => {
    const a = await login({ request: post({ username: 'nobody', password: PASSWORD }), env });
    const b = await login({ request: post({ username: USER, password: 'wrong-password' }), env });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(await a.text()).toBe(await b.text());
    expect(a.headers.get('Set-Cookie')).toBeNull(); expect(b.headers.get('Set-Cookie')).toBeNull();
  });
  it('設定が欠けている、ハッシュが壊れているなら 503（閉じる）。正しい組でも入れない', async () => {
    expect((await login({ request: post(good), env: {} })).status).toBe(503);
    expect((await login({ request: post(good), env: { ...env, ADMIN_PASSWORD_HASH: 'broken' } })).status).toBe(503);
    expect((await login({ request: post(good), env: { ...env, ADMIN_USERNAME: '' } })).status).toBe(503);
  });
  it('別の Origin、Origin なしは 403', async () => {
    expect((await login({ request: post(good, { origin: 'https://evil.example.com' }), env })).status).toBe(403);
    expect((await login({ request: post(good, { origin: null }), env })).status).toBe(403);
    expect(sameOriginWrite(new Request(`${ORIGIN}/x`, { method: 'POST' }))).toBe(false);
  });
  it('形の違う本文、大きすぎる本文は 400', async () => {
    for (const b of ['not json', '{}', { username: USER }, { username: USER, password: 1 }, { username: USER, password: 'a'.repeat(513) }, 'null']) expect((await login({ request: post(b), env })).status).toBe(400);
    expect((await login({ request: post(good, { headers: { 'Content-Length': '99999' } }), env })).status).toBe(400);
  });
  it('同じ /64 から 10 回失敗すると 429。別の回線は通る。IPv6 の下位 64 ビットを変えても同じ', async () => {
    const bad = { username: USER, password: 'wrong-password' };
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) expect((await login({ request: post(bad, { ip: `2001:db8:1:2::${i + 1}` }), env })).status).toBe(401);
    const r = await login({ request: post(good, { ip: '2001:db8:1:2::ffff' }), env });
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe(String(LOGIN_WINDOW_MS / 1000));
    expect((await login({ request: post(good, { ip: '2001:db8:1:3::1' }), env })).status).toBe(200);
  });
  it('成功すると失敗の数を消す', async () => {
    const bad = { username: USER, password: 'wrong-password' };
    for (let i = 0; i < LOGIN_MAX_FAILS - 1; i++) await login({ request: post(bad, { ip: '192.0.2.200' }), env });
    expect((await login({ request: post(good, { ip: '192.0.2.200' }), env })).status).toBe(200);
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) expect((await login({ request: post(bad, { ip: '192.0.2.200' }), env })).status).toBe(401);
  });

  // D1 の偽物：login_failures だけ
  function fakeD1() {
    const rows = new Map<string, { first_at: number; n: number }>();
    const calls: { sql: string; args: unknown[] }[] = [];
    const prepare = (sql: string) => {
      const st = {
        args: [] as unknown[],
        bind(...a: unknown[]) { st.args = a; return st; },
        async first() {
          calls.push({ sql, args: st.args });
          const r = rows.get(st.args[0] as string);
          return r && r.first_at > (st.args[1] as number) ? { n: r.n } : null;
        },
        async run() {
          calls.push({ sql, args: st.args });
          if (sql.startsWith('INSERT')) { const r = rows.get(st.args[0] as string); if (r) r.n++; else rows.set(st.args[0] as string, { first_at: st.args[1] as number, n: 1 }); }
          else if (sql.includes('first_at <=')) { for (const [k, v] of rows) if (v.first_at <= (st.args[0] as number)) rows.delete(k); }
          else rows.delete(st.args[0] as string);
        },
      };
      return st;
    };
    return { prepare, rows, calls };
  }
  it('D1 にも数える。別の isolate（メモリが空）でも止まる。生の IP を保存しない', async () => {
    const db = fakeD1();
    const e = { ...env, DB: db };
    const IP = '198.51.100.77';
    const bad = { username: USER, password: 'wrong-password' };
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) await login({ request: post(bad, { ip: IP }), env: e });
    resetLoginMemory();
    expect((await login({ request: post(good, { ip: IP }), env: e })).status).toBe(429);
    expect(JSON.stringify(db.calls)).not.toContain(IP);
    expect(JSON.stringify(db.calls)).not.toContain('198.51');
    expect([...db.rows.keys()][0]).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
  it('期限の切れた行は消える', async () => {
    const db = fakeD1();
    db.rows.set('old', { first_at: Date.now() - LOGIN_WINDOW_MS - 1, n: 3 });
    await login({ request: post({ username: USER, password: 'wrong-password' }), env: { ...env, DB: db } });
    expect(db.rows.has('old')).toBe(false);
  });
  it('D1 が無ければ KV に短命で数える', async () => {
    const store = new Map<string, string>(); const puts: unknown[] = [];
    const STATS = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string, o: unknown) => { store.set(k, v); puts.push(o); }, delete: async (k: string) => { store.delete(k); } };
    const e = { ...env, STATS };
    await login({ request: post({ username: USER, password: 'wrong-password' }, { ip: '198.51.100.78' }), env: e });
    expect([...store.keys()][0]).toMatch(/^lf:/);
    expect(puts[0]).toEqual({ expirationTtl: LOGIN_WINDOW_MS / 1000 });
    expect(JSON.stringify([...store.keys()])).not.toContain('198.51');
  });
  it('保存先が落ちていてもログインの判定は続く（メモリで守る）', async () => {
    const DB = { prepare() { throw new Error('db down'); } };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await login({ request: post(good), env: { ...env, DB } })).status).toBe(200);
    expect((await login({ request: post({ username: USER, password: 'wrong-password' }), env: { ...env, DB } })).status).toBe(401);
    spy.mockRestore();
  });
  it('パスワードをログにもエラーにも出さない', async () => {
    const logs: unknown[][] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a); });
    const DB = { prepare() { throw new Error('db down'); } };
    const secret = 'do-not-log-this-password';
    const rs = [
      await login({ request: post({ username: USER, password: secret }), env }),
      await login({ request: post({ username: USER, password: secret }), env: { ...env, DB } }),
      await login({ request: post(`{"username":"${USER}","password":"${secret}"`), env }),   // 壊れた JSON
    ];
    for (const r of rs) expect(await r.text()).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });
  it('config は設定の有無だけを返す（ID もハッシュも返さない）', async () => {
    expect(await (await config({ env: {} })).json()).toEqual({ configured: false });
    const on = await (await config({ env })).text();
    expect(JSON.parse(on)).toEqual({ configured: true });
    expect(on).not.toContain(USER);
  });
  it('ログアウトは Cookie を消す', async () => {
    const r = await logout();
    expect(r.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});
