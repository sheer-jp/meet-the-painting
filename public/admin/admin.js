// 管理ページ（docs/ADMIN.md 4 節）。依存なし。受け取った文はすべて textContent で出す（innerHTML を使わない）
const app = document.getElementById('app');
const REACTIONS = { love: '好き', curious: '気になる', unsure: 'ちょっと違うかも' };
const PLACES = { story_end: '語りの終わりで', after: '絵の世界から戻って', exit: '絵の世界を閉じて', rooms: '部屋で見たあと', dwell: '作品ページで', link: '自分で開いて' };
const LANGS = { ja: '日本語', en: '英語', 'zh-Hans': '中国語（簡体）', 'zh-Hant': '中国語（繁体）', ko: '韓国語', fr: 'フランス語', de: 'ドイツ語', es: 'スペイン語', it: 'イタリア語', pt: 'ポルトガル語' };
const DAYS = [7, 30, 90, 180];
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

const jstFull = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const jstTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

class Unauthorized extends Error {}
async function api(path, init) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  if (res.status === 401) throw new Unauthorized();
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error || String(res.status)); e.status = res.status; throw e; }
  return data;
}

// ───── ログイン ─────
function showLogin(config, error) {
  const err = h('p', { class: 'err', role: 'alert', text: error || '' });
  err.hidden = !error;
  const btn = h('div', { id: 'gbtn' });
  app.replaceChildren(h('div', { class: 'login' },
    h('h1', { text: '絵と出会う 管理' }),
    h('p', { text: '作家専用のページです。登録したメールアドレスの Google アカウントでログインしてください。' }),
    btn, err));
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.onerror = () => fail('Google のログインを読み込めませんでした。時間をおいて開き直してください。');
  script.onload = () => {
    window.google.accounts.id.initialize({
      client_id: config.clientId,
      auto_select: false,
      callback: async ({ credential }) => {
        try {
          await api('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
          void boot();
        } catch (e) {
          if (e.message === 'not_allowed') fail('このメールアドレスでは見られません。');
          else fail('ログインできませんでした。もう一度お試しください。');
        }
      },
    });
    window.google.accounts.id.renderButton(btn, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja', shape: 'rectangular' });
  };
  document.head.append(script);
}

async function boot() {
  try {
    const me = await api('/api/admin/me');
    showDashboard(me.email);
  } catch (e) {
    let config = null;
    try { config = await api('/api/admin/config'); } catch { /* 下で閉じる */ }
    if (!config?.configured) {
      app.replaceChildren(h('div', { class: 'login' }, h('h1', { text: '絵と出会う 管理' }), h('p', { text: '管理ページの設定がまだ終わっていないので、いまは誰も入れません。手順はリポジトリの docs/ADMIN.md 6 節にあります。' })));
      return;
    }
    if (e instanceof Unauthorized) { showLogin(config); return; }
    showLogin(config, '読み込めませんでした。もう一度お試しください。');
  }
}

// ───── ダッシュボード ─────
function showDashboard(email) {
  const state = { days: 30, work: '', reaction: '', works: [], titles: new Map(), images: new Map() };
  const period = h('div', { class: 'period', role: 'group', 'aria-label': '期間' }, h('span', { text: '期間' }), DAYS.map((d) => h('button', {
    type: 'button', 'data-days': d, 'aria-pressed': String(d === state.days), text: d === 180 ? '180 日（感想は全部）' : `${d} 日`,
    onclick: () => { state.days = d; period.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.days === d))); void load(); },
  })));
  const notice = h('div');
  const kpis = h('div', { class: 'kpis' });
  const fbBox = h('div');
  const workBox = h('div');
  const barBox = h('div');
  const flowBox = h('div');
  const workSel = h('select', { 'aria-label': '絵で絞り込む', onchange: () => { state.work = workSel.value; void loadFeedback(); } });
  const reactSel = h('select', { 'aria-label': '反応で絞り込む', onchange: () => { state.reaction = reactSel.value; void loadFeedback(); } },
    h('option', { value: '', text: 'すべて' }), Object.entries(REACTIONS).map(([v, t]) => h('option', { value: v, text: t })));

  app.replaceChildren(
    h('header', { class: 'top' }, h('h1', { text: '絵と出会う 管理' }), h('span', { class: 'who', text: email }),
      h('button', { type: 'button', class: 'text-btn', text: 'ログアウト', onclick: async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); location.reload(); } })),
    period, notice, kpis,
    h('section', { id: 'fb' }, h('h2', { text: '届いた感想' }), h('p', { class: 'sub', text: '訪れた人が「作家に届ける」を押した文だけです。日時は日本時間。' }),
      h('div', { class: 'filters' }, h('label', {}, '絵', workSel), h('label', {}, '反応', reactSel)), fbBox),
    h('section', { id: 'works' }, h('h2', { text: '絵ごとの数' }), h('p', { class: 'sub', text: '「すすめた」は案内役がすすめた回数。「絵の世界へ」「ギャラリーで選ばれた」が、選ばれた回数です。' }), workBox),
    h('section', { id: 'questions' }, h('h2', { text: '使われた問いと、押された選択肢' }), h('p', { class: 'sub', text: '案内役は問いを言い換えるので、用意した問いのうち近いものにまとめています。自由入力の文は保存していません。' }), barBox),
    h('section', { id: 'flow' }, h('h2', { text: '会話の流れ' }), h('p', { class: 'sub', text: '受付で話した会話が、どこを通ってどこまで進んだか。線の太さが会話の数です。線や棒に重ねると数が出ます。1 つの会話につき、いちばん先まで進んだところで数えます。' }), flowBox),
  );

  const unauthorized = async () => { const c = await api('/api/admin/config').catch(() => null); if (c?.configured) showLogin(c, 'ログインの期限が切れました。もう一度ログインしてください。'); };

  async function load() {
    kpis.replaceChildren(h('p', { class: 'msg', text: '読み込んでいます' }));
    try {
      const d = await api(`/api/admin/summary?days=${state.days}`);
      state.works = d.catalog || [];
      state.titles = new Map(state.works.map((w) => [w.id, w.title]));
      state.images = new Map(state.works.map((w) => [w.id, w.image]));
      const cur = state.work;
      workSel.replaceChildren(h('option', { value: '', text: 'すべて' }), state.works.map((w) => h('option', { value: w.id, text: w.title })));
      workSel.value = cur;
      renderNotice(d);
      renderKpis(d.totals);
      renderWorks(d.works);
      renderBars(d);
      renderFlow(d.flow);
      await loadFeedback();
    } catch (e) {
      if (e instanceof Unauthorized) return unauthorized();
      kpis.replaceChildren(h('p', { class: 'notice', role: 'alert', text: '読み込めませんでした。時間をおいて開き直してください。' }));
    }
  }

  function renderNotice(d) {
    notice.replaceChildren(
      d.db === false ? h('p', { class: 'notice', text: '保存先（Cloudflare D1）がまだつながっていないので、感想も出来事も届きません。手順は docs/ADMIN.md 6 節です。作品の一覧だけ出しています。' }) : '',
      d.truncated ? h('p', { class: 'notice', text: '出来事が多いので、古い順に 5 万件までで集計しています。期間を短くすると正確になります。' }) : '',
    );
  }

  function renderKpis(t) {
    kpis.replaceChildren(...[['会話', t.conversations], ['すすめた回数', t.recommended], ['絵の世界へ', t.entered], ['届いた感想', t.feedback], ['購入リンク', t.buys]]
      .map(([label, n]) => h('div', { class: 'kpi' }, h('b', { text: String(n) }), h('span', { text: label }))));
  }

  // ───── 感想 ─────
  async function loadFeedback(before) {
    const q = new URLSearchParams({ days: state.days });
    if (state.work) q.set('work', state.work);
    if (state.reaction) q.set('reaction', state.reaction);
    if (before) q.set('before', before);
    try {
      const d = await api(`/api/admin/feedback?${q}`);
      renderFeedback(d, !!before);
    } catch (e) {
      if (e instanceof Unauthorized) return unauthorized();
      fbBox.replaceChildren(h('p', { class: 'notice', role: 'alert', text: '感想を読み込めませんでした。' }));
    }
  }
  function renderFeedback(d, append) {
    if (!append) fbBox.replaceChildren();
    fbBox.querySelector('.more')?.remove();
    if (!d.items.length && !append) {
      fbBox.append(h('p', { class: 'empty', text: state.work || state.reaction ? 'この条件の感想はありません。' : 'この期間に届いた感想はまだありません。' }));
      return;
    }
    fbBox.append(...d.items.map(feedbackItem));
    if (d.next) fbBox.append(h('button', { type: 'button', class: 'more', text: 'もっと見る', onclick: () => loadFeedback(d.next) }));
  }
  function feedbackItem(it) {
    const title = state.titles.get(it.work_id) || it.work_id;
    const img = state.images.get(it.work_id);
    const actions = h('div', { class: 'fb-actions' });
    const box = h('article', { class: 'fb' },
      img ? h('img', { src: `/${img}`, alt: '', loading: 'lazy', width: 56, height: 56 }) : h('span', {}),
      h('div', { class: 'fb-meta' }, h('b', { text: title }), h('time', { datetime: new Date(it.created_at).toISOString(), text: jstFull.format(it.created_at) }),
        it.reaction ? h('span', { class: 'fb-reaction', text: REACTIONS[it.reaction] || it.reaction }) : '',
        h('span', { text: LANGS[it.lang] || it.lang }), h('span', { text: PLACES[it.place] || it.place })),
      it.body ? h('p', { class: 'fb-body', text: it.body }) : h('p', { class: 'fb-body none', text: '（文はなし。反応だけ）' }),
      actions);
    const normal = () => actions.replaceChildren(
      it.sid ? h('button', { type: 'button', class: 'text-btn', text: 'この人の流れを見る', onclick: (e) => toggleJourney(box, it.sid, e.currentTarget) }) : '',
      h('button', { type: 'button', class: 'text-btn', text: '削除', onclick: confirmDelete }),
    );
    const confirmDelete = () => {
      const sure = h('button', { type: 'button', class: 'text-btn danger', text: '消す', onclick: async () => {
        sure.disabled = true;
        try {
          await api(`/api/admin/feedback/${encodeURIComponent(it.id)}`, { method: 'DELETE' });
          box.remove();
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
    const d = await api(`/api/admin/summary?days=${state.days}`).catch(() => null);
    if (d) { renderKpis(d.totals); renderWorks(d.works); renderBars(d); }
    if (!fbBox.querySelector('.fb')) void loadFeedback();
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

  // ───── 絵ごとの表 ─────
  function renderWorks(works) {
    const cols = [['recommended', 'すすめた'], ['entered', '絵の世界へ'], ['picked', 'ギャラリーで選ばれた'], ['views', '作品ページ'], ['feedback', '感想'], ['buys', '購入リンク']];
    if (!works.length) { workBox.replaceChildren(h('p', { class: 'empty', text: '作品のカタログを読めませんでした。' })); return; }
    workBox.replaceChildren(h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '絵' }), cols.map(([, l]) => h('th', { scope: 'col', text: l })))),
      h('tbody', {}, works.map((w) => h('tr', {}, h('td', { text: state.titles.get(w.id) || w.id }), cols.map(([k]) => h('td', { class: w[k] ? null : 'zero', text: String(w[k]) }))))))));
  }

  // ───── 問いと選択肢 ─────
  function barList(title, items, { limit = 12, label = (x) => x, muted = () => false, empty } = {}) {
    const row = (x, max) => h('div', { class: `bar${muted(x.label) ? ' muted' : ''}` }, h('span', { class: 'bar-label', text: label(x.label) }), h('span', { class: 'bar-val', text: String(x.n) }), (() => { const i = h('i', {}); i.style.width = `${(x.n / max) * 100}%`; return i; })());
    const box = h('div', { class: 'bars' }, h('h3', { text: title }));
    if (!items.length) { box.append(h('p', { class: 'empty', text: empty })); return box; }
    const max = items[0].n;
    box.append(...items.slice(0, limit).map((x) => row(x, max)));
    if (items.length > limit) box.append(h('details', { class: 'all' }, h('summary', { text: `残り ${items.length - limit} 件を見る` }), items.slice(limit).map((x) => row(x, max))));
    return box;
  }
  function renderBars(d) {
    const isOther = (l) => l.startsWith('その他');
    const t = d.totals;
    barBox.replaceChildren(h('div', { class: 'bars-grid' },
      barList('案内役の問い', d.questions, { muted: isOther, empty: 'まだありません。' }),
      h('div', {},
        barList('押された選択肢', d.openers, { muted: isOther, empty: 'まだありません。' }),
        h('p', { class: 'sub', style: 'margin-top:10px', text: `自由入力：${t.free} 回（文は保存していません）　「別のにする」：${t.others} 回` })),
      barList('感想の反応', d.reactions, { label: (l) => REACTIONS[l] || l, empty: 'まだありません。' }),
      barList('言語（訪れたタブの数）', d.langs, { label: (l) => LANGS[l] || l, empty: 'まだありません。' }),
    ));
  }

  // ───── 流れ（Sankey。依存なしの SVG。色は墨の濃淡。数字は下の表にもある） ─────
  function renderFlow(flow) {
    if (!flow.total) { flowBox.replaceChildren(h('p', { class: 'empty', text: 'この期間の会話はまだありません。受付で話した人が来ると、ここに流れが出ます。' })); return; }
    const name = (l) => state.titles.get(l) || l;
    const COL_W = 9, ROW_GAP = 12, MIN_ROW = 20, TOP = 34;
    const W = Math.max(860, Math.min(1040, flowBox.clientWidth || 1040));
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
    const svg = s('svg', { class: 'flow', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `会話の流れ。合計 ${flow.total} 会話。数字は下の表にあります。` });
    const tip = h('div', { class: 'flow-tip' }); tip.hidden = true;
    const wrap = h('div', { class: 'flow-wrap' }, h('div', { class: 'scroll' }, svg), tip);
    const showTip = (ev, big, small) => {
      tip.replaceChildren(h('b', { text: big }), small);
      tip.hidden = false;
      const box = wrap.getBoundingClientRect();
      const cx = ev.clientX ?? box.left + 40, cy = ev.clientY ?? box.top + 40;
      tip.style.left = `${Math.min(cx - box.left + 12, box.width - 220)}px`;
      tip.style.top = `${Math.max(0, cy - box.top - 56)}px`;
    };
    const hideTip = () => { tip.hidden = true; };
    const pct = (n) => `${Math.round((n / flow.total) * 100)}%`;

    flow.columns.forEach((col, i) => svg.append(s('text', { class: 'col', x: i === 0 ? xs[i] + COL_W : i === 3 ? xs[i] : xs[i], y: 14, 'text-anchor': i === 0 ? 'end' : 'start' }, col.title)));

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
      path.addEventListener('pointermove', (e) => { svg.classList.add('has-focus'); ribbons.forEach((r) => r.classList.toggle('on', r === path)); showTip(e, `${l.n} 会話（${pct(l.n)}）`, `${name(l.from)} → ${name(l.to)}`); });
      path.addEventListener('pointerleave', () => { svg.classList.remove('has-focus'); path.classList.remove('on'); hideTip(); });
      ribbons.push(path);
      svg.append(path);
    }
    for (const r of rect.values()) {
      const key = `${r.ci}|${r.label}`;
      const on = (e) => { svg.classList.add('has-focus'); ribbons.forEach((p) => p.classList.toggle('on', p.dataset.a === key || p.dataset.b === key)); showTip(e, `${r.n} 会話（${pct(r.n)}）`, name(r.label)); };
      const off = () => { svg.classList.remove('has-focus'); ribbons.forEach((p) => p.classList.remove('on')); hideTip(); };
      const hit = s('rect', { class: 'node', x: r.x, y: r.y, width: COL_W, height: r.h, rx: 1.5, tabindex: 0, 'aria-label': `${name(r.label)} ${r.n} 会話` });
      hit.addEventListener('pointerenter', on); hit.addEventListener('pointerleave', off); hit.addEventListener('focus', on); hit.addEventListener('blur', off);
      svg.append(hit);
      // 札：最初の段は左、ほかは棒の右。長い文は切り、全文は表と重ねたときの札にある
      const max = r.ci === 0 ? 15 : 13;
      const full = name(r.label);
      const short = full.length > max ? `${full.slice(0, max - 1)}…` : full;
      const left = r.ci === 0;
      const tx = left ? r.x - 6 : r.x + COL_W + 6;
      const label = s('text', { x: tx, y: r.y + Math.max(r.h, 14) / 2 + 4, 'text-anchor': left ? 'end' : 'start' }, short);
      label.append(s('tspan', { class: 'n', dx: 6, 'fill-opacity': .65 }, String(r.n)));
      label.append(s('title', {}, `${full}：${r.n} 会話`));
      svg.append(label);
    }
    // 表（色や形に頼らず、全文と数を読めるように）
    const COLS = flow.columns.map((c) => c.title);
    const table = h('details', { class: 'all' }, h('summary', { text: '流れを数字の表で見る' }), h('div', { class: 'scroll' }, h('table', { class: 'flow-table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'ここから' }), h('th', { text: 'ここへ' }), h('th', { text: '会話の数' }))),
      h('tbody', {}, flow.links.map((l) => h('tr', {}, h('td', { text: `${COLS[l.col]}：${name(l.from)}` }), h('td', { text: `${COLS[l.col + 1]}：${name(l.to)}` }), h('td', { text: String(l.n) })))))));
    flowBox.replaceChildren(wrap, table);
  }

  void load();
}

void boot();
