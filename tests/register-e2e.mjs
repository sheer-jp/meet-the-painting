// 作品の登録（docs/REGISTER.md R1）を、ローカルの wrangler pages dev（D1・R2 ともローカル）で通す
// 管理画面から写真を上げ、ルールだけの版の会話（ANTHROPIC_API_KEY なし）で全項目を埋め、確認カードを確かめ、queued にするまで
// 使い方（docs/ADMIN.md 7 節と同じ準備のあと）：
//   npx wrangler pages dev dist --d1 DB=local-meet-the-painting --r2 WORK_UPLOADS=local-work-uploads --persist-to .wrangler/state --port 8788
//   NODE_PATH=<playwright の場所> node tests/register-e2e.mjs [--shots <dir>]
// テストの写真は無地と単純な図形だけ（作家の絵は使わない）。ログインは本物の画面から
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { signSession } from '../functions/_lib/admin-auth.js';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:8788';
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const vars = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok ' : 'NG '} ${msg}`); if (!ok) failed++; };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, locale: 'ja' };
const PC = { viewport: { width: 1280, height: 860 }, locale: 'ja' };
const shot = async (page, name, o = {}) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, ...o }); };
const collect = (page) => { const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push(m.text()); }); return errs; };
const theBrowser = await chromium.launch({ args: ['--mute-audio'] });
const cookie = `__Host-mtp_admin=${await signSession(vars.ADMIN_USERNAME, vars.ADMIN_SESSION_SECRET)}`;
const login = async (page) => {
  await page.goto(`${BASE}/admin/`);
  await page.waitForSelector('.login-form');
  await page.fill('#login-id', vars.ADMIN_USERNAME);
  await page.fill('#login-pw', vars.ADMIN_E2E_PASSWORD);
  await page.press('#login-pw', 'Enter');
  await page.waitForSelector('.top .who');
};

// ───── テストの写真：生成り色の無地に、墨の丸と朱の四角（F15 の縦長 53 : 65.2 に合わせて 1626 × 2000） ─────
const dir = join(tmpdir(), `mtp-register-e2e-${process.pid}`);
mkdirSync(dir, { recursive: true });
const PHOTO = join(dir, 'test-shapes.jpg');
const shapes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1626" height="2000"><circle cx="560" cy="700" r="320" fill="#141210"/><rect x="820" y="1150" width="520" height="520" fill="#c23a2b"/></svg>');
await sharp({ create: { width: 1626, height: 2000, channels: 3, background: '#efe9dc' } }).composite([{ input: shapes }]).jpeg({ quality: 90 }).withExif({ IFD0: { ImageDescription: 'e2e-should-be-removed' } }).toFile(PHOTO);
const TINY = join(dir, 'tiny.png');
await sharp({ create: { width: 800, height: 600, channels: 3, background: '#cccccc' } }).png().toFile(TINY);

// ───── 1. 認可：Cookie なし、公開専用のトークンの範囲、別の origin ─────
for (const p of ['/api/admin/works', '/api/admin/works/config', '/api/admin/works/abcdefghijklmnop']) {
  const r = await fetch(BASE + p);
  check(r.status === 401, `Cookie なしの ${p} は 401（${r.status}）`);
}
{
  const auth = { Authorization: `Bearer ${vars.PUBLISH_TOKEN}` };
  check((await fetch(`${BASE}/api/admin/works`, { headers: auth })).status === 401, '公開専用のトークンでは一覧を読めない（401）');
  check((await fetch(`${BASE}/api/admin/summary`, { headers: auth })).status === 401, '公開専用のトークンではダッシュボードを読めない（401）');
  check((await fetch(`${BASE}/api/admin/works/next/export`, { headers: { Cookie: cookie } })).status === 401, 'Cookie では書き出せない（401）');
  check((await fetch(`${BASE}/api/admin/works/next/export`, { headers: { Authorization: 'Bearer wrong-token-wrong-token-wrong-token' } })).status === 401, '違うトークンは 401');
  const r = await fetch(`${BASE}/api/admin/works`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example.com' } });
  check(r.status === 403, `別の origin からの下書きの作成は 403（${r.status}）`);
}
// 前の回の下書きを片付ける（公開済みは残る）
{
  const list = await (await fetch(`${BASE}/api/admin/works`, { headers: { Cookie: cookie } })).json();
  for (const d of list.drafts || []) if (!['building', 'published'].includes(d.status)) await fetch(`${BASE}/api/admin/works/${d.id}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: BASE } });
}

// ───── 2. PC：写真 → 会話（ルールだけの版）→ 確認カード → 公開する（queued） ─────
let draftId = null;
{
  const ctx = await browser().newContext(PC);
  const page = await ctx.newPage();
  const errs = collect(page);
  await login(page);
  check(await page.locator('[role=tab]').count() === 3, 'タブは 3 つ（ダッシュボード／作品を登録／作品の一覧）');
  check((await page.locator('[role=tab][aria-selected=true]').innerText()) === 'ダッシュボード', '最初はダッシュボード');
  await page.locator('#tab-register').click();
  await page.waitForSelector('.reg-chat .file-btn');
  check(page.url().endsWith('#register'), 'URL に #register');
  check((await page.locator('.say.bot').first().innerText()).includes('写真を選んでください'), '最初に写真を頼む');
  check(await page.locator('.reg .note', { hasText: '決まった順に聞く版' }).isVisible(), 'Claude の鍵が無いことを伝える');
  await shot(page, 'register-pc-0-start');

  // 小さい写真は断る
  await page.setInputFiles('#reg-file', TINY);
  await page.waitForSelector('.photo-step .err:not([hidden])');
  check((await page.locator('.photo-step .err').innerText()).includes('小さすぎます'), '長辺 1600px 未満は断る');

  await page.setInputFiles('#reg-file', PHOTO);
  await page.waitForSelector('.photo-canvas');
  const size0 = await page.evaluate(() => { const c = document.querySelector('.photo-canvas'); return [c.width, c.height]; });
  check(size0[0] === 1626 && size0[1] === 2000, `縮めずに収まる写真はそのまま（${size0.join('×')}）`);
  await page.getByRole('button', { name: '90° 回す' }).click();
  const size1 = await page.evaluate(() => { const c = document.querySelector('.photo-canvas'); return [c.width, c.height]; });
  check(size1[0] === 2000 && size1[1] === 1626, `90° 回すと縦横が入れ替わる（${size1.join('×')}）`);
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '90° 回す' }).click();
  await shot(page, 'register-pc-1-photo');
  const put = page.waitForResponse((r) => r.url().includes('/photo') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'この写真で始める' }).click();
  check((await put).status() === 200, '写真を送れた');
  await page.waitForSelector('.pv-img[src*="/photo"]');
  await page.waitForFunction(() => { const i = document.querySelector('.pv-img'); return i && i.complete && i.naturalWidth > 0; });
  check(await page.locator('.pv-img').evaluate((i) => i.naturalWidth === 1626 && i.naturalHeight === 2000), '確認カードに写真が出る（回して戻した向き）');
  draftId = await page.evaluate(() => sessionStorage.getItem('mtp_register_draft'));
  check(/^[A-Za-z0-9_-]{16,40}$/.test(draftId || ''), '下書きの id');
  // 送った写真から EXIF が消えている
  const photo = Buffer.from(await (await fetch(`${BASE}/api/admin/works/${draftId}/photo`, { headers: { Cookie: cookie } })).arrayBuffer());
  check(!photo.includes(Buffer.from('e2e-should-be-removed')) && !photo.includes(Buffer.from('Exif')), '置いた写真に EXIF が無い');

  const say = async (text) => {
    const n = await page.locator('.say.bot').count();
    await page.fill('.talk-input', text);
    await page.locator('.talk-form .btn-ink').click();
    await page.waitForFunction((k) => document.querySelectorAll('.say.bot').length > k, n);
    return page.locator('.say.bot').last().innerText();
  };
  check((await say('テストの青 / Test Blue')).includes('描いた年'), '題名 → 年を聞く');
  check(await page.locator('.pv-title').innerText() === 'テストの青', '確認カードに題名が育つ');
  check((await say('2026')).includes('大きさ'), '年 → 大きさを聞く');
  check((await say('S15')).includes('写真の端'), '写真の縦横比と 5% 以上違えば聞き直す');
  check(!(await page.locator('.cc-row', { hasText: '寸法' }).innerText()).includes('S15'), '合わない寸法は入れない');
  check((await say('F15')).includes('何に'), 'F15 → 画材を聞く');
  check((await page.locator('.cc-row', { hasText: '寸法' }).innerText()).includes('F15号 ・ 53 × 65.2 cm'), '号から cm（縦長は 53 × 65.2）');
  await shot(page, 'register-pc-2-talk');
  check((await say('キャンバスにアクリル')).includes('値段'), '画材 → 値段を聞く');
  check((await say('198,000円')).includes('想い'), '値段 → 想いを聞く');
  check((await page.locator('.cc-row', { hasText: '支払い' }).innerText()).includes('支払いリンクを作ります（198,000円）'), '「支払いリンクを作ります（198,000円）」');
  check((await page.locator('.cc-row', { hasText: '作品の id' }).locator('input').inputValue()) === 'test-blue', '作品の id は英語の題名から');
  await say('色が混ざる瞬間が好きだった。朝の光みたいに見えた。見た人が少し元気になればいい。');
  check(await page.locator('.msg-edit input').count() === 3, '想いの文は 3 文の下書きとしてカードに並ぶ');
  check((await say('朝の光、静けさ、新しい章')).includes('これでいい'), '気分 → カードで確かめるよう頼む');
  check(await page.locator('.pub-btn').isDisabled(), '確定するまで「公開する」は押せない');
  // 想いの文を直して確定
  await page.locator('.msg-edit input').first().fill('色が混ざる瞬間が、好きだった。');
  await page.locator('.confirm-messages').click();
  await page.waitForSelector('.msg-list');
  check((await page.locator('.msg-list li').first().innerText()) === '色が混ざる瞬間が、好きだった。', '直した文で確定する');
  await page.locator('.confirm-moods').click();
  await page.waitForFunction(() => !document.querySelector('.confirm-moods'));
  check(await page.locator('.cc .chip.on').count() >= 3, '気分の言葉が確定する');
  check(await page.locator('.pub-btn').isEnabled(), '全部そろうと「公開する」が押せる');
  check((await page.locator('.cap-title').innerText()) === 'テストの青' && (await page.locator('.cap-meta').innerText()).includes('キャンバスにアクリル'), '展示用キャプションの見え方');
  await shot(page, 'register-pc-3-card', { fullPage: true });
  await page.locator('.reg-card').screenshot(shots ? { path: `${shots}/register-card.png` } : {});
  await page.locator('.pub-btn').click();
  check((await page.locator('.pub-sure').innerText()).includes('支払いリンクを作ります（198,000円）'), '押す前に金額を見せる');
  await page.locator('.pub-yes').click();
  await page.waitForSelector('.pub-msg:not(:empty)');
  check((await page.locator('.pub-msg').innerText()).includes('公開の準備ができました（R2 のコマンドで公開します）'), '「公開の準備ができました（R2 のコマンドで公開します）」');
  check((await page.locator('.reg-status').innerText()) === '公開の待ち', '状態は「公開の待ち」');
  check(await page.locator('.talk-form').isHidden(), '公開の待ちのあいだは会話を閉じる');
  await shot(page, 'register-pc-4-queued', { fullPage: true });
  const st = await (await fetch(`${BASE}/api/admin/works/${draftId}`, { headers: { Cookie: cookie } })).json();
  check(st.draft.status === 'queued', `D1 の状態は queued（${st.draft.status}）`);

  // 作品の一覧
  await page.locator('#tab-works').click();
  await page.waitForSelector('.wl-item .badge');
  check((await page.locator('.wl-item .badge').first().innerText()) === '公開の待ち', '一覧に「公開の待ち」の下書き');
  check(await page.locator('.wl-item', { hasText: 'Harmoney' }).count() === 1, '一覧に公開中の作品');
  await shot(page, 'works-pc', { fullPage: true });
  // ダッシュボードに戻っても動く
  await page.locator('#tab-dashboard').click();
  await page.waitForSelector('.tiles .tile');
  check(await page.locator('#pane-register').isHidden(), 'ダッシュボードに戻れる');
  check(errs.length === 0, `PC：ページのエラーなし ${errs.join(' / ')}`);
  await ctx.close();
}

// ───── 3. スマホ：作品を登録（会話の下にカード）、一覧。はみ出さない・押すところ 44px ─────
{
  const ctx = await browser().newContext(PHONE);
  const page = await ctx.newPage();
  const errs = collect(page);
  await login(page);
  // 新しい下書きで始める（前の下書きは queued）
  await page.locator('#tab-register').tap();
  await page.waitForSelector('.reg-chat .file-btn');   // 前の下書きは queued なので、新しく始まる
  await page.setInputFiles('#reg-file', PHOTO);
  await page.waitForSelector('.photo-canvas');
  await page.getByRole('button', { name: 'この写真で始める' }).tap();
  await page.waitForSelector('.pv-img[src*="/photo"]');
  const say = async (text) => {
    const n = await page.locator('.say.bot').count();
    await page.fill('.talk-input', text);
    await page.locator('.talk-form .btn-ink').tap();
    await page.waitForFunction((k) => document.querySelectorAll('.say.bot').length > k, n);
  };
  await say('スマホの赤 / Phone Red');
  await say('2025');
  await say('F15');
  await shot(page, 'register-phone-1-talk');
  const box = await page.evaluate(() => { const c = document.querySelector('.reg-chat').getBoundingClientRect(), k = document.querySelector('.reg-card').getBoundingClientRect(); return { chatBottom: c.bottom, cardTop: k.top }; });
  check(box.cardTop >= box.chatBottom - 1, 'スマホは会話の下にカード');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check(!overflow, 'スマホ：横にはみ出さない（作品を登録）');
  const small = await page.evaluate(() => [...document.querySelectorAll('#pane-register button, #pane-register .file-btn, #pane-register input:not([type=file]), #pane-register textarea, [role=tab]')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 12)));
  check(small.length === 0, `スマホ：押すところは高さ 44px 以上 ${small.join('、')}`);
  await page.locator('.reg-card').scrollIntoViewIfNeeded();
  await shot(page, 'register-phone-2-card', { fullPage: true });
  await page.locator('#tab-works').tap();
  await page.waitForSelector('.wl-item');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'スマホ：横にはみ出さない（作品の一覧）');
  const smallList = await page.evaluate(() => [...document.querySelectorAll('#pane-works button, #pane-works a')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.textContent.trim().slice(0, 12)));
  check(smallList.length === 0, `スマホ：一覧の押すところは 44px 以上 ${smallList.join('、')}`);
  await shot(page, 'works-phone', { fullPage: true });
  // 書きかけの下書きは捨てられる（確認つき）
  const item = page.locator('.wl-item', { hasText: 'スマホの赤' });
  await item.getByRole('button', { name: '捨てる' }).tap();
  check((await item.innerText()).includes('戻せません'), '捨てる前に確かめる');
  await item.getByRole('button', { name: '消す' }).tap();
  await page.waitForFunction(() => ![...document.querySelectorAll('.wl-item')].some((e) => e.textContent.includes('スマホの赤')));
  check(true, '下書きを捨てられる');
  check(errs.length === 0, `スマホ：ページのエラーなし ${errs.join(' / ')}`);
  await ctx.close();
}

// ───── 4. 公開専用のトークンで、queued の下書きを書き出せる（R2 の入口） ─────
{
  const r = await fetch(`${BASE}/api/admin/works/next/export`, { headers: { Authorization: `Bearer ${vars.PUBLISH_TOKEN}` } });
  check(r.status === 200, `queued の下書きを書き出せる（${r.status}）`);
  const x = await r.json();
  check(x.id === draftId && x.work.id === 'test-blue' && x.work.size_cm.join() === '53,65.2' && x.work.buy.price_jpy === 198000, 'work.json の形で、項目がそろっている');
  check(x.work.messages[0] === '色が混ざる瞬間が、好きだった。', '直した文が入っている');
  check(Buffer.from(x.photo.base64, 'base64').subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), '写真は JPEG');
  writeFileSync(join(dir, 'export.json'), JSON.stringify({ id: x.id, work_id: x.work_id }));
}

await browser().close();
console.log(`\n下書き ${draftId}（queued のまま残す。publish-draft の試しに使える）`);
console.log(failed ? `\n${failed} 件 NG` : '\nすべて通った');
process.exit(failed ? 1 : 0);

function browser() { return theBrowser; }
