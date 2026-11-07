// 作品ページ / 受付 / ギャラリーの小さなスクリプト。言語の切り替えと「入る」。受付の会話と体験は import() で読む
import { detectLang, rememberLang, applyLang, fillLangSelect, ensureLang, isLangReady, t, type Lang } from './i18n';
import { Soundscape } from './audio/Soundscape';
import { vrAvailable, bandFor } from './concierge/enter';
import { sessionId, createFollowup } from './followup/trigger';
import { setPhrases } from './text/phrases';
import './ui/page.css';

const workId = document.querySelector<HTMLMetaElement>('meta[name="work"]')?.content || null;
let lang: Lang = detectLang();

// 日本語は文節の間だけで改行（docs/DESIGN.md「改行の決まり」）。applyLang が文字を入れ直すので、そのたびに当て直す
const PHRASED = '.via-band > span:first-child, .via-links a, .buy-note, .buy-sold-note, .rooms-hint-do, .rooms-hint-note, .actions .cg-enter-note, #buy, .fu-entry button, .page-note > span, .cg-skip, .cg-data';
const phrasePage = () => document.querySelectorAll<HTMLElement>(PHRASED).forEach((el) => setPhrases(el, lang));
const applyAll = (l: Lang) => { applyLang(document, l); phrasePage(); };
// 日本語・英語はすぐ。ほかの言語は文言を読んでから当てる（英語を一瞬挟まない。読めなければ英語）
function setLang(l: Lang) {
  lang = l; rememberLang(l);
  if (isLangReady(l)) applyAll(l);
  else void ensureLang(l).then(() => { if (lang === l) applyAll(l); });
}
setLang(lang);
const select = document.getElementById('lang') as HTMLSelectElement | null;
if (select) fillLangSelect(select, lang, setLang);

// 作品の一文と物語：日本語の段落は言語の切り替えで文字が入れ直されないので、1 回だけ
document.querySelectorAll<HTMLElement>('.statement [data-lang="ja"], .story [data-lang="ja"]').forEach((el) => setPhrases(el, 'ja'));

// 販売状況：売れた作品に印を付け、購入ボタンを下げる（/api/works-status。取れないときは何もしない。1 点物の決済リンクは Stripe の側で止まる）
const soldTargets = document.querySelectorAll<HTMLElement>('.gw-cap[data-title-ja], .other[data-title-ja]');
const buyBox = document.querySelector<HTMLElement>('.buy[data-title]');
if (soldTargets.length || buyBox) {
  const tag = (s: { status: string }) => {
    const el = document.createElement('span');
    el.className = 'sold-tag';
    el.dataset.i18n = s.status === 'SOLD' ? 'sold_tag' : 'reserved_tag';
    el.textContent = t(el.dataset.i18n, lang);
    return el;
  };
  void fetch('/api/works-status').then((r) => (r.ok ? r.json() : null)).then((d: { statuses?: Record<string, { status: string; soldOut: boolean }> } | null) => {
    const st = d?.statuses;
    if (!st) return;
    soldTargets.forEach((el) => { const s = st[el.dataset.titleJa || '']; if (s?.soldOut) el.appendChild(tag(s)); });
    const s = buyBox && st[buyBox.dataset.title || ''];
    if (buyBox && s?.soldOut) {
      const note = document.createElement('p');
      note.className = 'buy-sold-note'; note.dataset.i18n = 'sold_note'; note.textContent = t('sold_note', lang);
      setPhrases(note, lang);
      buyBox.replaceChildren(tag(s), note);
      document.querySelector('.via-band a[data-action="buy"]')?.remove();
      // 題名の下の「販売中」も同じ状態に（ご予約済み／SOLD）
      const avail = document.querySelector<HTMLElement>('.avail');
      if (avail) { avail.dataset.i18n = s.status === 'SOLD' ? 'sold_tag' : 'reserved_tag'; avail.textContent = t(avail.dataset.i18n, lang); }
    }
  }).catch(() => {});
}

const url = new URL(location.href);
const fromQr = url.searchParams.get('from') === 'qr';
const forceVr = url.searchParams.get('vr') === '1';
const debug = url.searchParams.get('debug') === '1';

// 共有：Web Share API があればそれ、無ければコピー
document.getElementById('share')?.addEventListener('click', async () => {
  const shareUrl = location.origin + location.pathname;
  const title = document.title;
  try {
    if (navigator.share) await navigator.share({ title, url: shareUrl });
    else { await navigator.clipboard.writeText(shareUrl); toast(t('copied', lang)); }
  } catch (e) { if ((e as Error).name !== 'AbortError') toast(t('copy_fail', lang)); }
});

// 失敗の知らせ（文を残す。必要なら読み込み直すボタンも）。同じ場所には 1 つだけ
function showNote(after: Element, msg: string, reload = false) {
  after.parentElement?.querySelector(':scope > .page-note')?.remove();
  const p = document.createElement('p');
  p.className = 'page-note'; p.setAttribute('role', 'alert');
  const s = document.createElement('span'); s.textContent = msg; setPhrases(s, lang);
  p.appendChild(s);
  if (reload) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'page-note-btn'; b.textContent = t('reload', lang);
    b.addEventListener('click', () => location.reload());
    p.appendChild(b);
  }
  after.after(p);
}

function toast(msg: string) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#fff;color:#000;padding:8px 16px;border-radius:999px;font-size:13px;z-index:100';
  document.body.appendChild(el); setTimeout(() => el.remove(), 1800);
}

// 計測（E-14、docs/ADMIN.md）：出来事を送る。会話の文・個人の情報は送らない。匿名 id はタブごと。失敗しても、ブロックされていても何もしない
const statUrl = (document.querySelector<HTMLMetaElement>('meta[name="recommend-api"]')?.content.trim() || '').replace(/\/recommend\/?$/, '/stat') || '/api/stat';
export function stat(ev: string, id: string | null = null, via: string | null = null) {
  try {
    if (matchMedia('(prefers-reduced-data: reduce)').matches) return;
    const body = JSON.stringify({ ev, id, ...(via ? { via } : {}), sid: sessionId(), lang });
    if (navigator.sendBeacon?.(statUrl, body)) return;
    fetch(statUrl, { method: 'POST', body, keepalive: true }).catch(() => {});
  } catch { /* 数えられなくてよい */ }
}

// 「VR でのぞく」は Quest のブラウザだけ（判定は concierge/enter.ts の vrEntryAllowed。受付の C2 と同じ条件）

// 受付（/。docs/ENTRANCE.md 3 節）：会話のコードは import() で読む（体験バンドルは読まない）
// 読み込み前の操作（選択肢 / 送る）は止めておき、読めたらもう一度起こす
const cg = document.getElementById('concierge');
const RELOAD_KEY = 'mtp.cg-reload';
if (cg) {
  // キャラクターは女の子（public/concierge/artist/）に確定（11-06 作家）。画像は HTML のまま
  const retry = url.searchParams.get('retry');
  if (retry) { url.searchParams.delete('retry'); history.replaceState(null, '', url.pathname + url.search + url.hash); }
  const api = document.querySelector<HTMLMetaElement>('meta[name="recommend-api"]')?.content.trim() || null;
  let ready = false, failed = false;
  const hold = (e: Event) => {
    if (ready || failed) return;
    const target = e.target as Element;
    if (e.type === 'submit' || target.closest('button[data-opener-index]')) {
      e.preventDefault(); e.stopImmediatePropagation();
      loading.then(() => { if (!ready) return; if (e.type === 'submit') (target as HTMLFormElement).requestSubmit(); else (target.closest('button') as HTMLButtonElement).click(); });
    }
  };
  cg.addEventListener('click', hold, true);
  cg.addEventListener('submit', hold, true);
  cg.querySelector('a.cg-skip')?.addEventListener('click', () => stat('concierge_skip'));
  // 押した選択肢（文はサーバーがカタログと照合する）と、自由入力があったこと（文は送らない）。hold のあとに登録する（hold が止めた操作は数えない）
  cg.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b.classList.contains('cg-write')) stat('cg_write');
    else if (b.dataset.openerIndex != null) stat('cg_opener', null, (b.innerText || b.textContent || '').trim());
    else if (b.dataset.value) stat('cg_rule', null, b.dataset.value);
  }, true);
  cg.addEventListener('submit', (e) => {
    const input = (e.target as HTMLFormElement).querySelector('input');
    if (input && input.type !== 'password' && input.value.trim()) stat('cg_free');
  }, true);
  const loading = import('./concierge/index').then((m) => {
    m.mountConcierge(cg, { lang, api, configUrl: api ? `${api.replace(/\/$/, '')}/config` : '', catalogUrl: 'catalog.json', retry, stat });
    ready = true;
    try { sessionStorage.removeItem(RELOAD_KEY); } catch {}
  }).catch(async (e) => {
    console.warn('受付を読めない', e);
    // 配置の直後に古い HTML を見ていると、部品の名前が変わって読めない。読み直せば新しい HTML が来るので 1 回だけ試す（通信が切れているときは読み直さない）
    let tried = true;
    try { tried = !!sessionStorage.getItem(RELOAD_KEY); sessionStorage.setItem(RELOAD_KEY, '1'); } catch {}
    if (!tried && navigator.onLine !== false && await fetch(location.href, { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok, () => false)) { location.reload(); return; }
    failed = true;
    await ensureLang(lang);
    const thread = cg.querySelector('.cg-thread');
    if (thread) { showNote(thread.lastElementChild || thread, t('cg_js_fail', lang), true); thread.scrollTop = thread.scrollHeight; }
  });
}

// ギャラリー（/gallery/。docs/ENTRANCE.md 4 節）：おすすめの 1 点（?from=<id>）を最初に、PC はホイールの縦を横に
const wall = document.querySelector<HTMLElement>('.gw-wall');
if (wall) {
  const from = url.searchParams.get('from');
  const item = from ? [...wall.querySelectorAll<HTMLElement>('.gw-item')].find((el) => el.dataset.id === from) : null;
  if (item) {
    wall.prepend(item);
    item.classList.add('is-for-you');
    item.querySelector<HTMLElement>('.gw-foryou')!.hidden = false;
  }
  // 壁を歩く操作と絞り込みは別の部品（受付と作品ページの JS を軽く保つ）
  void import('./gallery').then((m) => m.mountGallery(wall, url, (id) => stat('gallery_pick', id)));
}

// 感想カード（docs/ADMIN.md 3 節）：絵を見たあとに案内役が小さく現れる。本体は必要になってから import()。読めなくても何も起きない
const followup = createFollowup({ stat, lang: () => lang });
followup.listenStoryEnd();

if (workId) {
  stat('work_view', workId, ['concierge', 'gallery'].includes(url.searchParams.get('via') || '') ? url.searchParams.get('via') : 'direct');
  followup.onWorkPage(workId, url.searchParams.get('after') === '1');
  const enter = document.getElementById('enter') as HTMLButtonElement;
  const enterVr = document.getElementById('enter-vr') as HTMLButtonElement;
  // 受付から来たとき（?via=concierge）：絵の下・「入る」の上に細い帯（docs/ENTRANCE.md 3.1）
  // C2 から絵の中に入って戻ってきたとき（&after=1）は「絵の中から戻ってきました」＋「もう一度のぞく」「部屋で見る」「ギャラリー全体を見る」（E-12）
  const rooms = document.querySelector<HTMLElement>('.rooms');
  const buyLink = document.querySelector<HTMLAnchorElement>('a#buy');
  buyLink?.addEventListener('click', () => stat('buy_click', workId));
  const bandDef = bandFor(url.searchParams, !!rooms, !!buyLink);
  if (bandDef) {
    const assetRoot = document.querySelector<HTMLMetaElement>('meta[name="asset-base"]')?.content ?? '../../';
    const band = document.createElement('div');
    band.className = 'via-band';
    band.dataset.kind = bandDef.kind;
    const label = document.createElement('span');
    label.dataset.i18n = bandDef.head; label.textContent = t(bandDef.head, lang);
    const links = document.createElement('span');
    links.className = 'via-links';
    for (const it of bandDef.items) {
      const a = document.createElement('a');
      a.dataset.i18n = it.key; a.textContent = t(it.key, lang);
      a.dataset.action = it.action;
      if (it.action === 'buy' && buyLink) { a.href = buyLink.href; a.target = '_blank'; a.rel = 'noopener'; a.addEventListener('click', () => stat('buy_click', workId)); }
      else if (it.action === 'retry') a.href = `${assetRoot}?retry=${encodeURIComponent(workId)}`;
      else if (it.action === 'gallery') a.href = `${assetRoot}gallery/?from=${encodeURIComponent(workId)}`;
      else {
        // 「もう一度のぞく」「部屋で見る」はページ内の操作（帯の見た目をそろえるため <a> のまま）
        a.href = it.action === 'rooms' ? '#rooms' : '#';
        a.setAttribute('role', 'button');
        a.addEventListener('click', (e) => {
          e.preventDefault();
          if (it.action === 'rooms') rooms?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
          else if (!enter.disabled) start(false);
        });
      }
      links.appendChild(a);
    }
    band.append(label, links);
    document.querySelector('.actions')?.before(band);
    phrasePage();
  }
  // 受付の絵の世界の「部屋で見る」から来たとき（#rooms）：帯が入ったあとの位置で部屋の欄に着く
  if (location.hash === '#rooms' && rooms) {
    const toRooms = () => rooms.scrollIntoView({ block: 'start' });
    toRooms();
    window.addEventListener('load', toRooms, { once: true });
  }
  // .btn の display が hidden 属性を上書きするので、HTML では inline の display:none で隠している（E-12 で判明）
  vrAvailable(forceVr).then((ok) => { if (ok) { enterVr.hidden = false; enterVr.style.display = ''; } });
  const start = async (vr: boolean) => {
    stat('enter', workId, ['concierge', 'gallery'].includes(url.searchParams.get('via') || '') ? url.searchParams.get('via') : 'page');
    document.querySelector('.actions > .page-note')?.remove();
    followup.cover();   // 開いている感想カードは体験の間だけ隠す（書きかけは残す）
    enter.disabled = true; enterVr.disabled = true;
    const label = enter.textContent; enter.textContent = t('loading', lang) + '…';
    // 「入る」のハンドラ内で（ユーザー操作の直後に）：音の許可、声の準備、XR セッションの要求
    const sound = new Soundscape();
    const unlocking = sound.unlock();
    const voiceUrl = enter.dataset.voice;
    if (voiceUrl) { const a = new Audio(voiceUrl); a.muted = true; a.play().then(() => { a.pause(); a.muted = false; }).catch(() => {}); }
    let xrSession: XRSession | null = null;
    if (vr) {
      try { xrSession = await (navigator as Navigator & { xr: XRSystem }).xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] }); }
      catch (e) { console.warn('XR セッションを要求できない', e); }
    }
    try {
      await unlocking;
      const { run } = await import('./experience/main');
      const ended = await run({ workId, lang, vr, fromQr, debug, sound, xrSession, onExit: () => { enter.disabled = false; enterVr.disabled = false; enter.textContent = label; followup.afterExperience(workId); } });
      if (ended === 'rooms') rooms?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch (e) {
      console.error(e);
      enter.disabled = false; enterVr.disabled = false; enter.textContent = label;
      followup.uncover();
      showNote(document.querySelector('.actions > .cg-enter-note') || enter, t('exp_load_fail', lang), true);
    }
  };
  enter.addEventListener('click', () => start(false));
  enterVr.addEventListener('click', () => start(true));
  // 部屋で見る：帯の画像をタップすると拡大表示（寸法線と詳しい説明）。コードと space.json は初めて開くときに読む
  const figs = [...document.querySelectorAll<HTMLElement>('.room[data-room-index]')];
  if (figs.length) {
    const assetBase = document.querySelector<HTMLMetaElement>('meta[name="asset-base"]')?.content ?? '../../';
    let loading: Promise<[unknown, typeof import('./ui/lightbox')]> | null = null;
    const load = () => (loading ||= Promise.all([
      fetch(`${assetBase}works/${workId}/generated/space.json`).then((r) => { if (!r.ok) throw new Error('space.json ' + r.status); return r.json(); }),
      import('./ui/lightbox').then(async (m) => { await ensureLang(lang); return m; }),
    ]).catch((e) => { loading = null; throw e; }));
    const imgs = figs.map((f) => f.querySelector('img')!);
    const hint = document.querySelector('.rooms-hint');
    const open = async (i: number) => {
      try {
        const [space, mod] = await load();
        const sp = space as import('./ui/lightbox').LightboxSpace & { painting?: string };
        // 素の部屋と絵の写真（絵を別の層にしてドラッグで動かす。base が無い古い space.json は合成画像のまま）
        const bases = sp.rooms.map((r) => (r.base ? `${assetBase}${r.base}` : null));
        const painting = sp.painting ? `${assetBase}works/${workId}/generated/${sp.painting}` : undefined;
        followup.cover();
        hint?.parentElement?.querySelector(':scope > .page-note')?.remove();
        mod.openLightbox({ space: sp, srcs: imgs.map((im) => im.currentSrc || im.src), bases, painting, index: i, lang, returnFocus: imgs[i], onClose: () => { followup.uncover(); followup.afterRooms(workId); } });
      } catch (e) {
        console.warn('拡大表示を開けない', e);
        await ensureLang(lang);
        if (hint) showNote(hint, t('rooms_load_fail', lang));   // 通信が戻ればもう一度押せる（load は失敗を覚えない）
      }
    };
    imgs.forEach((im, i) => {
      im.setAttribute('role', 'button'); im.tabIndex = 0;
      im.addEventListener('click', () => open(+figs[i].dataset.roomIndex! || i));
      im.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(i); } });
      im.addEventListener('pointerenter', () => { load().catch(() => {}); }, { once: true });   // ホバーで先に読む
    });
  }
  // 絵をタップ / クリックしても入れる
  const paintingImg = document.querySelector<HTMLImageElement>('.painting img');
  if (paintingImg) {
    paintingImg.style.cursor = 'pointer';
    paintingImg.setAttribute('role', 'button'); paintingImg.tabIndex = 0;
    paintingImg.setAttribute('aria-label', t('enter', lang)); paintingImg.dataset.i18nAttr = 'aria-label:enter';   // 言語を切り替えたら applyLang が訳し直す
    paintingImg.addEventListener('click', () => { if (!enter.disabled) start(false); });
    paintingImg.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !enter.disabled) { e.preventDefault(); start(false); } });
  }
}
