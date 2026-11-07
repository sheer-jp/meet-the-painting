// QA の指摘の回帰テスト（11-08）：「押したのに動かない」を実際に押して確かめる。smoke.mjs の終わりに Chromium と WebKit で流す
// 単独で：BASE=http://localhost:4173 NODE_PATH=<playwright> node tests/regress.mjs [--shots <dir>] [--only 3,5]（vite preview を先に動かす）
// /api/ はモック。音は出さない（AudioContext と speechSynthesis をスタブ）
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const pw = createRequire(import.meta.url)('playwright');

const AUDIO_STUB = () => {
  const noop = () => {};
  const node = () => new Proxy(function () {}, {
    get: (_, k) => {
      if (k === 'connect') return (d) => d || node();
      if (k === 'value' || k === Symbol.toPrimitive) return k === 'value' ? 0 : () => 0;
      if (k === 'then') return undefined;
      return node();
    },
    set: () => true, apply: () => node(),
  });
  class AC {
    constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 44100; this.destination = node(); this.listener = node(); }
    resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); } close() { return Promise.resolve(); }
    addEventListener() {} removeEventListener() {}
    createGain() { return node(); } createOscillator() { return node(); } createBiquadFilter() { return node(); } createBufferSource() { return node(); } createDynamicsCompressor() { return node(); } createStereoPanner() { return node(); } createConvolver() { return node(); } createWaveShaper() { return node(); } createAnalyser() { return node(); } createDelay() { return node(); }
    createBuffer(c, l) { return { getChannelData: () => new Float32Array(l || 1), length: l || 1, numberOfChannels: c || 1, duration: 1 }; }
    decodeAudioData() { return Promise.resolve(this.createBuffer(1, 1)); }
  }
  window.AudioContext = AC; window.webkitAudioContext = AC;
  try { Object.defineProperty(window, 'speechSynthesis', { value: { speak: noop, cancel: noop, pause: noop, resume: noop, getVoices: () => [], speaking: false, addEventListener: noop, removeEventListener: noop } }); } catch {}
  HTMLMediaElement.prototype.play = function () { this.muted = true; return Promise.resolve(); };
  try { sessionStorage.setItem('etp-door-seen', '1'); } catch {}   // 扉は飛ばす（扉のテストは smoke.mjs）
  window.__ETP_FAST = true;
};

export async function runRegress({ base, kinds = ['chromium', 'webkit'], shots = null, only = null, check }) {
  const browsers = {};
  for (const k of kinds) browsers[k] = await pw[k].launch({ args: k === 'chromium' ? ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : [] });
  if (shots) mkdirSync(shots, { recursive: true });
  const catalog = await fetch(`${base}/catalog.json`).then((r) => r.json());
  const titles = catalog.works.map((w) => w.title?.ja);

  async function open(kind, w, h, path, { lang = 'ja', status = {}, fu = null, routes = null, touch = false, grant = false } = {}) {
    const ctx = await browsers[kind].newContext({ viewport: { width: w, height: h }, locale: lang, hasTouch: touch, ...(grant && kind === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });
    await ctx.addInitScript(AUDIO_STUB);
    await ctx.route('**/api/stat', (r) => r.fulfill({ status: 204 }));
    await ctx.route('**/api/recommend**', (r) => r.fulfill({ status: 404, body: '' }));
    await ctx.route('**/api/works-status', (r) => r.fulfill({ json: { statuses: status } }));
    await ctx.route('**/api/followup/config', (r) => r.fulfill({ json: fu || { enabled: false, ai: false } }));
    await ctx.route('**/api/followup', (r) => r.fulfill({ json: { reply: 'うれしいな。' } }));
    await ctx.route('**/api/followup/send', (r) => r.fulfill({ json: { ok: true } }));
    if (routes) await routes(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    if (path) await page.goto(base + path, { waitUntil: 'load' });
    return { ctx, page, errors, done: () => ctx.close() };
  }
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
  // 受付：選択肢 → ルールだけの 3 問 → C2
  async function toC2(page) {
    await page.locator('.cg-openers .cg-opt').first().click();
    for (let i = 0; i < 3; i++) await page.locator('.cg-choices .cg-opt').first().click({ timeout: 8000 });
    await page.waitForSelector('.cg2:not([hidden]) .cg-enter', { timeout: 15000 });
    await page.locator('.cg-enter').waitFor({ state: 'visible' });
    await page.waitForTimeout(1500);   // カードの登場（0.15 秒ずつ遅れて出る）
  }
  // 物語：「次へ」を押して T5（帯が出る）まで進める
  async function toEnd(page) {
    const skip = page.locator('.hud .skip');
    await skip.waitFor({ state: 'visible', timeout: 15000 });
    for (let i = 0; i < 40; i++) {
      if (await page.locator('.end-band.on').count()) return;
      if (await skip.isVisible().catch(() => false)) await skip.click({ timeout: 1000, force: true }).catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.waitForSelector('.end-band.on', { timeout: 30000 });
  }
  const inView = (page, sel) => page.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1; });
  const want = (n) => !only || only.includes(n);

  for (const kind of kinds) {
    const T = (m) => `${kind}: ${m}`;

    if (want(1) && kind === 'chromium') {
      const r = await fetch(`${base}/admin/`);
      check(r.status === 200 && /絵と出会う/.test(await r.text()), T(`#1 /admin/ が 200（${r.status}）`));
    }

    if (want(2) && kind === 'chromium') {
      const { page, done } = await open(kind, 390, 844, '/w/harmoney/');
      check(await page.locator('.story').count() === 0 && !(await page.locator('main').innerText()).includes('下書き'), T('#2 Harmoney に Story 欄と「下書き」が無い'));
      check(!JSON.stringify(catalog).includes('カーテン'), T('#2 catalog.json に物語が無い'));
      for (const f of ['stories.json', 'translations.json']) {
        const res = await fetch(`${base}/works/harmoney/generated/${f}`);
        const text = res.ok ? await res.text() : '';
        check(!text.includes('カーテン'), T(`#2 ${f} を配信しない`));
      }
      await done();
    }

    if (want(3)) {
      const { page, errors, done } = await open(kind, 390, 844, '/w/harmoney/?via=concierge&after=1', { fu: { enabled: true, ai: true } });
      await page.waitForSelector('.fu', { timeout: 6000 });
      await page.locator('.fu-opt').nth(3).click();
      await page.locator('.fu-area').fill('書きかけの感想');
      await page.locator('.via-links a[data-action="again"]').click();
      await page.waitForSelector('#stage:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(500);
      check(await page.locator('.fu').isHidden(), T('#3 体験の間はカードが隠れる'));
      await shot(page, `${kind}-03-in-experience`);
      await page.locator('.hud .close').click();
      await page.waitForSelector('#stage', { state: 'hidden' });
      check(await page.locator('.fu').isVisible() && await page.locator('.fu-area').inputValue() === '書きかけの感想', T('#3 戻るとカードと書きかけが戻る'));
      await page.locator('.fu-x').click();
      check(await page.locator('.fu').count() === 0, T('#3 カードを閉じられる'));
      check(errors.length === 0, T(`#3 エラー ${errors.join(' / ')}`));
      await done();
      // すぐ入ったとき：タイマーのカードが体験の上に出ない
      const b = await open(kind, 390, 844, '/w/harmoney/?via=concierge&after=1', { fu: { enabled: true, ai: true } });
      await b.page.locator('#enter').click();
      await b.page.waitForSelector('#stage:not([hidden])', { timeout: 15000 });
      await b.page.waitForTimeout(2600);
      check(await b.page.locator('.fu').count() === 0 || await b.page.locator('.fu').isHidden(), T('#3 体験の最中にタイマーのカードが出ない'));
      await b.done();
    }

    if (want(4) || want(5) || want(6)) {
      const { page, errors, done } = await open(kind, 390, 844, '/');
      await toC2(page);
      await page.locator('.cg-enter').click();
      await page.waitForSelector('#stage:not([hidden])', { timeout: 20000 });
      const pause = page.locator('.hud .pausebtn');
      check(await pause.isHidden(), T('#5 T0 では一時停止を出さない'));
      const t0 = Date.now();
      await page.locator('.hud .skip').click();
      // T0 で押して、語りの最初の文がすぐ出る
      await page.waitForFunction(() => { const el = document.querySelector('.float-text'); return el && el.textContent && getComputedStyle(el).opacity !== '0'; }, null, { timeout: 8000 });
      check(Date.now() - t0 < 4500, T(`#6 T0 の「次へ」で語りへ（${Date.now() - t0}ms）`));
      check(await pause.isVisible(), T('#5 語りの間は一時停止が見える'));
      await pause.click();
      await page.waitForTimeout(400);
      check(await page.locator('.hud .paused').evaluate((el) => getComputedStyle(el).opacity === '1'), T('#5 一時停止が効く'));
      const overlap = await page.evaluate(() => { const a = document.querySelector('.hud .paused').getBoundingClientRect(), b = document.querySelector('.float-text').getBoundingClientRect(); return !(a.bottom <= b.top || a.top >= b.bottom); });
      check(!overlap, T('#5 「一時停止」の文字が文に隠れない'));
      await shot(page, `${kind}-05-paused`);
      await pause.click();
      // 最後の文のあとで押したら 10 秒待たない
      const t1 = Date.now();
      for (let i = 0; i < 60 && !await page.locator('.hud .skip').evaluate((el) => el.hidden); i++) { await page.locator('.hud .skip').click({ force: true, timeout: 500 }).catch(() => {}); await page.waitForTimeout(250); }
      check(await page.locator('.hud .skip').evaluate((el) => el.hidden) && Date.now() - t1 < 10000, T(`#6 「次へ」を押し続けると余韻の 10 秒を待たずに T4 へ（${Date.now() - t1}ms）`));
      check(await pause.isHidden(), T('#5 T4 で一時停止を隠す'));
      await page.waitForSelector('.end-band.on', { timeout: 30000 });
      await shot(page, `${kind}-04-t5`);
      await page.locator('.end-band [data-action="rooms"]').click();
      await page.waitForURL(/#rooms/, { timeout: 8000 });
      await page.waitForTimeout(800);
      const roomsTop = await page.locator('#rooms').evaluate((el) => el.getBoundingClientRect().top);
      check(Math.abs(roomsTop) < 200, T(`#4 受付の絵の世界の「部屋で見る」で部屋の欄に着く（top ${Math.round(roomsTop)}）`));
      await shot(page, `${kind}-04-rooms`);
      check(errors.length === 0, T(`#4 エラー ${errors.join(' / ')}`));
      await done();
    }

    if (want(7)) {
      const { page, done } = await open(kind, 390, 844, '/w/harmoney/', { status: { Harmoney: { status: 'SOLD', soldOut: true } } });
      await page.waitForSelector('.buy .sold-tag');
      const a = await page.locator('.avail').innerText();
      check(a !== '販売中' && /SOLD|売/.test(a), T(`#7 SOLD の絵に「販売中」が残らない（${a}）`));
      await done();
    }

    if (want(8) || want(19)) {
      for (const [w, h] of [[844, 390], [1280, 720], [375, 667], [390, 844], [768, 1024], [1440, 900], [1920, 1080]]) {
        const { page, done } = await open(kind, w, h, '/');
        await page.waitForTimeout(1600);
        const seen = await page.evaluate(() => { const box = document.querySelector('.cg-thread').getBoundingClientRect(); const r = document.querySelector('.cg-write').getBoundingClientRect(); return r.bottom <= box.bottom + 1 && r.bottom <= innerHeight; });
        check(seen, T(`#8/#19 ${w}×${h} の受付で「自分のことばで書く」まで最初の画面に入る`));
        if (w === 844) {
          const host = await page.locator('.cg-host').evaluate((el) => { const r = el.getBoundingClientRect(); return (r.right / innerWidth); });
          const talk = await page.locator('.cg-talk').evaluate((el) => el.getBoundingClientRect().left / innerWidth);
          check(host < 0.42 && talk > 0.3, T(`#8 横向きはキャラクターが左（右端 ${host.toFixed(2)}、会話の左 ${talk.toFixed(2)}）`));
        }
        await shot(page, `${kind}-19-greet-${w}x${h}`);
        await done();
      }
      // C2：どの作品でも主ボタンが最初の画面に入る。絵のいちばん縦長な Harmoney を出す
      for (const [w, h] of [[375, 667], [390, 844], [844, 390], [1280, 720], [768, 1024]]) {
        const { page, done } = await open(kind, w, h, '/?retry=x', { status: Object.fromEntries(titles.filter((t) => t !== 'Harmoney').map((t) => [t, { status: 'SOLD', soldOut: true }])) });
        await page.goto(base + '/', { waitUntil: 'load' });
        await toC2(page);
        check(await page.locator('.cg-card').getAttribute('data-work') === 'harmoney' && await inView(page, '.cg-enter'), T(`#19 C2 ${w}×${h}：縦長の絵でも主ボタンが見える`));
        await shot(page, `${kind}-19-c2-${w}x${h}`);
        await done();
      }
    }

    if (want(9) || want(10) || want(11)) {
      const { page, done } = await open(kind, 390, 844, '/w/harmoney/?via=concierge&after=1', { fu: { enabled: true, ai: true } });
      await page.waitForSelector('.fu', { timeout: 6000 });
      await page.locator('.fu-opt').nth(3).click();
      check(/AI に渡します/.test(await page.locator('.fu-form .fu-note').innerText()), T('#10 自由入力の近くに「返事を作るため AI に渡します」'));
      await page.locator('.fu-area').fill('最初の感想');
      await page.locator('.fu-form .fu-send').click();
      await page.waitForSelector('.fu-body > .fu-area');
      await page.locator('.fu-body > .fu-area').fill('直した感想');
      await page.locator('.fu-sub').first().click();   // もっと話す
      await page.locator('.fu-form .fu-area').fill('もうひとこと');
      await page.locator('.fu-form .fu-send').click();
      await page.waitForSelector('.fu-body > .fu-area');
      const v = await page.locator('.fu-body > .fu-area').inputValue();
      check(v.includes('直した感想') && v.includes('もうひとこと') && !v.includes('最初の感想'), T(`#11 直した文が「もっと話す」で戻らない（${v.replace(/\n/g, '／')}）`));
      await page.locator('.fu-body > .fu-area').fill('');
      check(await page.locator('.fu-body > .fu-send').isDisabled() && (await page.locator('.fu-status').innerText()).length > 0, T('#9 文を空にすると押せず、理由が出る'));
      await shot(page, `${kind}-09-empty`);
      await done();
      // 再送で直した文を送る
      let bodies = [];
      const b = await open(kind, 390, 844, '/w/harmoney/?via=concierge&after=1', { fu: { enabled: true, ai: false }, routes: async (ctx) => { let n = 0; await ctx.route('**/api/followup/send', (r) => { bodies.push(JSON.parse(r.request().postData())); return n++ ? r.fulfill({ json: { ok: true } }) : r.fulfill({ status: 503, json: {} }); }); } });
      await b.page.waitForSelector('.fu', { timeout: 6000 });
      await b.page.locator('.fu-opt').nth(3).click();
      await b.page.locator('.fu-area').fill('一回目');
      await b.page.locator('.fu-form .fu-send').click();
      await b.page.waitForSelector('.fu-body > .fu-area');
      await b.page.locator('.fu-body > .fu-send').click();
      await b.page.waitForFunction(() => document.querySelector('.fu-status')?.textContent);
      await b.page.locator('.fu-body > .fu-area').fill('二回目');
      await b.page.locator('.fu-body > .fu-send').click();
      await b.page.waitForFunction(() => !document.querySelector('.fu-body > .fu-area'));
      check(bodies.length === 2 && bodies[1].text === '二回目' && bodies[0].id === bodies[1].id, T('#11 再送は直した文で、同じ id'));
      await b.done();
    }

    if (want(10)) {
      for (const p of ['/', '/gallery/', '/w/harmoney/']) {
        const { page, done } = await open(kind, 390, 844, p);
        const a = page.locator(p === '/' ? '.cg-data' : 'footer a');
        const box = await a.boundingBox();
        check(/記録について/.test(await a.innerText()) && !!box && /data-note\.html$/.test(await a.getAttribute('href')), T(`#10 ${p} に「記録について」`));
        await done();
      }
      const { page, done } = await open(kind, 1280, 720, '/gallery/');
      await page.locator('footer a').click();
      await page.waitForURL(/data-note/);
      check(/記録について/.test(await page.locator('h1').first().innerText()), T('#10 ギャラリー（PC）のリンクが押せる'));
      check(await page.locator('a[href="/"]').count() > 0, T('#10 data-note に戻るリンク'));
      await done();
    }

    if (want(12)) {
      // 体験の部品を止めて「入っている途中」にし、bfcache から戻ったことを模擬する
      let enters = 0;
      const { page, done } = await open(kind, 390, 844, '/', { routes: async (ctx) => {
        await ctx.route('**/api/stat', (r) => { if (/"ev":"enter"/.test(r.request().postData() || '')) enters++; return r.fulfill({ status: 204 }); });
        await ctx.route(/assets\/main-.*\.js/, () => { /* 応えない */ });
      } });
      await toC2(page);
      await page.locator('.cg-enter').click();
      await page.waitForTimeout(400);
      check(/読み込み中/.test(await page.locator('.cg-enter').innerText()), T('#12 押すと「読み込み中…」'));
      await page.locator('.cg-enter').click();
      await page.waitForTimeout(300);
      check(enters === 1, T(`#12 入っている途中の二度押しは無視（${enters}）`));
      await page.evaluate(() => { const e = new Event('pageshow'); Object.defineProperty(e, 'persisted', { value: true }); window.dispatchEvent(e); });
      check(!/読み込み中/.test(await page.locator('.cg-enter').innerText()), T('#12 pageshow（persisted）で状態が戻る'));
      await page.locator('.cg-enter').click();
      await page.waitForTimeout(300);
      check(enters === 2, T(`#12 戻ったあとまた押せる（${enters}）`));
      await done();
    }

    if (want(13)) {
      const sold = Object.fromEntries(titles.slice(1).map((t) => [t, { status: 'SOLD', soldOut: true }]));
      const { page, done } = await open(kind, 390, 844, '/', { status: sold });
      await toC2(page);
      await page.locator('.cg-other').click();
      await page.waitForTimeout(300);
      check(/いまはこの 1 点です/.test(await page.locator('.cg2-line').innerText()), T('#13 残り 1 点の「別のにする」で rec_only_one'));
      await shot(page, `${kind}-13-only-one`);
      await done();
      // 「別のにする」を重ねても同じ文が並ばない
      const b = await open(kind, 390, 844, '/');
      await toC2(b.page);
      for (let i = 0; i < 3; i++) { await b.page.locator('.cg-other').click(); await b.page.waitForTimeout(1200); }
      const dup = await b.page.evaluate(() => { const ls = [...document.querySelectorAll('.cg-thread .cg-line')].map((e) => e.textContent); return ls.some((t, i) => i && t === ls[i - 1]); });
      check(!dup, T('#（直せるもの）「別のにする」を重ねても同じ文が並ばない'));
      await b.done();
    }

    if (want(14)) {
      const { page, done } = await open(kind, 390, 844, '/w/harmoney/?from=qr', { grant: true, routes: async (ctx) => {
        await ctx.addInitScript(() => { try { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); } catch {} });
      } });
      await page.locator('#enter').click();
      await page.waitForSelector('#stage:not([hidden])', { timeout: 15000 });
      await toEnd(page);
      await page.locator('.end-band [data-action="save"]').click();
      await page.waitForSelector('.hud-note', { timeout: 3000 });
      check(/コピー/.test(await page.locator('.hud-note').innerText()), T(`#14 共有シートが無い端末でコピーを知らせる（${await page.locator('.hud-note').innerText()}）`));
      await shot(page, `${kind}-14-copied`);
      await done();
    }

    if (want(15)) {
      const { page, done } = await open(kind, 390, 844, '/w/harmoney/', { routes: (ctx) => ctx.route(/assets\/main-.*\.js/, (r) => r.abort()) });
      await page.locator('#enter').click();
      await page.waitForSelector('.actions .page-note', { timeout: 8000 });
      const text = await page.locator('.actions .page-note').innerText();
      check(/読み込み直/.test(text) && !/fetch|import|module/i.test(text), T(`#15 読み込み失敗の文（${text.replace(/\n/g, ' ')}）`));
      check(await page.locator('.page-note-btn').isVisible() && !await page.locator('#enter').isDisabled(), T('#15 再読み込みの案内。「入る」も押せる'));
      await shot(page, `${kind}-15-fail`);
      await done();
    }

    if (want(16)) {
      const { page, done } = await open(kind, 390, 844, '/w/harmoney/', { routes: (ctx) => ctx.route('**/generated/space.json', (r) => r.fulfill({ status: 500, body: '' })) });
      await page.locator('.room img').first().scrollIntoViewIfNeeded();
      await page.locator('.room img').first().click();
      await page.waitForSelector('.rooms .page-note', { timeout: 8000 });
      check(/拡大表示/.test(await page.locator('.rooms .page-note').innerText()), T('#16 部屋の画像を押すと理由を出す'));
      await shot(page, `${kind}-16-rooms-fail`);
      await done();
    }

    if (want(17)) {
      const { ctx, page, done } = await open(kind, 390, 844, '/');
      await toC2(page);
      await ctx.setOffline(true);
      await page.locator('.cg-enter').click();
      await page.waitForFunction(() => /開けません/.test(document.querySelector('.cg2-line')?.textContent || ''), null, { timeout: 12000 }).then(() => check(true, T('#17 オフラインで C2 から入ると留まって知らせる')), () => check(false, T('#17 オフラインで C2 から入ると留まって知らせる')));
      check(page.url().startsWith(base) && await page.locator('.cg-enter').isVisible(), T(`#17 会話を失わない（${page.url().slice(0, 30)}）`));
      await shot(page, `${kind}-17-offline`);
      await ctx.setOffline(false);
      await page.locator('.cg-enter').click();
      await page.waitForSelector('#stage:not([hidden])', { timeout: 20000 });
      check(true, T('#17 通信が戻ればもう一度押せる'));
      await done();
    }

    if (want(18)) {
      const { page, done } = await open(kind, 390, 844, '/', { routes: (ctx) => ctx.route(/assets\/index-.*\.js/, (r) => r.abort()) });
      await page.waitForSelector('.cg-thread .page-note', { timeout: 10000 });
      const text = await page.locator('.cg-thread .page-note').innerText();
      check(/読み込み直/.test(text), T(`#18 受付の部品が読めないと案内（${text.replace(/\n/g, ' ')}）`));
      check(await page.locator('.page-note-btn').isVisible(), T('#18 読み込み直すボタン'));
      await shot(page, `${kind}-18-nojs`);
      await done();
    }

    if (want(20)) {
      const { page, done } = await open(kind, 390, 844, '/w/harmoney/?via=concierge&after=1', { fu: { enabled: true, ai: false } });
      await page.waitForTimeout(800);
      const bad = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('.via-band > span:first-child, .via-links a, .buy-note, .rooms-hint-do, .rooms-hint-note, #buy, .actions .cg-enter-note, .statement [data-lang="ja"]')) {
          if (!el.querySelector('.ph')) out.push(`文節なし:${el.className || el.id}`);
          for (const s of el.querySelectorAll('.ph')) if (s.getBoundingClientRect().height > parseFloat(getComputedStyle(s).lineHeight) * 1.5) out.push(s.textContent);
        }
        return out;
      });
      check(bad.length === 0, T(`#20 文節の途中で折り返さない ${bad.join(' / ')}`));
      await page.locator('.via-band').scrollIntoViewIfNeeded();
      await shot(page, `${kind}-20-band`);
      await page.evaluate(() => document.querySelector('.buy').scrollIntoView());
      await shot(page, `${kind}-20-buy`);
      // 言語を切り替えて戻っても文節のまま
      await page.selectOption('#lang', 'en');
      await page.selectOption('#lang', 'ja');
      check(await page.locator('.buy-note .ph').count() > 0, T('#20 言語を切り替えて戻っても文節のまま'));
      await page.locator('.room img').first().click();
      await page.waitForSelector('.lb');
      check(await page.locator('.lb-body .ph').count() > 0, T('#20 拡大表示の文も文節'));
      await shot(page, `${kind}-20-lb`);
      await done();
      const f = await open(kind, 390, 844, '/w/harmoney/?lang=fr', { lang: 'fr' });
      await f.page.locator('.room img').first().click();
      await f.page.waitForSelector('.lb-head');
      check(/\d \/ \d/.test(await f.page.locator('.lb-head').textContent()), T('#20 fr の「1 / 3」を折り返さない'));
      await f.done();
    }

    if (want(21)) {
      for (const [w, h] of [[390, 844], [375, 667], [768, 1024]]) {
        const { page, done } = await open(kind, w, h, '/w/itadaki/');
        await page.locator('#enter').click();
        await page.waitForSelector('#stage:not([hidden])', { timeout: 15000 });
        await toEnd(page);
        await page.waitForTimeout(1500);
        const r = await page.evaluate(() => {
          const f = document.querySelector('.room-art-frame')?.getBoundingClientRect(); const art = document.querySelector('.room-art .lb-art')?.getBoundingClientRect();
          const band = document.querySelector('.end-band').getBoundingClientRect();
          if (!f || !art) return null;
          const k = f.width / 1586;
          return { doorL: f.left + 1115 * k, doorR: f.left + 1385 * k, doorB: f.top + 770 * k, artL: art.left, artR: art.right, artB: art.bottom, vw: innerWidth, band: band.top };
        });
        check(!!r && r.doorL >= 0 && r.doorR <= r.vw && r.artL >= 0 && r.artR <= r.vw && r.artB <= r.band && r.doorB <= r.band, T(`#21 頂の終わり ${w}×${h}：ドアと絵が両方入る ${JSON.stringify(r && { d: [Math.round(r.doorL), Math.round(r.doorR)], b: [Math.round(r.doorB), Math.round(r.band)] })}`));
        await shot(page, `${kind}-21-itadaki-${w}x${h}`);
        await done();
      }
    }

    if (want(22)) {
      const { page, done } = await open(kind, 390, 844, '/w/harmoney/?via=concierge&after=1', { fu: { enabled: true, ai: false } });
      await page.waitForSelector('.fu', { timeout: 6000 });
      await page.waitForTimeout(1200);
      const o = await page.evaluate(() => { const c = document.querySelector('.fu').getBoundingClientRect(); const band = document.querySelector('.via-band').getBoundingClientRect(); return { band: Math.round(band.bottom), card: Math.round(c.top) }; });
      check(o.band <= o.card, T(`#22 スマホで戻ったカードが帯と説明文に被らない（帯の下 ${o.band}、カードの上 ${o.card}）`));
      await shot(page, `${kind}-22-after`);
      await done();
    }
  }
  for (const b of Object.values(browsers)) await b.close();
}

// 単独で動かすとき
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  let failed = 0;
  await runRegress({
    base: process.env.BASE || 'http://localhost:4173',
    kinds: (opt('--kinds') || 'chromium,webkit').split(','),
    shots: opt('--shots'),
    only: opt('--only') ? opt('--only').split(',').map(Number) : null,
    check: (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failed++; },
  });
  console.log(failed ? `\n${failed} 件の失敗` : '\nすべて通過');
  process.exit(failed ? 1 : 0);
}
