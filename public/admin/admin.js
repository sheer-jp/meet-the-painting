// 管理ページ（docs/ADMIN.md 4 節）。依存なし。受け取った文はすべて textContent で出す（innerHTML を使わない）
// グラフは依存なしのインライン SVG。色は墨の濃淡だけ（docs/DESIGN.md）。どのグラフにも数字の表がある
const app = document.getElementById('app');
const REACTIONS = { love: '好き', curious: '気になる', unsure: 'ちょっと違うかも' };
const PLACES = { story_end: '語りの終わりで', after: '絵の世界から戻って', exit: '絵の世界を閉じて', rooms: '部屋で見たあと', dwell: '作品ページで', link: '自分で開いて' };
const LANGS = { ja: '日本語', en: '英語', 'zh-Hans': '中国語（簡体）', 'zh-Hant': '中国語（繁体）', ko: '韓国語', fr: 'フランス語', de: 'ドイツ語', es: 'スペイン語', it: 'イタリア語', pt: 'ポルトガル語' };
const FROM = { qr: '会場の QR から', online: 'オンライン' };
const RANGES = [['today', '今日'], ['7', '7 日'], ['30', '30 日'], ['all', '全期間']];
const PREV_LABEL = { today: '昨日の同じ時刻まで', 7: '前の 7 日', 30: '前の 30 日' };
const MIN_RATE = 5;
const FB_FIRST = 6;   // 感想のカードを最初に出す数   // 分母がこれより小さいときは割合を出さない（件数だけ）
const SVG_NS = 'http://www.w3.org/2000/svg';

// 要素を作る。文字は textContent だけ
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
}
function s(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

const TZ = 'Asia/Tokyo';
const jstFull = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const jstTime = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const jstMd = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, month: 'numeric', day: 'numeric' });
const jstMdW = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, month: 'long', day: 'numeric', weekday: 'short' });
const jstHm = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const jstH = (t) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(t));
const num = (n) => Number(n || 0).toLocaleString('ja-JP');

class Unauthorized extends Error {}
async function api(path, init) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  if (res.status === 401) throw new Unauthorized();
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error || String(res.status)); e.status = res.status; throw e; }
  return data;
}

// ───── ログイン ─────
function showLogin(notice) {
  const err = h('p', { class: 'err', role: 'alert', text: notice || '' });
  err.hidden = !notice;
  const user = h('input', { id: 'login-id', name: 'username', type: 'text', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next', required: true, maxlength: 512 });
  const pass = h('input', { id: 'login-pw', name: 'password', type: 'password', autocomplete: 'current-password', enterkeyhint: 'go', required: true, maxlength: 512 });
  const send = h('button', { type: 'submit', class: 'login-send', text: 'ログイン' });
  let busy = false;
  const form = h('form', { class: 'login-form', method: 'post', action: '#', onsubmit: async (e) => {
    e.preventDefault();
    if (busy) return;   // 二度押ししない
    if (!user.value.trim() || !pass.value) { (user.value.trim() ? pass : user).focus(); return; }
    busy = true; send.disabled = true; send.textContent = '確かめています'; err.hidden = true;
    try {
      await api('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user.value.trim(), password: pass.value }) });
      pass.value = '';
      void boot();
      return;
    } catch (ex) {
      err.textContent = ex instanceof Unauthorized ? 'ID かパスワードが違います'
        : ex.status === 429 ? '試した回数が多いので、15 分ほど待ってからもう一度お試しください。'
        : 'いまログインできません。時間をおいてもう一度お試しください。';
      err.hidden = false;
      pass.value = '';
      pass.focus();
    }
    busy = false; send.disabled = false; send.textContent = 'ログイン';
  } },
    h('label', { for: 'login-id', text: 'ID' }), user,
    h('label', { for: 'login-pw', text: 'パスワード' }), pass,
    send, err);
  app.replaceChildren(h('div', { class: 'login' },
    h('h1', { text: 'Meet the Painting 管理' }),
    h('p', { text: '作家専用のページです。' }),
    form));
  user.focus();
}

// サーバーの不調を「設定がまだ」と言わない
const showDown = () => app.replaceChildren(h('div', { class: 'login' }, h('h1', { text: 'Meet the Painting 管理' }), h('p', { role: 'alert', text: 'いまサーバーから読み込めません。時間をおいて開き直してください。' }), h('button', { type: 'button', class: 'text-btn', text: 'もう一度読み込む', onclick: () => void boot() })));

async function boot() {
  try {
    const me = await api('/api/admin/me');
    showDashboard(me.name);
  } catch (e) {
    let config = null;
    try { config = await api('/api/admin/config'); } catch { showDown(); return; }
    if (!config?.configured) {
      app.replaceChildren(h('div', { class: 'login' }, h('h1', { text: 'Meet the Painting 管理' }), h('p', { text: '管理ページの設定がまだ終わっていないので、いまは誰も入れません。手順は docs/ADMIN.md 6 節です。' })));
      return;
    }
    if (e instanceof Unauthorized) { showLogin(); return; }
    showDown();
  }
}

// ───── グラフの部品（インライン SVG） ─────

// 目盛りのきりのよい刻み（1・2・5 × 10^k）
function niceStep(max, ticks = 3) {
  if (max <= ticks) return 1;
  const raw = max / ticks, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw);
}

// 吹き出し（ホバーとフォーカスで出す。値が主、名前が従）。同じ数字は表にもある
function tooltip(wrap) {
  const tip = h('div', { class: 'tip', role: 'status' });
  tip.hidden = true;
  wrap.append(tip);
  return {
    show(ev, title, rows) {
      tip.replaceChildren(h('span', { class: 'tip-title', text: title }), ...rows.map(([label, value, key]) => h('span', { class: 'tip-row' }, key ? h('i', { class: `key ${key}` }) : '', h('b', { text: value }), label)));
      tip.hidden = false;
      const box = wrap.getBoundingClientRect();
      const r = ev?.currentTarget?.getBoundingClientRect?.();
      const cx = ev && 'clientX' in ev && ev.clientX ? ev.clientX : r ? r.left + r.width / 2 : box.left;
      const cy = ev && 'clientY' in ev && ev.clientY ? ev.clientY : r ? r.top : box.top;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(cx - box.left - tw / 2, box.width - tw))}px`;
      tip.style.top = `${Math.max(0, cy - box.top - tip.offsetHeight - 12)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

// 上だけ角の丸い棒（下は基線に揃えて四角）
function topRounded(x, y, w, hgt, r) {
  r = Math.min(r, w / 2, hgt);
  return `M${x} ${y + hgt}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + hgt}Z`;
}

/**
 * 縦棒（積み上げ可）。series は下から順。棒は 24px まで、段の間に 2px の白
 * @param {{ width: number, height?: number, n: number, series: { name: string, cls: string, values: number[] }[], tick: (i: number) => string|null, title: (i: number) => string, label: string }} o
 */
function columns(o) {
  const H = o.height ?? 150, PADL = 30, PADB = 22, PADT = 10, W = Math.max(200, o.width);
  const plotW = W - PADL - 4, plotH = H - PADB - PADT;
  const totals = Array.from({ length: o.n }, (_, i) => o.series.reduce((a, x) => a + (x.values[i] || 0), 0));
  const step = niceStep(Math.max(1, ...totals));
  const top = Math.max(step, Math.ceil(Math.max(1, ...totals) / step) * step);
  const yOf = (v) => PADT + plotH - (v / top) * plotH;
  const band = plotW / o.n;
  const bw = Math.max(2, Math.min(24, band * 0.66));
  const wrap = h('div', { class: 'chart' });
  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.label });
  for (let v = 0; v <= top; v += step) {
    svg.append(s('line', { class: v ? 'grid' : 'base', x1: PADL, x2: W - 4, y1: yOf(v), y2: yOf(v) }));
    svg.append(s('text', { class: 'tick', x: PADL - 6, y: yOf(v) + 4, 'text-anchor': 'end' }, num(v)));
  }
  const tip = tooltip(wrap);
  for (let i = 0; i < o.n; i++) {
    const x = PADL + i * band + (band - bw) / 2;
    let y = yOf(0);
    const parts = o.series.map((x) => x.values[i] || 0);
    const last = parts.reduce((a, v, k) => (v > 0 ? k : a), -1);
    parts.forEach((v, k) => {
      if (!v) return;
      const hgt = (v / top) * plotH;
      const gap = k > 0 && parts.slice(0, k).some((p) => p > 0) ? 2 : 0;   // 下の段との間に 2px の白
      const segH = Math.max(1, hgt - gap);
      y -= hgt;
      svg.append(k === last ? s('path', { class: `bar ${o.series[k].cls}`, d: topRounded(x, y, bw, segH, 4) }) : s('rect', { class: `bar ${o.series[k].cls}`, x, y, width: bw, height: segH }));
    });
    const t = o.tick(i);
    if (t) svg.append(s('text', { class: 'tick', x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' }, t));
    // 当たりは棒より広く、帯の全体
    const hit = s('rect', { class: 'hit', x: PADL + i * band, y: PADT, width: band, height: plotH });
    const rows = () => [...(o.series.length > 1 ? [['計', num(totals[i])]] : []), ...o.series.map((x) => [x.name, num(x.values[i] || 0), x.cls])];
    const on = (ev) => { hit.classList.add('on'); tip.show(ev, o.title(i), rows()); };
    const off = () => { hit.classList.remove('on'); tip.hide(); };
    hit.addEventListener('pointerenter', on); hit.addEventListener('pointermove', on); hit.addEventListener('pointerleave', off);
    svg.append(hit);
  }
  wrap.prepend(svg);
  return wrap;
}

// スパークライン（タイルの小さな線）。線は墨の淡い色、終わりの点だけ墨
function sparkline(values, label) {
  const W = 120, H = 28, n = values.length;
  const svg = s('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [n === 1 ? W : (i / (n - 1)) * W, H - 2 - (v / max) * (H - 4)]);
  if (n === 1) pts.unshift([0, pts[0][1]]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  svg.append(s('path', { class: 'spark-area', d: `${d}L${W} ${H}L0 ${H}Z` }));
  svg.append(s('path', { class: values.some((v) => v > 0) ? 'spark-line' : 'spark-line flat', d, 'vector-effect': 'non-scaling-stroke' }));
  svg.append(s('title', {}, label));
  return svg;
}

// 横棒の並び（上位 n 件。残りは開いて見る）
function barList(title, items, { limit = 6, label = (x) => x, muted = () => false, empty, note } = {}) {
  const row = (x, max) => h('div', { class: `hbar${muted(x.label) ? ' muted' : ''}` }, h('span', { class: 'hbar-label', text: label(x.label) }), h('span', { class: 'hbar-val', text: num(x.n) }), meter(x.n / max));
  const box = h('div', { class: 'bars' }, h('h3', { text: title }));
  if (!items.length) { box.append(h('p', { class: 'empty small', text: empty })); return box; }
  const max = items[0].n || 1;
  box.append(...items.slice(0, limit).map((x) => row(x, max)));
  if (items.length > limit) box.append(h('details', { class: 'all' }, h('summary', { text: `残り ${items.length - limit} 件を見る` }), items.slice(limit).map((x) => row(x, max))));
  if (note) box.append(h('p', { class: 'note', text: note }));
  return box;
}
// 細い横棒（CSP の style-src 'self' でも効く CSSOM で幅を入れる）
function meter(ratio, cls = '') {
  const i = h('i', {});
  i.style.width = `${Math.max(0, Math.min(1, ratio || 0)) * 100}%`;
  if (ratio > 0) i.style.minWidth = '2px';
  return h('span', { class: `meter ${cls}` }, i);
}
// 数字の表（グラフの代わりに読める版）。列は少なく、横にはみ出さない
function tableView(summary, head, rows) {
  return h('details', { class: 'all' }, h('summary', { text: summary }), h('table', { class: 'num-table' },
    h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col', text: t })))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h(i ? 'td' : 'th', i ? { text: String(c) } : { scope: 'row', text: String(c) })))))));
}

// ───── ダッシュボード ─────
function showDashboard(name) {
  const state = { range: '7', work: '', reaction: '', sort: 'recommended', works: [], titles: new Map(), thumbs: new Map(), data: null };
  const rangeNote = h('span', { class: 'range-note' });
  const period = h('div', { class: 'period', role: 'group', 'aria-label': '期間' }, RANGES.map(([v, label]) => h('button', {
    type: 'button', 'data-range': v, 'aria-pressed': String(v === state.range), text: label,
    onclick: () => { if (state.range === v) return; state.range = v; period.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === v))); void load(); },
  })));
  const notice = h('div');
  const tiles = h('div', { class: 'tiles' }, h('p', { class: 'msg', text: '読み込んでいます' }));
  const funnelBox = h('div');
  const trendBox = h('div');
  const workBox = h('div');
  const fbSummary = h('p', { class: 'sub' });
  const fbBox = h('div');
  const talkBox = h('div');
  const flowBox = h('div');
  const workSel = h('select', { 'aria-label': '絵で絞り込む', onchange: () => { state.work = workSel.value; void loadFeedback(); } });
  const reactSel = h('select', { 'aria-label': '反応で絞り込む', onchange: () => { state.reaction = reactSel.value; void loadFeedback(); } },
    h('option', { value: '', text: 'すべて' }), Object.entries(REACTIONS).map(([v, t]) => h('option', { value: v, text: t })));

  const dash = h('main', { class: 'dash' },
    h('section', { id: 'summary', class: 'panel', 'aria-label': '要点' }, tiles),
    h('div', { class: 'row-a' },
      h('section', { id: 'funnel', class: 'panel' }, h('h2', { text: '受付からの流れ' }), funnelBox),
      h('section', { id: 'trend', class: 'panel' }, h('h2', { text: '訪れた人の推移' }), trendBox)),
    h('section', { id: 'works', class: 'panel' }, h('h2', { text: '絵ごと' }), h('p', { class: 'sub', text: '「すすめた」は案内役がすすめた回数、「ギャラリーで選ばれた」はギャラリーで選ばれた回数。「作品ページ」は開かれた回数の全部で、「会場の QR」はそのうち展示の会場で絵の横の QR から開いた回数です。棒はその列のいちばん多い絵との比べです。' }), workBox,
      // 会場に掛けるキャプション（QR 付き。A4 に 6 枚）。公開サイトのナビからはリンクしない（/exhibit/ は noindex）
      h('p', { class: 'print-link' }, h('a', { href: '/exhibit/', target: '_blank', rel: 'noopener', text: '展示用のキャプションを印刷' }))),
    h('section', { id: 'fb', class: 'panel' }, h('h2', { text: '届いた感想' }), fbSummary,
      h('div', { class: 'filters' }, h('label', {}, '絵', workSel), h('label', {}, '反応', reactSel)), fbBox),
    h('section', { id: 'talk', class: 'panel' }, h('h2', { text: '会話' }), h('p', { class: 'sub', text: '案内役は問いを言い換えるので、用意した問いのうち近いものにまとめています。受付で自由に書いた文は保存していません。' }), talkBox,
      h('h3', { class: 'h3-gap', text: '会話の流れ' }), h('p', { class: 'sub', text: '受付で話した会話が、どこを通ってどこまで進んだか。1 つの会話につき、いちばん先まで進んだところで数えます。' }), flowBox),
  );
  app.replaceChildren(
    h('header', { class: 'top' }, h('h1', { text: 'Meet the Painting 管理' }), h('span', { class: 'who', text: name }),
      h('button', { type: 'button', class: 'text-btn', text: 'ログアウト', onclick: async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); location.reload(); } })),
    h('div', { class: 'controls' }, period, rangeNote),
    notice, dash,
  );

  const unauthorized = async () => { const c = await api('/api/admin/config').catch(() => null); if (c?.configured) showLogin('ログインの期限が切れました。もう一度ログインしてください。'); };
  const name_ = (id) => state.titles.get(id) || id;

  // 期間を続けて切り替えたとき、古い応答で上書きしない。読み直しの間は前の表示を薄く残す
  let loadSeq = 0, fbSeq = 0;
  async function load() {
    const my = ++loadSeq;
    dash.classList.add('is-loading');
    try {
      const d = await api(`/api/admin/summary?range=${state.range}`);
      if (my !== loadSeq) return;
      state.data = d;
      state.works = d.catalog || [];
      state.titles = new Map(state.works.map((w) => [w.id, w.title]));
      state.thumbs = new Map(state.works.map((w) => [w.id, { thumb: w.thumb || w.image, image: w.image, url: w.url }]));
      const cur = state.work;
      workSel.replaceChildren(h('option', { value: '', text: 'すべて' }), state.works.map((w) => h('option', { value: w.id, text: w.title })));
      workSel.value = cur;
      renderAll(d);
      await loadFeedback();
    } catch (e) {
      if (my !== loadSeq) return;
      if (e instanceof Unauthorized) return unauthorized();
      notice.replaceChildren(h('p', { class: 'notice', role: 'alert', text: '読み込めませんでした。時間をおいて開き直してください。' }));
    } finally {
      if (my === loadSeq) dash.classList.remove('is-loading');
    }
  }
  function renderAll(d) {
    renderRange(d.bounds);
    renderNotice(d);
    renderTiles(d);
    renderFunnel(d.funnel);
    renderTrend(d);
    renderWorks(d.works);
    renderFbSummary(d);
    renderTalk(d);
    renderFlow(d.flow);
  }

  // 幅が変わったら、幅で描くグラフだけ描き直す
  let lastW = 0, raf = 0;
  new ResizeObserver(() => {
    const w = dash.clientWidth;
    if (!state.data || Math.abs(w - lastW) < 8) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { renderTrend(state.data); renderFlow(state.data.flow); });
  }).observe(dash);

  function renderRange(b) {
    const end = jstMd.format(b.until);
    rangeNote.textContent = b.unit === 'hour' ? `${end} 0:00〜${jstHm.format(b.until)}（日本時間）`
      : b.unit === 'day' ? `${jstMd.format(b.since)}〜${end}（日本時間）`
      : `出来事は 180 日分（それより古いものは消えます）。感想は全部`;
  }
  function renderNotice(d) {
    notice.replaceChildren(
      d.db === false ? h('p', { class: 'notice', text: '保存先（Cloudflare D1）がまだつながっていないので、感想も出来事も届きません。手順は docs/ADMIN.md 6 節です。作品の一覧だけ出しています。' }) : '',
      d.truncated ? h('p', { class: 'notice', text: '出来事が多いので、古い順に 5 万件までで集計しています。期間を短くすると正確になります。' }) : '',
    );
  }

  // ───── 要点のタイル ─────
  function renderTiles(d) {
    const t = d.totals, p = d.prev, sr = d.series;
    // 今日のスパークラインは、いまの時刻まで
    const upto = d.bounds.unit === 'hour' ? jstH(d.bounds.until) + 1 : sr.start.length;
    const cut = (a) => a.slice(0, upto);
    const defs = [
      ['started', '受付を始めた', t.conversations, p?.conversations, sr.starts],
      ['entered', '絵の世界へ', t.entered, p?.entered, sr.entered],
      ['online', '作品ページ（オンライン）', t.views - t.qr, p ? p.views - p.qr : null, sr.viewsOnline],
      ['qr', '会場の QR から', t.qr, p?.qr, sr.viewsQr],
      ['feedback', '届いた感想', t.feedback, p?.feedback, sr.feedback],
      ['buys', '購入リンク', t.buys, p?.buys, sr.buys],
    ];
    tiles.replaceChildren(...defs.map(([key, label, n, prev, series]) => {
      let delta;
      if (prev == null) delta = h('span', { class: 'delta none' });   // 全期間は前の期間がない
      else {
        const diff = n - prev;
        const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '±';
        delta = h('span', { class: 'delta' }, h('b', { text: `${arrow}${num(Math.abs(diff))}` }), h('span', { text: `${PREV_LABEL[d.range]}は ${num(prev)}` }));
      }
      return h('div', { class: 'tile', 'data-key': key },
        h('span', { class: 'tile-label', text: label }),
        h('b', { class: 'tile-value', text: num(n) }),
        delta,
        sparkline(cut(series), `${label}の${d.bounds.unit === 'hour' ? '時間' : d.bounds.unit === 'week' ? '週' : '日'}ごとの数`));
    }));
  }

  // ───── 受付からの流れ（ファネル） ─────
  function renderFunnel(f) {
    const steps = f.steps;
    if (!steps[0].n) { funnelBox.replaceChildren(h('p', { class: 'empty', text: 'この期間に受付で話した人はいません。' })); return; }
    const first = steps[0].n;
    const list = h('ol', { class: 'funnel' }, steps.map((st, i) => {
      const prev = i ? steps[i - 1].n : null;
      const rate = i && prev >= MIN_RATE ? `${Math.round((st.n / prev) * 100)}%` : null;
      return h('li', { class: 'fn' },
        i ? h('span', { class: 'fn-rate', text: rate ? `↓ ${rate} が進んだ` : prev ? '↓' : '' }) : '',
        h('span', { class: 'fn-label', text: st.label }), h('b', { class: 'fn-n', text: num(st.n) }),
        meter(st.n / first, 'thick'));
    }));
    funnelBox.replaceChildren(list,
      h('p', { class: 'note', text: `1 つの会話（タブ）が、前の段を通ってその段まで進んだ数です。絵の世界・作品ページ・購入は、すすめた絵について数えます。前の段が ${MIN_RATE} 件より少ないときは割合を出しません。` }),
      f.viewedOnly ? h('p', { class: 'note', text: `おすすめの絵の作品ページだけを見て、絵の世界には入らなかった会話：${num(f.viewedOnly)}` }) : '');
  }

  // ───── 訪れた人の推移と時間帯 ─────
  function bucketTitle(b, t) {
    if (b.unit === 'hour') return `${jstH(t)} 時台`;
    if (b.unit === 'day') return jstMdW.format(t);
    return `${jstMd.format(t)}〜${jstMd.format(t + 6 * 86400_000)} の週`;
  }
  function renderTrend(d) {
    const b = d.bounds, sr = d.series, t = d.totals;
    const n = sr.start.length;
    const width = Math.max(240, trendBox.clientWidth || 600);
    const head = h('p', { class: 'trend-head' }, h('b', { class: 'big', text: num(t.visits) }), ' 人（タブ）', h('span', { class: 'sub-inline', text: `うち会場の QR から ${num(t.qrVisits)}` }));
    const legend = h('p', { class: 'legend' }, h('span', {}, h('i', { class: 'key online' }), 'オンライン'), h('span', {}, h('i', { class: 'key qr' }), '会場の QR から'));
    if (!t.visits) { trendBox.replaceChildren(h('p', { class: 'empty', text: 'この期間に訪れた人はいません。' })); return; }
    const tick = (i) => {
      if (b.unit === 'hour') return i % 6 === 0 ? `${i}時` : null;
      if (b.unit === 'day') return n <= 7 || (n - 1 - i) % 7 === 0 ? jstMd.format(sr.start[i]) : null;
      return (n - 1 - i) % 4 === 0 ? jstMd.format(sr.start[i]) : null;
    };
    const unitJa = b.unit === 'hour' ? '時間' : b.unit === 'week' ? '週' : '日';
    const chart = columns({
      width, height: 170, n, tick, title: (i) => bucketTitle(b, sr.start[i]),
      label: `${unitJa}ごとの訪れた人。オンラインと会場の QR を積み上げ。合計 ${t.visits}。数字は下の表にあります。`,
      series: [{ name: 'オンライン', cls: 'online', values: sr.visitsOnline }, { name: '会場の QR から', cls: 'qr', values: sr.visitsQr }],
    });
    const rows = sr.start.map((st, i) => [bucketTitle(b, st), sr.visitsOnline[i], sr.visitsQr[i], sr.visitsOnline[i] + sr.visitsQr[i]]).filter((r) => b.unit !== 'hour' || r[3] > 0);
    const parts = [head, legend, chart, h('p', { class: 'note', text: `1 つのタブを 1 人として、その期間に最初に来た${unitJa}で数えます。作品ページを会場の QR から開いたタブは「会場の QR から」。` }), tableView('数字の表で見る', [unitJa, 'オンライン', '会場の QR', '計'], rows)];
    // 時間帯（今日はすでに時間ごとなので出さない）
    if (b.unit !== 'hour') {
      const hours = d.hours;
      parts.push(h('h3', { class: 'h3-gap', text: '時間帯（日本時間）' }),
        columns({ width, height: 110, n: 24, tick: (i) => (i % 6 === 0 ? `${i}時` : null), title: (i) => `${i} 時台`, label: '時間帯ごとの訪れた人（最初に来た時刻）。数字は下の表にあります。', series: [{ name: '訪れた人', cls: 'online', values: hours }] }),
        tableView('時間帯の表で見る', ['時', '人'], hours.map((v, i) => [`${i} 時台`, v]).filter((r) => r[1] > 0)));
    }
    trendBox.replaceChildren(...parts);
  }

  // ───── 絵ごと ─────
  const COLS = [['recommended', 'すすめた'], ['picked', 'ギャラリーで選ばれた'], ['entered', '絵の世界へ'], ['views', '作品ページ'], ['qr', '会場の QR'], ['feedback', '感想'], ['buys', '購入リンク']];
  function thumb(id, size) {
    const t = state.thumbs.get(id);
    if (!t?.thumb) return h('span', { class: 'thumb none' });
    const img = h('img', { class: 'thumb', src: `/${t.thumb}`, alt: '', loading: 'lazy', decoding: 'async', width: size, height: size });
    img.addEventListener('error', () => { if (t.image && !img.src.endsWith(t.image)) img.src = `/${t.image}`; }, { once: true });
    return img;
  }
  function renderWorks(works) {
    if (!works.length) { workBox.replaceChildren(h('p', { class: 'empty', text: '作品のカタログを読めませんでした。' })); return; }
    const max = Object.fromEntries(COLS.map(([k]) => [k, Math.max(0, ...works.map((w) => w[k] || 0))]));
    const order = new Map(state.works.map((w, i) => [w.id, i]));
    const sorted = [...works].sort((a, b) => (b[state.sort] || 0) - (a[state.sort] || 0) || (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
    const allZero = works.every((w) => COLS.every(([k]) => !w[k]));
    const setSort = (k) => { state.sort = k; renderWorks(works); workBox.querySelector(`[data-sort="${k}"]`)?.focus(); };
    const sel = h('select', { 'aria-label': '並べ替え', onchange: () => { state.sort = sel.value; renderWorks(works); } }, COLS.map(([k, l]) => h('option', { value: k, text: `${l}の多い順` })));
    sel.value = state.sort;
    const head = h('div', { class: 'wk-head' }, h('span', { text: '絵' }), COLS.map(([k, l]) => h('button', {
      type: 'button', 'data-sort': k, 'aria-pressed': String(k === state.sort), 'aria-label': `${l}の多い順に並べる`, class: k === state.sort ? 'on' : null, text: l, onclick: () => setSort(k),
    })));
    workBox.replaceChildren(
      h('div', { class: 'wk-sort' }, h('label', {}, '並べ替え', sel)),
      allZero ? h('p', { class: 'empty small', text: 'この期間に、どの絵にもまだ数がありません。' }) : '',
      h('div', { class: 'wk' }, head, sorted.map((w) => {
        const t = state.thumbs.get(w.id);
        return h('div', { class: 'wk-row' },
          h('div', { class: 'wk-work' }, thumb(w.id, 48), t?.url ? h('a', { href: `/${t.url}`, target: '_blank', rel: 'noopener', text: name_(w.id) }) : h('span', { text: name_(w.id) })),
          COLS.map(([k, l]) => h('div', { class: `wk-cell${k === state.sort ? ' on' : ''}${w[k] ? '' : ' zero'}` },
            h('span', { class: 'wk-label', text: l }), h('b', { text: num(w[k]) }), meter(max[k] ? (w[k] || 0) / max[k] : 0))));
      })));
  }

  // ───── 届いた感想 ─────
  function renderFbSummary(d) {
    const t = d.totals;
    const r = (d.reactions || []).map((x) => `${REACTIONS[x.label] || x.label} ${num(x.n)}`).join('・');
    fbSummary.textContent = `訪れた人が「作家に届ける」を押した文だけです。新しい順、日時は日本時間。${t.feedback ? `この期間 ${num(t.feedback)} 件${r ? `（${r}）` : ''}。` : ''}${d.range === 'all' ? '' : '全期間を選ぶと、消していない感想が全部出ます。'}`;
  }
  async function loadFeedback(before) {
    const q = new URLSearchParams({ range: state.range });
    if (state.work) q.set('work', state.work);
    if (state.reaction) q.set('reaction', state.reaction);
    if (before) q.set('before', before);
    const my = ++fbSeq;
    try {
      const d = await api(`/api/admin/feedback?${q}`);
      if (my !== fbSeq) return;
      renderFeedback(d, !!before);
    } catch (e) {
      if (my !== fbSeq) return;
      if (e instanceof Unauthorized) return unauthorized();
      fbBox.replaceChildren(h('p', { class: 'notice', role: 'alert', text: '感想を読み込めませんでした。' }));
    }
  }
  const fbList = h('div', { class: 'fb-list' });
  function renderFeedback(d, append) {
    if (!append) { fbList.replaceChildren(); fbBox.replaceChildren(); selected.clear(); }
    fbBox.querySelector('.more')?.remove();
    if (!d.items.length && !append) {
      fbBox.append(h('p', { class: 'empty', text: state.work || state.reaction ? 'この条件の感想はありません。' : 'この期間に届いた感想はまだありません。' }));
      return;
    }
    if (!append) fbBox.append(bulkBox, fbList);
    updateBulk();
    const cards = d.items.map(feedbackItem);
    // 最初は新しい 6 件だけ。残りはボタンで開く（スマホでページが長くなりすぎないように）
    const rest = append ? [] : cards.slice(FB_FIRST);
    rest.forEach((c) => { c.hidden = true; });
    fbList.append(...cards);
    if (rest.length) {
      const open = h('button', { type: 'button', class: 'more', text: `残り ${rest.length} 件の感想を見る`, onclick: () => { rest.forEach((c) => { c.hidden = false; }); open.remove(); if (d.next) fbBox.append(more); } });
      fbBox.append(open);
    }
    const more = h('button', { type: 'button', class: 'more', text: 'もっと見る', onclick: () => loadFeedback(d.next) });
    if (d.next && !rest.length) fbBox.append(more);
  }
  // 選んでまとめて消す（荒らしの片付け）。消す前に件数を見せて確かめる
  const selected = new Map();   // id → 感想の要素
  const bulkMsg = h('span', { class: 'warn' });
  const bulkBtn = h('button', { type: 'button', class: 'text-btn', text: '選んだ感想を消す', onclick: () => confirmBulk() });
  const bulkBox = h('div', { class: 'fb-bulk' }, bulkMsg, bulkBtn);
  function updateBulk() {
    bulkBox.hidden = selected.size === 0;
    bulkMsg.textContent = selected.size ? `${selected.size} 件を選んでいます` : '';
    bulkBox.replaceChildren(bulkMsg, bulkBtn);
  }
  function confirmBulk() {
    const n = selected.size;
    bulkMsg.textContent = `${n} 件を消します。元に戻せません。`;
    const sure = h('button', { type: 'button', class: 'text-btn danger', text: '消す', onclick: async () => {
      sure.disabled = true;
      let failed = 0;
      for (const [id, box] of [...selected]) {
        try {
          await api(`/api/admin/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' });
          box.remove(); selected.delete(id);
        } catch (e) {
          if (e instanceof Unauthorized) return unauthorized();
          failed++;
        }
      }
      updateBulk();
      if (failed) { bulkMsg.textContent = `${failed} 件を消せませんでした。`; bulkBox.hidden = false; }
      void refreshAfterDelete();
    } });
    bulkBox.replaceChildren(bulkMsg, sure, h('button', { type: 'button', class: 'text-btn', text: 'やめる', onclick: updateBulk }));
    sure.focus();
  }
  function feedbackItem(it) {
    const actions = h('div', { class: 'fb-actions' });
    const box = h('article', { class: 'fb' },
      h('div', { class: 'fb-head' }, thumb(it.work_id, 48),
        h('div', { class: 'fb-who' }, h('b', { text: name_(it.work_id) }), h('time', { datetime: new Date(it.created_at).toISOString(), text: jstFull.format(it.created_at) }))),
      it.body ? h('p', { class: 'fb-body', text: it.body }) : h('p', { class: 'fb-body none', text: '（文はなし。反応だけ）' }),
      h('p', { class: 'fb-meta' },
        it.reaction ? h('span', { class: 'fb-reaction', text: REACTIONS[it.reaction] || it.reaction }) : '',
        it.from ? h('span', { class: `fb-from ${it.from}`, text: FROM[it.from] }) : '',
        h('span', { text: LANGS[it.lang] || it.lang }), h('span', { text: PLACES[it.place] || it.place })),
      actions);
    const pick = h('input', { type: 'checkbox', 'aria-label': '消す感想に選ぶ', onchange: () => { if (pick.checked) selected.set(it.id, box); else selected.delete(it.id); updateBulk(); } });
    const normal = () => actions.replaceChildren(
      h('label', { class: 'fb-pick' }, pick, '選ぶ'),
      it.sid ? h('button', { type: 'button', class: 'text-btn', text: 'この人の流れを見る', onclick: (e) => toggleJourney(box, it.sid, e.currentTarget) }) : '',
      h('button', { type: 'button', class: 'text-btn', text: '削除', onclick: confirmDelete }),
    );
    const confirmDelete = () => {
      const sure = h('button', { type: 'button', class: 'text-btn danger', text: '消す', onclick: async () => {
        sure.disabled = true;
        try {
          await api(`/api/admin/feedback/${encodeURIComponent(it.id)}`, { method: 'DELETE' });
          box.remove();
          selected.delete(it.id); updateBulk();
          void refreshAfterDelete();
        } catch (e) {
          if (e instanceof Unauthorized) return unauthorized();
          actions.replaceChildren(h('span', { class: 'warn', role: 'alert', text: '消せませんでした。' }), h('button', { type: 'button', class: 'text-btn', text: '戻る', onclick: normal }));
        }
      } });
      actions.replaceChildren(h('span', { class: 'warn', text: 'この感想を消します。元に戻せません。' }), sure, h('button', { type: 'button', class: 'text-btn', text: 'やめる', onclick: normal }));
      sure.focus();
    };
    normal();
    return box;
  }
  async function refreshAfterDelete() {
    const d = await api(`/api/admin/summary?range=${state.range}`).catch(() => null);
    if (d) { state.data = d; renderTiles(d); renderWorks(d.works); renderFbSummary(d); }
    if (!fbList.querySelector('.fb')) void loadFeedback();
  }
  async function toggleJourney(box, sid, btn) {
    const open = box.querySelector('.journey');
    if (open) { open.remove(); btn.textContent = 'この人の流れを見る'; return; }
    btn.textContent = '流れを閉じる';
    const list = h('ol', { class: 'journey' });
    box.append(list);
    try {
      const d = await api(`/api/admin/journey?sid=${encodeURIComponent(sid)}`);
      list.replaceChildren(...(d.items.length ? d.items.map((e) => h('li', {}, h('time', { text: jstTime.format(e.at) }), e.text)) : [h('li', { text: '記録が残っていません（出来事は 180 日で消えます）。' })]));
    } catch { list.replaceChildren(h('li', { text: '読み込めませんでした。' })); }
  }

  // ───── 会話：問いと選択肢、言語 ─────
  function renderTalk(d) {
    const isOther = (l) => l.startsWith('その他');
    const t = d.totals;
    talkBox.replaceChildren(h('div', { class: 'bars-grid' },
      barList('よく押された選択肢', d.openers, { muted: isOther, empty: 'この期間に押された選択肢はありません。', note: `自分のことばで書いた：${num(t.free)} 回（文は保存していません）　「別のにする」：${num(t.others)} 回` }),
      barList('使われた問い', d.questions, { muted: isOther, empty: 'この期間に使われた問いはありません。' }),
      barList('言語（訪れたタブの数）', d.langs, { label: (l) => LANGS[l] || l, empty: 'この期間の記録はありません。' }),
    ));
  }

  // ───── 会話の流れ。広い画面は Sankey（依存なしの SVG）、狭い画面は段ごとの横棒 ─────
  function renderFlow(flow) {
    if (!flow.total) { flowBox.replaceChildren(h('p', { class: 'empty', text: 'この期間の会話はまだありません。受付で話した人が来ると、ここに流れが出ます。' })); return; }
    const COLS_T = flow.columns.map((c) => c.title);
    const pct = (n) => (flow.total >= MIN_RATE ? `（${Math.round((n / flow.total) * 100)}%）` : '');
    const list = h('details', { class: 'all' }, h('summary', { text: '流れを数字で見る' }), h('ol', { class: 'flow-list' },
      flow.links.map((l) => h('li', {}, h('span', { text: `${COLS_T[l.col]}：${name_(l.from)} → ${COLS_T[l.col + 1]}：${name_(l.to)}` }), h('b', { text: num(l.n) })))));
    const width = flowBox.clientWidth || 0;
    if (width < 840) {
      // 段ごとの横棒（スマホ・タブレット縦）。割合は会話の合計に対して
      // 最初のことばと問いは上の横棒と同じなので、すすめた絵とどこまで進んだかだけ。つながりは「流れを数字で見る」に全部ある
      flowBox.replaceChildren(h('p', { class: 'trend-head' }, h('b', { class: 'big', text: num(flow.total) }), ' 会話'), h('div', { class: 'stages' }, flow.columns.map((c, i) => i < 2 ? '' : h('div', { class: 'stage' },
        h('h4', { text: c.title }),
        c.nodes.map((n) => h('div', { class: `hbar${n.label.startsWith('その他') ? ' muted' : ''}` }, h('span', { class: 'hbar-label', text: name_(n.label) }), h('span', { class: 'hbar-val', text: `${num(n.n)}${pct(n.n)}` }), meter(n.n / flow.total)))))), list);
      return;
    }
    const COL_W = 9, ROW_GAP = 12, MIN_ROW = 20, TOP = 34;
    const W = Math.min(1100, width);
    const LEFT = 196, RIGHT = 150;
    const inner = W - LEFT - RIGHT - COL_W;
    const xs = flow.columns.map((_, i) => LEFT + (inner * i) / (flow.columns.length - 1));
    const k = 260 / flow.total;   // 1 会話あたりの太さ
    const rect = new Map();
    let height = 0;
    flow.columns.forEach((col, ci) => {
      let y = TOP;
      for (const n of col.nodes) {
        const hgt = Math.max(2, n.n * k);
        rect.set(`${ci}|${n.label}`, { x: xs[ci], y, h: hgt, out: 0, in: 0, n: n.n, label: n.label, ci });
        y += Math.max(hgt, MIN_ROW) + ROW_GAP;
      }
      height = Math.max(height, y);
    });
    const H = height + 4;
    const svg = s('svg', { class: 'flow', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `会話の流れ。合計 ${flow.total} 会話。数字は下にあります。` });
    const wrap = h('div', { class: 'chart' }, svg);
    const tip = tooltip(wrap);
    flow.columns.forEach((col, i) => svg.append(s('text', { class: 'col', x: i === 0 ? xs[i] + COL_W : xs[i], y: 14, 'text-anchor': i === 0 ? 'end' : 'start' }, col.title)));
    const ribbons = [];
    for (const l of flow.links) {
      const a = rect.get(`${l.col}|${l.from}`), b = rect.get(`${l.col + 1}|${l.to}`);
      if (!a || !b) continue;
      const th = Math.max(1.5, l.n * k);
      const x0 = a.x + COL_W, x1 = b.x, y0 = a.y + a.out, y1 = b.y + b.in;
      a.out += l.n * k; b.in += l.n * k;
      const mx = (x0 + x1) / 2;
      const path = s('path', { class: 'ribbon', d: `M${x0} ${y0}C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}L${x1} ${y1 + th}C${mx} ${y1 + th} ${mx} ${y0 + th} ${x0} ${y0 + th}Z` });
      path.dataset.a = `${l.col}|${l.from}`; path.dataset.b = `${l.col + 1}|${l.to}`;
      path.addEventListener('pointermove', (e) => { svg.classList.add('has-focus'); ribbons.forEach((r) => r.classList.toggle('on', r === path)); tip.show(e, `${name_(l.from)} → ${name_(l.to)}`, [['会話', `${num(l.n)}${pct(l.n)}`]]); });
      path.addEventListener('pointerleave', () => { svg.classList.remove('has-focus'); path.classList.remove('on'); tip.hide(); });
      ribbons.push(path);
      svg.append(path);
    }
    for (const r of rect.values()) {
      const key = `${r.ci}|${r.label}`;
      const on = (e) => { svg.classList.add('has-focus'); ribbons.forEach((p) => p.classList.toggle('on', p.dataset.a === key || p.dataset.b === key)); tip.show(e, name_(r.label), [['会話', `${num(r.n)}${pct(r.n)}`]]); };
      const off = () => { svg.classList.remove('has-focus'); ribbons.forEach((p) => p.classList.remove('on')); tip.hide(); };
      const hit = s('rect', { class: 'node', x: r.x, y: r.y, width: COL_W, height: r.h, rx: 1.5, tabindex: 0, 'aria-label': `${name_(r.label)} ${r.n} 会話` });
      hit.addEventListener('pointerenter', on); hit.addEventListener('pointerleave', off); hit.addEventListener('focus', on); hit.addEventListener('blur', off);
      svg.append(hit);
      // 札：最初の段は左、ほかは棒の右。長い文は切り、全文は重ねたときの札と下の数字にある
      const max = r.ci === 0 ? 15 : 13;
      const full = name_(r.label);
      const short = full.length > max ? `${full.slice(0, max - 1)}…` : full;
      const left = r.ci === 0;
      const label = s('text', { x: left ? r.x - 6 : r.x + COL_W + 6, y: r.y + Math.max(r.h, 14) / 2 + 4, 'text-anchor': left ? 'end' : 'start' }, short);
      label.append(s('tspan', { class: 'n', dx: 6 }, num(r.n)));
      label.append(s('title', {}, `${full}：${r.n} 会話`));
      svg.append(label);
    }
    flowBox.replaceChildren(wrap, list);
  }

  void load();
}

void boot();
