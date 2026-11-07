// 感想の送信からダッシュボードまでを、ローカルの wrangler pages dev で通す（docs/ADMIN.md 7 節）
// 使い方：npx wrangler pages dev dist --d1 DB=local-meet-the-painting --persist-to .wrangler/state --port 8788 を動かしてから
//   NODE_PATH=<playwright の場所> node tests/admin-e2e.mjs [--shots <dir>]
// Cookie は .dev.vars のテスト用の秘密で署名する。コードに抜け道は無い。音は出さない
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { signSession } from '../functions/_lib/admin-auth.js';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:8788';
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const vars = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const WORK = 'harmoney';
const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> 朝の光みたいで好きです';

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok ' : 'NG '} ${msg}`); if (!ok) failed++; };
const browser = await chromium.launch({ args: ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, locale: 'ja' };
const PC = { viewport: { width: 1280, height: 860 }, locale: 'ja' };
const shot = async (page, name, o = {}) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, ...o }); };
const collect = (page) => { const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push(m.text()); }); return errs; };
const noGoogle = (ctx) => ctx.route(/accounts\.google\.com/, (r) => r.abort());
const cookieFor = async (email, secret = vars.ADMIN_SESSION_SECRET) => ({ name: '__Host-mtp_admin', value: await signSession(email, secret), url: 'https://localhost', httpOnly: true, secure: true, sameSite: 'Strict' });

// ───── 1. 認可：ログインしていなければ、データの API はすべて閉じている ─────
for (const p of ['/api/admin/me', '/api/admin/summary', '/api/admin/feedback', '/api/admin/journey?sid=abcdefghij012345']) {
  const r = await fetch(BASE + p);
  check(r.status === 401, `Cookie なしの ${p} は 401（${r.status}）`);
}
{
  const forged = await signSession(Object.keys({ 'owner@example.test': 1 })[0], 'z'.repeat(48));
  const r = await fetch(`${BASE}/api/admin/summary`, { headers: { Cookie: `__Host-mtp_admin=${forged}` } });
  check(r.status === 401, `別の秘密で署名した Cookie は 401（${r.status}）`);
  const out = await signSession('stranger@example.test', vars.ADMIN_SESSION_SECRET);
  const r2 = await fetch(`${BASE}/api/admin/summary`, { headers: { Cookie: `__Host-mtp_admin=${out}` } });
  check(r2.status === 401, `許可外のメールの Cookie は 401（${r2.status}）`);
  const good = await signSession('owner@example.test', vars.ADMIN_SESSION_SECRET);
  const r3 = await fetch(`${BASE}/api/admin/feedback/abcdefghijklmnop`, { method: 'DELETE', headers: { Cookie: `__Host-mtp_admin=${good}`, Origin: 'https://evil.example.com' } });
  check(r3.status === 403, `別の origin からの削除は 403（${r3.status}）`);
}
{
  const ctx = await browser.newContext(PC);
  await noGoogle(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/`);
  await page.waitForSelector('.login');
  check(await page.locator('.login h1').isVisible(), 'ログインしていなければログインの画面');
  check((await page.locator('meta[name="robots"]').getAttribute('content')).includes('noindex'), 'noindex の meta');
  await shot(page, 'admin-login-pc');
  await ctx.close();
}

// ───── 2. 感想の送信（スマホ。Claude の鍵なしで定型文で最後まで） ─────
const sent = { id: null };
{
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  const errs = collect(page);
  const asked = [];
  page.on('request', (r) => { if (r.url().includes('/api/followup')) asked.push(r.url()); });
  await page.goto(`${BASE}/w/${WORK}/?via=concierge&after=1`);
  check(await page.locator('.painting img').evaluate((i) => i.complete && i.naturalWidth > 0), '作品ページの絵が出る');
  await page.waitForSelector('.fu', { timeout: 8000 });
  await page.waitForTimeout(700);
  check((await page.locator('.fu-say').innerText()).replace(/\s/g, '').includes('この絵は気に入った？'), '「この絵は気に入った？」が出る');
  const w = await page.evaluate(() => [...document.querySelectorAll('.fu-opt')].map((b) => b.getBoundingClientRect().height));
  check(w.every((h) => h >= 44), `選択肢は親指で押せる高さ（${w.map(Math.round).join(', ')}px）`);
  const over = await page.evaluate(() => { const r = document.querySelector('.fu').getBoundingClientRect(); return r.left < 0 || r.right > innerWidth || document.documentElement.scrollWidth > innerWidth; });
  check(!over, 'カードが画面の幅に収まる');
  await shot(page, 'followup-phone-1-ask');
  check(!asked.some((u) => u.includes('/send')), '反応を押す前に何も送っていない');
  await page.locator('.fu-opt').first().tap();
  await page.waitForSelector('.fu-area');
  await shot(page, 'followup-phone-2-talk');
  await page.fill('.fu-area', XSS);
  await page.locator('.fu-form .fu-send').tap();
  await page.waitForSelector('.fu-note');
  const note = (await page.locator('.fu-note').innerText()).replace(/\s/g, '');
  check(note.includes('作家に届きます'), '送る前に「作家に届きます」');
  check(!asked.some((u) => u.includes('/send')), '話しただけでは保存していない');
  check((await page.locator('.fu-say').innerText()).replace(/\s/g, '').includes('聞かせてくれてありがとう'), 'Claude が無いときは定型文で返す');
  await shot(page, 'followup-phone-3-confirm');
  // 保存の失敗：正直に言い、文を残す
  await page.route('**/api/followup/send', (r) => r.fulfill({ status: 503, body: '{"error":"unavailable"}', contentType: 'application/json' }));
  await page.locator('.fu-body > .fu-send').tap();
  await page.waitForFunction(() => document.querySelector('.fu-status')?.textContent);
  check((await page.locator('.fu-status').innerText()).replace(/\s/g, '').includes('届けられなかった'), '保存に失敗したら「届けられなかった」と言う');
  check((await page.locator('textarea.fu-area').inputValue()) === XSS, '失敗しても文は残る');
  await shot(page, 'followup-phone-4-failed');
  await page.unroute('**/api/followup/send');
  await page.locator('.fu-body > .fu-send').tap();
  await page.waitForFunction(() => document.querySelector('.fu-say')?.textContent.includes('届けたよ'));
  check(true, '「作家に届ける」で保存された');
  await shot(page, 'followup-phone-5-sent');
  check(errs.length === 0, `コンソールにエラーが無い ${errs.join(' / ').slice(0, 200)}`);
  // 送った作品にはもう出ない
  await page.goto(`${BASE}/w/${WORK}/?via=concierge&after=1`);
  await page.waitForTimeout(3000);
  check(await page.locator('.fu').count() === 0, '送った作品には自動で出ない');
  check(await page.locator('.fu-entry button').count() === 1, '小さなリンクはある');
  await page.locator('.fu-entry button').tap();
  await page.waitForSelector('.fu');
  check(true, 'リンクから自分で開ける');
  await ctx.close();
}

// ───── 2b. Claude の返事がある場合（本物は呼ばず、応答だけ差し替える）：2 往復で止まる ─────
{
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  const bodies = [];
  await page.route('**/api/followup/config', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":true,"ai":true}' }));
  await page.route('**/api/followup', (r) => { bodies.push(JSON.parse(r.request().postData())); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: `返事その${bodies.length}。` }) }); });
  await page.goto(`${BASE}/w/new-chapter/?via=concierge&after=1`);
  await page.waitForSelector('.fu', { timeout: 8000 });
  await page.locator('.fu-opt').first().tap();
  await page.fill('.fu-area', '一つ目');
  await page.locator('.fu-form .fu-send').tap();
  await page.waitForFunction(() => document.querySelector('.fu-say')?.textContent.includes('返事その1'));
  check(bodies[0].texts.length === 1 && !('messages' in bodies[0]), '案内役の文は送らず、訪れた人の文だけ送る');
  await page.locator('.fu-sub', { hasText: 'もう少し話す' }).tap();
  await page.fill('.fu-area', '二つ目');
  await page.locator('.fu-form .fu-send').tap();
  await page.waitForFunction(() => document.querySelector('.fu-say')?.textContent.includes('返事その2'));
  check(bodies[1].texts.length === 2, '2 往復目は 2 つの文を送る');
  check(await page.locator('.fu-sub', { hasText: 'もう少し話す' }).count() === 0, '2 往復で止まる');
  check((await page.locator('textarea.fu-area').inputValue()) === '一つ目\n二つ目', '送る文は自分のことばだけで、直せる');
  await shot(page, 'followup-phone-ai-mock');
  await ctx.close();
}

// ───── 3. 閉じたら出ない。反応だけでも送れる。英語 ─────
{
  const ctx = await browser.newContext({ ...PC, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/w/itadaki/?via=concierge&after=1`);
  await page.waitForSelector('.fu', { timeout: 8000 });
  check((await page.locator('.fu-say').innerText()).includes('Did you like'), '英語で出る');
  await page.waitForTimeout(600);
  await shot(page, 'followup-pc-en');
  await page.locator('.fu-x').click();
  check(await page.locator('.fu').count() === 0, '× で閉じる');
  await page.goto(`${BASE}/w/itadaki/?via=concierge&after=1`);
  await page.waitForTimeout(3000);
  check(await page.locator('.fu').count() === 0, '一度閉じた作品には自動で出ない');
  await ctx.close();
  const c2 = await browser.newContext({ ...PC, locale: 'ko' });
  const p2 = await c2.newPage();
  await p2.goto(`${BASE}/w/instinct/?via=concierge&after=1`);
  await p2.waitForSelector('.fu', { timeout: 8000 });
  check((await p2.locator('.fu-say').innerText()).includes('그림'), '韓国語は遅延読み込みで訳が出る');
  await p2.locator('.fu-opt').nth(1).click();
  await p2.locator('.fu-sub').first().click();
  await p2.waitForSelector('.fu-picked');
  await p2.locator('.fu-body > .fu-send').click();
  await p2.waitForFunction(() => document.querySelector('.fu-say')?.textContent.includes('고마워'));
  check(true, '反応だけでも送れる');
  await c2.close();
}

// ───── 4. 語りの終わり（T5）：最中には出ず、帯のあとに stage の中に出る ─────
for (const [tag, opts] of [['pc', PC], ['phone', PHONE]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errs = collect(page);
  await page.goto(`${BASE}/w/golden-path/`);
  await page.click('#enter');
  await page.waitForSelector('#stage:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(2500);
  check(await page.locator('.fu').count() === 0, '語りの最中にカードは出ない');
  // 飛ばして終わりへ
  for (let i = 0; i < 150 && !(await page.locator('.end-band.on').count()); i++) {
    const skip = page.locator('.hud button.skip, .hud .skip');
    if (await skip.count() && await skip.first().isVisible()) await skip.first().click({ timeout: 800 }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  check(await page.locator('.end-band.on').count() === 1, '語りの終わりの帯が出る');
  await page.waitForSelector('#stage .fu', { timeout: 12000 });
  check(true, '帯のあとに stage の中にカードが出る');
  const pos = await page.evaluate(() => { const c = document.querySelector('.fu').getBoundingClientRect(); const b = document.querySelector('.end-band').getBoundingClientRect(); return c.bottom <= b.top + 1; });
  check(pos, 'カードが帯に重ならない');
  await page.waitForTimeout(800);
  await shot(page, `followup-t5-${tag}`);
  await page.locator('.fu-opt').first().click();
  await page.waitForSelector('.fu-area');
  await page.fill('.fu-area', 'スペース も打てる');
  check((await page.locator('.fu-area').inputValue()) === 'スペース も打てる', 'カードの入力が物語の操作に取られない');
  await page.keyboard.press('Escape');
  check(await page.locator('.fu').count() === 0, 'Esc はカードだけを閉じる');
  check(await page.locator('#stage:not([hidden])').count() === 1, '物語の画面はそのまま');
  check(errs.length === 0, `コンソールにエラーが無い ${errs.join(' / ').slice(0, 200)}`);
  await ctx.close();
}

// ───── 5. 受付：押した選択肢が出来事になる（自由入力は文を送らない） ─────
{
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  const beacons = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/stat')) beacons.push(r.postData() || ''); });
  await page.goto(`${BASE}/`);
  await page.waitForSelector('button[data-opener-index]:not(.cg-write)');
  await page.waitForTimeout(800);
  await page.locator('button[data-opener-index]:not(.cg-write)').first().tap();
  await page.waitForTimeout(1500);
  check(beacons.some((b) => b.includes('"cg_opener"')), '選択肢を押すと cg_opener が送られる');
  const sidOf = (b) => { try { return JSON.parse(b).sid; } catch { return null; } };
  check(new Set(beacons.map(sidOf)).size === 1 && /^[\w-]{16,32}$/.test(sidOf(beacons[0]) || ''), '同じタブは同じ匿名 id');
  await ctx.close();
  const c2 = await browser.newContext(PHONE);
  const p2 = await c2.newPage();
  const b2 = [];
  p2.on('request', (r) => { if (r.url().endsWith('/api/stat')) b2.push(r.postData() || ''); });
  await p2.goto(`${BASE}/`);
  await p2.waitForSelector('.cg-write');
  await p2.waitForTimeout(800);
  await p2.locator('.cg-write').tap();
  await p2.fill('.cg-form input', '秘密のことば');
  await p2.locator('.cg-form button').tap();
  await p2.waitForTimeout(1200);
  check(b2.some((b) => b.includes('"cg_free"')), '自由入力は「あり」だけ送られる');
  check(!b2.some((b) => b.includes('秘密のことば')), '自由入力の文は出来事に入らない');
  await c2.close();
}

// ───── 6. ダッシュボード ─────
for (const [name, opts] of [['pc', PC], ['phone', PHONE]]) {
  const ctx = await browser.newContext(opts);
  await noGoogle(ctx);
  await ctx.addCookies([await cookieFor('owner@example.test')]);
  const page = await ctx.newPage();
  const errs = collect(page);
  await page.goto(`${BASE}/admin/`);
  await page.waitForSelector('.kpis .kpi');
  await page.waitForSelector('.fb, #fb .empty');
  check((await page.locator('.top .who').innerText()) === 'owner@example.test', `${name}：ログインできている`);
  if (name === 'pc') {
    const body = page.locator('.fb-body', { hasText: '朝の光みたいで' }).first();
    check(await body.count() === 1, '送った感想が届いている');
    check((await body.textContent()).includes('<img src=x'), '本文の HTML は文字として出る');
    check(await page.locator('.fb-body img, .fb-body script').count() === 0, '本文から要素が作られない');
    check(await page.evaluate(() => window.__xss === undefined), 'XSS が起きない');
    await page.locator('.fb', { hasText: '朝の光みたいで' }).first().locator('.text-btn', { hasText: '流れを見る' }).click();
    await page.waitForSelector('.journey li');
    check((await page.locator('.journey').first().innerText()).includes('感想を作家に届けた'), '感想からその会話の流れを開ける');
    await page.locator('.period button', { hasText: '7 日' }).click();
    await page.waitForTimeout(500);
    check((await page.locator('.period button[aria-pressed="true"]').innerText()).includes('7'), '期間を切り替えられる');
  }
  await page.waitForTimeout(300);
  await shot(page, `admin-${name}-full`, { fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}：ページが横にはみ出さない`);
  check(errs.length === 0, `${name}：コンソールにエラーが無い ${errs.join(' / ').slice(0, 300)}`);
  await ctx.close();
}

// ───── 7. 削除と改ざん ─────
{
  const ctx = await browser.newContext(PC);
  await noGoogle(ctx);
  await ctx.addCookies([await cookieFor('owner@example.test')]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/`);
  await page.waitForSelector('.fb');
  const item = page.locator('.fb', { hasText: '朝の光みたいで' }).first();
  const before = await page.locator('.fb', { hasText: '朝の光みたいで' }).count();
  await item.locator('.text-btn', { hasText: '削除' }).click();
  check(await item.locator('.warn').isVisible(), '削除には確認がある');
  await item.locator('.danger').click();
  await page.waitForTimeout(600);
  check(await page.locator('.fb', { hasText: '朝の光みたいで' }).count() === before - 1, '削除できる');
  await page.reload();
  await page.waitForSelector('#fb .fb, #fb .empty');
  check(await page.locator('.fb', { hasText: '朝の光みたいで' }).count() === before - 1, '読み直しても消えたまま');
  await ctx.close();
  const c2 = await browser.newContext(PC);
  await noGoogle(c2);
  const c = await cookieFor('owner@example.test');
  await c2.addCookies([{ ...c, value: `${c.value.slice(0, -4)}AAAA` }]);
  const p2 = await c2.newPage();
  await p2.goto(`${BASE}/admin/`);
  await p2.waitForSelector('.login');
  check(true, '改ざんした Cookie ではログインの画面に戻る');
  await c2.close();
}

await browser.close();
console.log(failed ? `\n${failed} 件 NG` : '\nすべて通った');
process.exit(failed ? 1 : 0);
