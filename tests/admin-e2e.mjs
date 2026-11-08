// 感想の送信からダッシュボードまでを、ローカルの wrangler pages dev で通す（docs/ADMIN.md 7 節）
// 使い方：npx wrangler pages dev dist --d1 DB=local-meet-the-painting --persist-to .wrangler/state --port 8788 を動かしてから
//   NODE_PATH=<playwright の場所> node tests/admin-e2e.mjs [--shots <dir>]
// .dev.vars はその場で作ったテスト用の値（tests/make-dev-vars.mjs）。ログインは本物の画面から。音は出さない
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { signSession } from '../functions/_lib/admin-auth.js';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:8788';
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const vars = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const WORK = 'harmoney';
const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> 朝の光みたいで好きです';

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok ' : 'NG '} ${msg}`); if (!ok) failed++; };
const browser = await chromium.launch({ args: ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, locale: 'ja' };
const PC = { viewport: { width: 1280, height: 860 }, locale: 'ja' };
const shot = async (page, name, o = {}) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, ...o }); };
const collect = (page) => { const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push(m.text()); }); return errs; };
// 本物のログイン画面から入る（Cookie を作って迂回しない）
const login = async (page) => {
  await page.goto(`${BASE}/admin/`);
  await page.waitForSelector('.login-form');
  await page.fill('#login-id', vars.ADMIN_USERNAME);
  await page.fill('#login-pw', vars.ADMIN_E2E_PASSWORD);
  await page.press('#login-pw', 'Enter');
  await page.waitForSelector('.top .who');
};

// ───── 1. 認可：ログインしていなければ、データの API はすべて閉じている ─────
for (const p of ['/api/admin/me', '/api/admin/summary', '/api/admin/feedback', '/api/admin/journey?sid=abcdefghij012345']) {
  const r = await fetch(BASE + p);
  check(r.status === 401, `Cookie なしの ${p} は 401（${r.status}）`);
}
{
  const forged = await signSession(vars.ADMIN_USERNAME, 'z'.repeat(48));
  const r = await fetch(`${BASE}/api/admin/summary`, { headers: { Cookie: `__Host-mtp_admin=${forged}` } });
  check(r.status === 401, `別の秘密で署名した Cookie は 401（${r.status}）`);
  const out = await signSession('someone-else', vars.ADMIN_SESSION_SECRET);
  const r2 = await fetch(`${BASE}/api/admin/summary`, { headers: { Cookie: `__Host-mtp_admin=${out}` } });
  check(r2.status === 401, `いまの ID と違う Cookie は 401（${r2.status}）`);
  const good = await signSession(vars.ADMIN_USERNAME, vars.ADMIN_SESSION_SECRET);
  const r3 = await fetch(`${BASE}/api/admin/feedback/abcdefghijklmnop`, { method: 'DELETE', headers: { Cookie: `__Host-mtp_admin=${good}`, Origin: 'https://evil.example.com' } });
  check(r3.status === 403, `別の origin からの削除は 403（${r3.status}）`);
}
{
  const ctx = await browser.newContext(PC);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/`);
  await page.waitForSelector('.login');
  check(await page.locator('.login h1').isVisible(), 'ログインしていなければログインの画面');
  check(await page.locator('#login-id').getAttribute('autocomplete') === 'username' && await page.locator('#login-pw').getAttribute('autocomplete') === 'current-password', 'パスワードマネージャーが使える入力欄');
  // 違う組：文言は同じ。パスワードの欄は空に戻る。Enter で送れる
  for (const [id, pw] of [['wrong-id', vars.ADMIN_E2E_PASSWORD], [vars.ADMIN_USERNAME, 'wrong-password-000']]) {
    await page.fill('#login-id', id);
    await page.fill('#login-pw', pw);
    await page.press('#login-pw', 'Enter');
    await page.waitForFunction(() => { const e = document.querySelector('.login-form .err'); return e && !e.hidden; });
    check((await page.locator('.login-form .err').innerText()) === 'ID かパスワードが違います' && await page.inputValue('#login-pw') === '', `違う組（${id === 'wrong-id' ? 'ID' : 'パスワード'}）は「ID かパスワードが違います」`);
  }
  await shot(page, 'admin-login-failed');
  // 正しい組で入り、読み直しても入ったまま。ログアウトで出る
  await page.fill('#login-id', vars.ADMIN_USERNAME);
  await page.fill('#login-pw', vars.ADMIN_E2E_PASSWORD);
  await page.click('.login-send');
  await page.waitForSelector('.top .who');
  check((await page.locator('.top .who').innerText()) === vars.ADMIN_USERNAME, '正しい組でログインできる');
  await page.reload();
  await page.waitForSelector('.top .who');
  check(true, '読み直してもログインしたまま');
  await page.locator('.top .text-btn', { hasText: 'ログアウト' }).click();
  await page.waitForSelector('.login-form');
  check((await page.context().cookies()).every((k) => k.name !== '__Host-mtp_admin'), 'ログアウトで Cookie が消え、ログインの画面に戻る');
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
  // 会場の QR（?from=qr）から作品ページを開くと、work_view の via は qr（DECISIONS 76）
  const c3 = await browser.newContext(PHONE);
  const p3 = await c3.newPage();
  const b3 = [];
  p3.on('request', (r) => { if (r.url().endsWith('/api/stat')) b3.push(r.postData() || ''); });
  await p3.goto(`${BASE}/w/${WORK}/?from=qr`);
  await p3.waitForTimeout(1500);
  check(b3.some((b) => { try { const j = JSON.parse(b); return j.ev === 'work_view' && j.via === 'qr' && j.id === WORK; } catch { return false; } }), '会場の QR から開くと work_view の via は qr');
  await c3.close();
}

// ───── 6. ダッシュボード（11-08 作り直し：期間、タイル、流れ、推移、絵ごと、感想のカード、会話） ─────
for (const [name, opts] of [['pc', PC], ['phone', PHONE]]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errs = collect(page);
  await login(page);
  await page.waitForSelector('.tiles .tile');
  await page.waitForSelector('.fb, #fb .empty');
  check((await page.locator('.top .who').innerText()) === vars.ADMIN_USERNAME, `${name}：ログインできている`);
  check((await page.locator('.period button[aria-pressed="true"]').getAttribute('data-range')) === '7', `${name}：期間の既定は 7 日`);
  const labels = await page.locator('.tile .tile-label').allInnerTexts();
  check(labels.join('|') === '訪れた人|絵の世界へ|作品ページ（オンライン）|会場の QR から|届いた感想|購入リンク', `${name}：要点のタイルが 6 枚（${labels.join('、')}）`);
  check(await page.locator('.tile svg.spark').count() === 6, `${name}：タイルごとに小さな線`);
  check(await page.locator('.tile .delta b').count() === 6, `${name}：タイルごとに前の 7 日との差`);
  // 流れ：段が下がるほど増えない。前の段が 5 件未満なら割合を出さない
  const fn = await page.locator('.funnel .fn').evaluateAll((li) => li.map((x) => ({ n: Number(x.querySelector('.fn-n').textContent.replace(/,/g, '')), rate: x.querySelector('.fn-rate')?.textContent || '' })));
  if (fn.length) {
    check(fn.length === 5 && fn.every((x, i) => !i || x.n <= fn[i - 1].n), `${name}：流れは 5 段で、下ほど少ない（${fn.map((x) => x.n).join(' → ')}）`);
    check(fn.every((x, i) => !i || !x.rate.includes('%') || fn[i - 1].n >= 5), `${name}：分母が 5 未満の段に割合が無い`);
  } else check(await page.locator('#funnel .empty').count() === 1, `${name}：会話が無ければ流れは一文`);
  // 推移：7 日なら 7 本の当たり。時間帯は 24 本。数字の表がある
  const trendHits = await page.locator('#trend .chart').first().locator('rect.hit').count();
  check(trendHits === 7 || await page.locator('#trend .empty').count() === 1, `${name}：日ごとの推移は 7 日分（${trendHits}）`);
  if (trendHits) {
    check(await page.locator('#trend .chart').nth(1).locator('rect.hit').count() === 24, `${name}：時間帯は 0〜23 時`);
    check(await page.locator('#trend details summary', { hasText: '数字の表で見る' }).count() === 1, `${name}：推移に数字の表`);
    await page.locator('#trend .chart').first().locator('rect.hit').last().hover({ force: true });
    check(await page.locator('#trend .tip:not([hidden])').count() === 1, `${name}：棒に重ねると数が出る`);
  }
  // 絵ごと：6 点の小さな絵。会場の QR の数（5 節で ?from=qr を 1 回開いた）
  check(await page.locator('#works .wk-row').count() === 6 && await page.locator('#works .wk-row img.thumb').count() === 6, `${name}：絵ごとの行が 6 つ、小さな絵つき`);
  const qrCell = page.locator('#works .wk-row', { hasText: 'Harmoney' }).locator('.wk-cell').filter({ has: page.locator('.wk-label', { hasText: /^会場の QR$/ }) }).locator('b');
  const qrN = Number(await qrCell.innerText());
  check(qrN >= 1, `${name}：絵ごとに「会場の QR」を数えている（${qrN}）`);
  check(await page.locator('#works a[href="/exhibit/"]', { hasText: '展示用のキャプションを印刷' }).count() === 1, `${name}：「展示用のキャプションを印刷」`);
  if (name === 'pc') {
    // 並べ替え：見出しを押すと、その列の多い順
    await page.locator('.wk-head button[data-sort="feedback"]').click();
    const fbVals = await page.locator('#works .wk-row').evaluateAll((rows) => rows.map((r) => Number(r.querySelectorAll('.wk-cell b')[5].textContent)));
    check(fbVals.every((v, i) => !i || v <= fbVals[i - 1]), `並べ替え：感想の多い順（${fbVals.join(', ')}）`);
    const body = page.locator('.fb-body', { hasText: '朝の光みたいで' }).first();
    check(await body.count() === 1, '送った感想が届いている');
    check((await body.textContent()).includes('<img src=x'), '本文の HTML は文字として出る');
    check(await page.locator('.fb-body img, .fb-body script').count() === 0, '本文から要素が作られない');
    check(await page.evaluate(() => window.__xss === undefined), 'XSS が起きない');
    const card = page.locator('.fb', { hasText: '朝の光みたいで' }).first();
    check(await card.locator('img.thumb').count() === 1 && (await card.locator('.fb-from').innerText()) === 'オンライン', '感想のカードに絵とどこから（オンライン）');
    await card.locator('.text-btn', { hasText: '流れを見る' }).click();
    await page.waitForSelector('.journey li');
    check((await page.locator('.journey').first().innerText()).includes('感想を作家に届けた'), '感想からその会話の流れを開ける');
    // 期間を今日にすると、推移は時間ごと（24 本）で、時間帯のグラフは出さない
    await page.locator('.period button[data-range="today"]').click();
    await page.waitForFunction(() => document.querySelector('.period button[aria-pressed="true"]')?.dataset.range === 'today' && !document.querySelector('.dash.is-loading'));
    const todayHits = await page.locator('#trend .chart').first().locator('rect.hit').count();
    check(todayHits === 24 && await page.locator('#trend .chart').count() === 1, `今日は時間ごとの推移だけ（${todayHits}）`);
    check((await page.locator('.tile .delta').first().innerText()).includes('昨日の同じ時刻まで'), '今日は昨日の同じ時刻までと比べる');
    await page.locator('.period button[data-range="all"]').click();
    await page.waitForFunction(() => document.querySelector('.period button[aria-pressed="true"]')?.dataset.range === 'all' && !document.querySelector('.dash.is-loading'));
    check(await page.locator('.tile .delta b').count() === 0, '全期間は前の期間との差を出さない');
    check(await page.locator('.fb', { hasText: '朝の光みたいで' }).count() >= 1, '全期間で感想が出る');
    check(await page.locator('#talk svg.flow').count() === 1 || await page.locator('#talk .empty').count() === 1, 'PC の会話の流れは SVG');
  } else {
    check(await page.locator('#talk svg.flow').count() === 0, 'スマホの会話の流れは段ごとの横棒（横スクロールの図にしない）');
    const small = await page.evaluate(() => [...document.querySelectorAll('.dash button, .dash select, .dash summary, .period button, .wk-work a')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.textContent.trim().slice(0, 12)));
    check(small.length === 0, `スマホ：押すところは高さ 44px 以上 ${small.join('、')}`);
  }
  await page.waitForTimeout(300);
  await shot(page, `admin-${name}-full`, { fullPage: true, scale: 'css' });   // スマホの縦長は端末の画素だと撮れる高さを超える
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}：ページが横にはみ出さない`);
  check(errs.length === 0, `${name}：コンソールにエラーが無い ${errs.join(' / ').slice(0, 300)}`);
  await ctx.close();
}

// ───── 7. 削除と改ざん ─────
{
  const ctx = await browser.newContext(PC);
  const page = await ctx.newPage();
  await login(page);
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
  const p2 = await c2.newPage();
  await login(p2);
  const real = (await c2.cookies()).find((k) => k.name === '__Host-mtp_admin');
  check(!!real && real.httpOnly && real.secure && real.sameSite === 'Strict', 'Cookie は HttpOnly、Secure、SameSite=Strict');
  await c2.clearCookies();
  await c2.addCookies([{ ...real, value: `${real.value.slice(0, -4)}AAAA` }]);
  await p2.goto(`${BASE}/admin/`);
  await p2.waitForSelector('.login-form');
  check(true, '改ざんした Cookie ではログインの画面に戻る');
  await c2.close();
}

await browser.close();
console.log(failed ? `\n${failed} 件 NG` : '\nすべて通った');
process.exit(failed ? 1 : 0);
