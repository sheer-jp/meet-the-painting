// 作品の登録と作品の一覧（docs/REGISTER.md 3、6 節、docs/ADMIN.md）。管理ページのタブから import() で読む
// 会話は左、確認カードは右（スマホは下）。会話の文はこの画面のメモリにだけ持つ（サーバーには毎回送るが、保存しない）
// 受け取った文はすべて textContent で出す（innerHTML を使わない）
const MAX_SIDE = 2000;      // 送る前に縮める長辺
const MIN_SIDE = 1600;      // これより小さい写真は断る（docs/REGISTER.md 3 節）
const MAX_BYTES = 15 * 1024 * 1024;
const STATUS = { draft: '下書き', queued: '公開の待ち', building: '公開中', published: '公開済み', failed: '公開に失敗' };
const FIELD = { title: '題名', year: '描いた年', size: '大きさ', medium: '画材', price: '値段', messages: '想いの文', moods: '気分の言葉' };
const TZ = 'Asia/Tokyo';
const fmt = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
const len = (s) => [...String(s)].length;

/**
 * @param {HTMLElement} root 「作品を登録」の入れ物
 * @param {HTMLElement} listRoot 「作品の一覧」の入れ物
 * @param {{ h: Function, api: Function, Unauthorized: any, onUnauthorized: () => void, goTab: (tab: string) => void }} ui
 */
export function mountRegister(root, listRoot, ui) {
  const { h, api, Unauthorized } = ui;
  const state = { config: null, draft: null, view: null, history: [], colors: [], focus: null, busy: false, editing: { messages: false, moods: false } };
  const KEY = 'mtp_register_draft';
  const remember = (id) => { try { if (id) sessionStorage.setItem(KEY, id); else sessionStorage.removeItem(KEY); } catch { /* 使えなくてもよい */ } };
  const recalled = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };

  const failed = (e, box) => {
    if (e instanceof Unauthorized) { ui.onUnauthorized(); return; }
    box.replaceChildren(h('p', { class: 'notice', role: 'alert', text: e?.message && /[ぁ-ん]/.test(e.message) ? e.message : '読み込めませんでした。時間をおいてもう一度お試しください。' }));
  };
  // API の失敗を作家向けの文に
  async function call(path, init) {
    try { return await api(path, init); } catch (e) {
      if (e instanceof Unauthorized) throw e;
      const err = new Error(e?.data?.message || ({ 409: 'いまは直せない状態です（公開の待ちか公開中）。', 413: '写真が 15MB を超えています。', 415: 'JPEG か PNG の写真を選んでください。', 429: '回数が多いので、少し待ってからもう一度お試しください。', 503: 'いま保存先につながりません。時間をおいてもう一度お試しください。' }[e?.status] || 'うまくいきませんでした。もう一度お試しください。'));
      err.status = e?.status;
      throw err;
    }
  }

  // ───── 画面の骨組み ─────
  const notice = h('div');
  const talk = h('ol', { class: 'talk', 'aria-live': 'polite', 'aria-label': '会話' });
  const photoBox = h('div', { class: 'photo-step' });
  const input = h('textarea', { class: 'talk-input', rows: 2, maxlength: 1200, 'aria-label': '答えを書く', enterkeyhint: 'send', placeholder: 'ここに書いて「送る」' });
  const sendBtn = h('button', { type: 'submit', class: 'btn-ink', text: '送る' });
  const laterBtn = h('button', { type: 'button', class: 'btn-line', text: 'あとで' });
  const form = h('form', { class: 'talk-form', onsubmit: (e) => { e.preventDefault(); void send(input.value); } }, input, h('div', { class: 'talk-actions' }, laterBtn, sendBtn));
  laterBtn.addEventListener('click', () => void send('あとで'));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(input.value); } });
  const newBtn = h('button', { type: 'button', class: 'text-btn', text: '新しく始める', onclick: () => startNew() });
  const head = h('div', { class: 'reg-head' }, h('h2', { class: 'reg-title', text: '作品を登録' }), h('span', { class: 'reg-status' }), newBtn);
  const card = h('aside', { class: 'reg-card', 'aria-label': '確認カード' });
  const chat = h('section', { class: 'reg-chat', 'aria-label': '会話で登録' }, head, talk, photoBox, form);
  root.replaceChildren(notice, h('div', { class: 'reg-grid' }, chat, card));

  function say(who, text) {
    const li = h('li', { class: `say ${who}` }, h('span', { class: 'say-who', text: who === 'bot' ? '聞き役' : 'あなた' }), h('p', { class: 'say-text', text }));
    talk.append(li);
    li.scrollIntoView?.({ block: 'nearest' });
  }
  function setBusy(b) {
    state.busy = b;
    sendBtn.disabled = b; laterBtn.disabled = b; input.disabled = b;
    sendBtn.textContent = b ? '考えています' : '送る';
  }
  const locked = () => state.draft && !['draft', 'failed'].includes(state.draft.status);

  // ───── 読み込み ─────
  async function load() {
    try {
      state.config = await call('/api/admin/works/config');
    } catch (e) { failed(e, notice); return; }
    if (!state.config.ready) {
      notice.replaceChildren(h('div', { class: 'notice' }, h('b', { text: '登録はまだ使えません。' }), ` ${state.config.message || ''}手順は docs/REGISTER.md の「実装の記録」にあります。ダッシュボードはいつもどおり使えます。`));
      chat.hidden = true; card.hidden = true;
      return;
    }
    notice.replaceChildren(state.config.ai ? '' : h('p', { class: 'note', text: 'いまは決まった順に聞く版で動いています（Claude の鍵がありません）。答えは短く、聞かれた順にどうぞ。' }));
    chat.hidden = false; card.hidden = false;
    const id = recalled();
    let d = null;
    if (id) { try { d = await call(`/api/admin/works/${encodeURIComponent(id)}`); } catch (e) { if (e instanceof Unauthorized) return ui.onUnauthorized(); } }
    if (!d) {
      // 書きかけの下書きがあれば続きから
      try {
        const list = await call('/api/admin/works');
        const open = (list.drafts || []).find((x) => x.status === 'draft');
        if (open) d = await call(`/api/admin/works/${open.id}`);
      } catch (e) { if (e instanceof Unauthorized) return ui.onUnauthorized(); }
    }
    if (d) open_(d); else startNew();
  }

  function open_(d) {
    state.draft = d.draft; state.view = d.view; state.history = []; state.focus = null; state.editing = { messages: false, moods: false };
    state.colors = d.draft.data?.colors || [];
    remember(d.draft.id);
    talk.replaceChildren();
    if (d.draft.photo) say('bot', d.draft.status === 'draft' || d.draft.status === 'failed' ? `続きから始めます。${d.view.say}` : statusLine());
    render();
  }
  function startNew() {
    state.draft = null; state.view = null; state.history = []; state.focus = null; state.colors = [];
    remember(null);
    talk.replaceChildren();
    say('bot', 'まず、絵の写真を選んでください。正面から、絵の端まで写っているものを。');
    render();
  }
  const statusLine = () => state.draft?.status === 'queued' ? '公開の準備ができました（R2 のコマンドで公開します）。' : state.draft?.status === 'published' ? '公開しました。' : state.draft?.status === 'building' ? 'いま公開しています。' : '';

  function render() {
    const d = state.draft;
    head.querySelector('.reg-status').textContent = d ? STATUS[d.status] || '' : '新しい作品';
    renderPhotoStep();
    form.hidden = !d?.photo || locked();
    renderCard();
  }

  // ───── 写真：選ぶ → その場で縮める（長辺 2000px）・90 度回す → 送る ─────
  let pick = null;   // { bitmap, rot, canvas }
  function renderPhotoStep() {
    const d = state.draft;
    if (d?.photo && !pick) {
      photoBox.replaceChildren(locked() ? '' : h('button', { type: 'button', class: 'text-btn', text: '写真を選び直す', onclick: () => { pick = { choose: true }; renderPhotoStep(); } }));
      return;
    }
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/heic,image/heif,.heic,.heif', class: 'visually-hidden', id: 'reg-file' });
    const err = h('p', { class: 'err', role: 'alert' });
    err.hidden = true;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      err.hidden = true;
      if (f.size > MAX_BYTES) { err.textContent = '写真が 15MB を超えています。'; err.hidden = false; return; }
      let bitmap;
      try { bitmap = await createImageBitmap(f, { imageOrientation: 'from-image' }); }
      catch { err.textContent = 'この写真はこのブラウザで読めません。JPEG か PNG で選んでください。'; err.hidden = false; return; }
      if (Math.max(bitmap.width, bitmap.height) < MIN_SIDE) { err.textContent = `写真が小さすぎます（長辺 ${Math.max(bitmap.width, bitmap.height)}px）。長辺 ${MIN_SIDE}px 以上で撮ってください。`; err.hidden = false; return; }
      pick = { bitmap, rot: 0 };
      drawPick();
    });
    const label = h('label', { for: 'reg-file', class: 'btn-ink file-btn', text: d?.photo ? '別の写真を選ぶ' : '写真を選ぶ' });
    const kids = [h('div', { class: 'photo-pick' }, label, file, d?.photo ? h('button', { type: 'button', class: 'text-btn', text: 'やめる', onclick: () => { pick = null; renderPhotoStep(); } }) : ''), err];
    if (pick?.canvas) {
      kids.push(h('div', { class: 'photo-preview' }, pick.canvas),
        h('p', { class: 'note', text: `送る大きさ：${pick.canvas.width} × ${pick.canvas.height}px（位置情報などは消して送ります）` }),
        h('div', { class: 'photo-actions' },
          h('button', { type: 'button', class: 'btn-line', text: '90° 回す', onclick: () => { pick.rot = (pick.rot + 90) % 360; drawPick(); } }),
          h('button', { type: 'button', class: 'btn-ink', text: 'この写真で始める', onclick: (e) => void upload(e.currentTarget) })));
    }
    photoBox.replaceChildren(...kids);
  }
  function drawPick() {
    const { bitmap, rot } = pick;
    const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * k), hh = Math.round(bitmap.height * k);
    const side = rot % 180 === 0;
    const c = document.createElement('canvas');
    c.width = side ? w : hh; c.height = side ? hh : w;
    c.className = 'photo-canvas';
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', '選んだ写真');
    const x = c.getContext('2d');
    x.translate(c.width / 2, c.height / 2);
    x.rotate((rot * Math.PI) / 180);
    x.drawImage(bitmap, -w / 2, -hh / 2, w, hh);
    pick.canvas = c;
    renderPhotoStep();
  }
  // 写真の主な色（色の値だけを聞き役に渡す。写真は渡さない）
  function paletteOf(canvas) {
    const c = document.createElement('canvas');
    c.width = 48; c.height = 48;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(canvas, 0, 0, 48, 48);
    const d = x.getImageData(0, 0, 48, 48).data;
    const bins = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const k = ((d[i] >> 5) << 6) | ((d[i + 1] >> 5) << 3) | (d[i + 2] >> 5);
      const b = bins.get(k) || [0, 0, 0, 0];
      b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++;
      bins.set(k, b);
    }
    return [...bins.values()].sort((a, b) => b[3] - a[3]).slice(0, 5).map((b) => `#${[0, 1, 2].map((j) => Math.round(b[j] / b[3]).toString(16).padStart(2, '0')).join('')}`);
  }
  async function upload(btn) {
    btn.disabled = true; btn.textContent = '送っています';
    try {
      const blob = await new Promise((res) => pick.canvas.toBlob(res, 'image/jpeg', 0.9));
      if (!blob || blob.size > MAX_BYTES) throw new Error('写真を縮められませんでした。別の写真で試してください。');
      state.colors = paletteOf(pick.canvas);
      if (!state.draft) {
        const c = await call('/api/admin/works', { method: 'POST' });
        state.draft = c.draft; remember(c.draft.id);
      }
      const r = await call(`/api/admin/works/${state.draft.id}/photo`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      pick = null;
      const first = !state.view || !state.history.length;
      state.draft = r.draft; state.view = r.view;
      say('bot', first ? `写真を受け取りました。${r.view.say}` : '写真を差し替えました。大きさが合っているか、カードで確かめてください。');
      render();
      input.focus();
    } catch (e) {
      if (e instanceof Unauthorized) return ui.onUnauthorized();
      btn.disabled = false; btn.textContent = 'この写真で始める';
      const err = photoBox.querySelector('.err');
      if (err) { err.textContent = e.message; err.hidden = false; }
    }
  }

  // ───── 会話 ─────
  async function send(text) {
    const t = String(text || '').trim();
    if (!t || state.busy || !state.draft) return;
    say('me', t);
    input.value = '';
    state.history.push({ role: 'user', content: t });
    // 送るのは最近の 20 往復まで（サーバーの上限 24）
    while (state.history.length > 23) state.history.shift();
    setBusy(true);
    try {
      const r = await call('/api/admin/works/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: state.draft.id, messages: state.history, colors: state.colors, ...(state.focus ? { focus: state.focus } : {}) }) });
      state.focus = null;
      state.draft = r.draft; state.view = r.view;
      state.history.push({ role: 'assistant', content: r.reply.slice(0, 1200) });
      say('bot', r.reply);
      render();
    } catch (e) {
      if (e instanceof Unauthorized) return ui.onUnauthorized();
      state.history.pop();
      say('bot', `${e.message}（もう一度送ってください）`);
      input.value = t;
    } finally { setBusy(false); if (!form.hidden) input.focus(); }
  }
  function fix(field) {
    if (locked()) return;
    state.focus = field;
    say('bot', `${FIELD[field]}を直します。新しい${FIELD[field]}を教えてください。`);
    input.focus();
  }

  async function patch(body, btn, err) {
    if (btn) btn.disabled = true;
    try {
      const r = await call(`/api/admin/works/${state.draft.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      state.draft = r.draft; state.view = r.view;
      return true;
    } catch (e) {
      if (e instanceof Unauthorized) { ui.onUnauthorized(); return false; }
      if (err) { err.textContent = e.message; err.hidden = false; }
      if (btn) btn.disabled = false;
      return false;
    }
  }

  // ───── 確認カード：項目が埋まるたびに育つ ─────
  function renderCard() {
    const d = state.draft, v = state.view;
    if (!d) { card.replaceChildren(h('p', { class: 'card-empty', text: '写真を選ぶと、ここに作品ページの見え方が育っていきます。' })); return; }
    const w = d.data.work || {};
    const p = d.data.proposed || {};
    const size = w.size_cm ? `${w.size_label?.ja ? `${w.size_label.ja} ・ ` : ''}${w.size_cm[0]} × ${w.size_cm[1]} cm` : null;
    const fixBtn = (f) => locked() ? '' : h('button', { type: 'button', class: 'fix', text: '直す', 'aria-label': `${FIELD[f]}を直す`, onclick: () => fix(f) });

    // 作品ページの見え方
    const page = h('section', { class: 'cc cc-page' }, h('h3', { class: 'cc-h', text: '作品ページの見え方' }),
      h('div', { class: 'pv' },
        d.photo ? h('img', { class: 'pv-img', src: d.photo.url, alt: '登録する絵の写真', width: d.photo.width, height: d.photo.height }) : h('div', { class: 'pv-img empty', text: '写真' }),
        h('div', { class: 'pv-text' },
          h('p', { class: `pv-title${w.title ? '' : ' ph'}`, text: w.title?.ja || '題名' }),
          w.title?.en && w.title.en !== w.title.ja ? h('p', { class: 'pv-en', lang: 'en', text: w.title.en }) : '',
          h('p', { class: 'pv-meta' }, ...[w.year ? String(w.year) : '年', size || '大きさ', w.medium?.ja || '画材'].map((t, i) => h('span', { class: [w.year, size, w.medium][i] ? '' : 'ph', text: t }))),
          w.availability === 'available' && Number.isInteger(w.buy?.price_jpy) ? h('p', { class: 'pv-price' }, `¥${w.buy.price_jpy.toLocaleString('en-US')}`, h('small', { text: '（税込）' })) : v.availability_ja ? h('p', { class: 'pv-avail', text: v.availability_ja }) : '',
          w.messages?.length ? h('p', { class: 'pv-msg', text: `「${w.messages[0]}」…` }) : '')));

    // 展示用キャプションの見え方（/exhibit/ の 1 枚と同じ並び）
    const cap = h('section', { class: 'cc' }, h('h3', { class: 'cc-h', text: '展示用キャプションの見え方' }),
      h('div', { class: 'cap' },
        h('div', { class: 'cap-text' },
          h('p', { class: 'cap-title', text: w.title?.ja || '題名' }),
          w.title?.en && w.title.en !== w.title.ja ? h('p', { class: 'cap-en', lang: 'en', text: w.title.en }) : '',
          h('p', { class: 'cap-meta' }, h('span', { text: w.year ? String(w.year) : '' }), h('span', { text: w.medium?.ja || '' }), h('span', { text: size || '' })),
          h('p', { class: 'cap-scan', text: 'スマホで読み取ると、この絵の中に入れます' })),
        h('div', { class: 'cap-qr', 'aria-hidden': 'true', text: 'QR' })),
      h('p', { class: 'note', text: 'QR は公開のときに作ります。' }));

    // 項目の表
    const row = (f, label, value, extra) => h('div', { class: `cc-row${value ? '' : ' missing'}` }, h('dt', { text: label }), h('dd', {}, h('span', { text: value || (d.data.skipped?.includes(f) ? 'あとで' : 'まだ') }), extra || ''), h('div', { class: 'cc-act' }, f ? fixBtn(f) : ''));
    const idErr = h('p', { class: 'err', role: 'alert' }); idErr.hidden = true;
    const idInput = h('input', { class: 'id-input', type: 'text', value: d.work_id || '', 'aria-label': '作品の id（URL）', autocapitalize: 'none', spellcheck: 'false', maxlength: 48, disabled: locked() });
    const idSave = h('button', { type: 'button', class: 'fix', text: '保存', onclick: async (e) => { if (await patch({ work_id: idInput.value.trim() }, e.currentTarget, idErr)) renderCard(); } });
    const facts = h('dl', { class: 'cc-list' },
      row('title', '題名', w.title ? `${w.title.ja}${w.title.en && w.title.en !== w.title.ja ? ` / ${w.title.en}` : ''}` : null),
      row('year', '描いた年', w.year ? String(w.year) : null),
      row('size', '寸法', size),
      row('medium', '画材', w.medium?.ja || null),
      row('price', '値段', w.availability === 'available' && Number.isInteger(w.buy?.price_jpy) ? `${yen(w.buy.price_jpy)}（税込）・${v.availability_ja}` : v.availability_ja),
      h('div', { class: 'cc-row' }, h('dt', { text: '支払い' }), h('dd', { class: 'pay', text: v.pay_line }), h('div', { class: 'cc-act' })),
      h('div', { class: 'cc-row' }, h('dt', { text: '作品の id' }), h('dd', {}, h('div', { class: 'id-edit' }, h('span', { class: 'id-pre', text: '/w/' }), idInput), idErr, v.page_url ? h('span', { class: 'note', text: v.page_url }) : ''), h('div', { class: 'cc-act' }, locked() ? '' : idSave)),
    );

    card.replaceChildren(page, cap, h('section', { class: 'cc' }, h('h3', { class: 'cc-h', text: '項目' }), facts), messagesBox(w, p), moodsBox(w, p), roomsBox(w, v), footer(v));
  }

  // 想いの文：下書き（確認待ち）は直せる欄で。「これでいい」で確定
  function messagesBox(w, p) {
    const editing = !locked() && (p.messages || state.editing.messages);
    const box = h('section', { class: 'cc' }, h('h3', { class: 'cc-h', text: '想いの文' }));
    if (!editing) {
      if (!w.messages?.length) { box.append(h('p', { class: 'note', text: '会話で想いを話すと、ここに文が並びます。' })); return box; }
      box.append(h('ol', { class: 'msg-list' }, w.messages.map((m) => h('li', { text: m }))));
      if (!locked()) box.append(h('button', { type: 'button', class: 'fix', text: '文を直す', onclick: () => { state.editing.messages = true; renderCard(); } }));
      return box;
    }
    const list = [...(p.messages || w.messages || [])];
    const err = h('p', { class: 'err', role: 'alert' }); err.hidden = true;
    const ol = h('ol', { class: 'msg-edit' });
    const draw = () => ol.replaceChildren(...list.map((m, i) => {
      const count = h('span', { class: 'count', text: `${len(m)}/40` });
      const field = h('input', { type: 'text', value: m, maxlength: 60, 'aria-label': `${i + 1} 文目`, oninput: (e) => { list[i] = e.target.value; count.textContent = `${len(list[i])}/40`; count.classList.toggle('over', len(list[i]) > 40); } });
      if (len(m) > 40) count.classList.add('over');
      return h('li', {}, field, count, list.length > 3 ? h('button', { type: 'button', class: 'fix', text: '消す', 'aria-label': `${i + 1} 文目を消す`, onclick: () => { list.splice(i, 1); draw(); } }) : '');
    }));
    draw();
    box.append(h('p', { class: 'note', text: '作家の言葉から並べた下書きです。直して「これでいい」を押すまで公開されません（3〜10 文、1 文 40 字まで）。' }), ol, err,
      h('div', { class: 'cc-btns' },
        list.length < 10 ? h('button', { type: 'button', class: 'btn-line', text: '文を足す', onclick: () => { list.push(''); draw(); ol.lastElementChild?.querySelector('input')?.focus(); } }) : '',
        h('button', { type: 'button', class: 'btn-ink confirm-messages', text: 'これでいい', onclick: async (e) => { if (await patch({ confirm: 'messages', value: list.map((s) => s.trim()).filter(Boolean) }, e.currentTarget, err)) { state.editing.messages = false; say('bot', `想いの文を確定しました。${state.view.say}`); render(); } } })));
    return box;
  }

  // 気分の言葉：下書きから選んで（3〜5 語）、足して「これでいい」
  function moodsBox(w, p) {
    const editing = !locked() && (p.moods || state.editing.moods);
    const box = h('section', { class: 'cc' }, h('h3', { class: 'cc-h', text: '気分の言葉' }));
    if (!editing) {
      if (!w.moods?.ja?.length) { box.append(h('p', { class: 'note', text: state.draft.data.skipped?.includes('moods') ? 'あとで（なくても公開できます）。' : '会話で答えると、ここに下書きが並びます。' })); return box; }
      box.append(h('p', { class: 'chips' }, w.moods.ja.map((m) => h('span', { class: 'chip on', text: m }))), w.moods.fit?.ja ? h('p', { class: 'note', text: `向く人：${w.moods.fit.ja}` }) : '');
      if (!locked()) box.append(h('button', { type: 'button', class: 'fix', text: '言葉を直す', onclick: () => { state.editing.moods = true; renderCard(); } }));
      return box;
    }
    const src = p.moods || { ja: w.moods?.ja || [], fit: w.moods?.fit?.ja || null };
    const words = [...src.ja];
    const on = new Set(words);
    const err = h('p', { class: 'err', role: 'alert' }); err.hidden = true;
    const chips = h('div', { class: 'chips' });
    const draw = () => chips.replaceChildren(...words.map((m) => h('button', { type: 'button', class: `chip${on.has(m) ? ' on' : ''}`, 'aria-pressed': String(on.has(m)), text: m, onclick: () => { if (on.has(m)) on.delete(m); else on.add(m); draw(); } })));
    draw();
    const add = h('input', { type: 'text', maxlength: 16, placeholder: '言葉を足す', 'aria-label': '気分の言葉を足す' });
    const fit = h('input', { type: 'text', maxlength: 40, value: src.fit || '', placeholder: '向く人・時間・場所（任意）', 'aria-label': '向く人・時間・場所' });
    box.append(h('p', { class: 'note', text: '押して選びます（3〜5 語）。' }), chips,
      h('div', { class: 'mood-add' }, add, h('button', { type: 'button', class: 'btn-line', text: '足す', onclick: () => { const t = add.value.trim(); if (t && !words.includes(t)) { words.push(t); on.add(t); add.value = ''; draw(); } } })),
      fit, err,
      h('div', { class: 'cc-btns' }, h('button', { type: 'button', class: 'btn-ink confirm-moods', text: 'これでいい', onclick: async (e) => { if (await patch({ confirm: 'moods', value: { ja: words.filter((x) => on.has(x)), fit: fit.value.trim() || null } }, e.currentTarget, err)) { state.editing.moods = false; say('bot', `気分の言葉を確定しました。${state.view.say}`); render(); } } })));
    return box;
  }

  // 部屋で見るの部屋：大きさから自動。押して選び直せる
  function roomsBox(w, v) {
    const box = h('section', { class: 'cc' }, h('h3', { class: 'cc-h', text: '部屋で見る' }));
    if (!w.size_cm) { box.append(h('p', { class: 'note', text: '大きさが決まると、合う部屋を選びます。' })); return box; }
    const chosen = new Set(v.rooms.map((r) => r.name));
    const err = h('p', { class: 'err', role: 'alert' }); err.hidden = true;
    box.append(h('p', { class: 'note', text: v.rooms_auto ? '大きさから自動で選んでいます。押すと選び直せます。' : '選び直した部屋です。' }),
      h('div', { class: 'chips' }, v.room_choices.map((r) => h('button', { type: 'button', class: `chip${chosen.has(r.name) ? ' on' : ''}`, 'aria-pressed': String(chosen.has(r.name)), disabled: locked(), text: r.label, title: `${r.suits_cm ? `長辺 ${r.suits_cm[0]}〜${r.suits_cm[1]} cm 向き` : ''}`, onclick: async (e) => {
        const next = new Set(chosen);
        if (next.has(r.name)) next.delete(r.name); else next.add(r.name);
        if (await patch({ rooms: next.size ? [...next] : null }, e.currentTarget, err)) renderCard();
      } }))),
      err,
      !v.rooms_auto && !locked() ? h('button', { type: 'button', class: 'fix', text: '自動に戻す', onclick: async (e) => { if (await patch({ rooms: null }, e.currentTarget, err)) renderCard(); } }) : '');
    return box;
  }

  // 公開する（R1 は queued にするだけ）
  function footer(v) {
    const d = state.draft;
    const box = h('section', { class: 'cc cc-foot' });
    const msg = h('p', { class: 'pub-msg', role: 'status' });
    if (d.status === 'queued' || d.status === 'building' || d.status === 'published') {
      msg.textContent = d.status === 'queued' ? '公開の準備ができました（R2 のコマンドで公開します）' : d.status === 'building' ? 'いま公開しています' : '公開しました';
      box.append(msg);
      if (d.status === 'published' && d.publish?.page_url) box.append(h('p', {}, h('a', { href: d.publish.page_url, target: '_blank', rel: 'noopener', text: '作品ページを開く' })));
      if (d.status === 'queued') box.append(h('button', { type: 'button', class: 'text-btn', text: '下書きに戻して直す', onclick: async (e) => { if (await patch({ reopen: true }, e.currentTarget, null)) { say('bot', '下書きに戻しました。直したら、もう一度「公開する」を押してください。'); render(); } } }));
      return box;
    }
    if (d.status === 'failed') box.append(h('p', { class: 'notice', text: '前の公開は途中で止まりました。直してから、もう一度「公開する」を押してください。' }));
    const ready = !v.missing.length;
    box.append(h('p', { class: 'note', text: ready ? `「公開する」を押すと、公開の準備に入ります。${v.pay_line}。` : `あと：${v.missing.join('、')}` }));
    const btn = h('button', { type: 'button', class: 'btn-ink pub-btn', text: '公開する', disabled: !ready });
    const sure = h('div', { class: 'pub-sure' });
    sure.hidden = true;
    btn.addEventListener('click', () => { sure.hidden = false; btn.hidden = true; sure.querySelector('button')?.focus(); });
    sure.append(h('p', { text: `この内容で公開の準備をします。${v.pay_line}。` }),
      h('div', { class: 'cc-btns' },
        h('button', { type: 'button', class: 'btn-ink pub-yes', text: 'はい、公開する', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = await call(`/api/admin/works/${d.id}/queue`, { method: 'POST' });
            state.draft = r.draft; state.view = r.view;
            say('bot', r.message || '公開の準備ができました（R2 のコマンドで公開します）');
            render();
          } catch (ex) {
            if (ex instanceof Unauthorized) return ui.onUnauthorized();
            msg.textContent = ex.message; e.currentTarget.disabled = false;
          }
        } }),
        h('button', { type: 'button', class: 'btn-line', text: 'やめる', onclick: () => { sure.hidden = true; btn.hidden = false; btn.focus(); } })));
    box.append(btn, sure, msg);
    return box;
  }

  // ───── 作品の一覧 ─────
  async function loadList() {
    listRoot.replaceChildren(h('p', { class: 'msg', text: '読み込んでいます' }));
    let d;
    try { d = await call('/api/admin/works'); } catch (e) { failed(e, listRoot); return; }
    const drafts = d.drafts || [];
    const draftBox = h('section', { class: 'panel' }, h('h2', { text: '下書きと公開の待ち' }));
    if (!d.ready) draftBox.append(h('div', { class: 'notice' }, h('b', { text: '登録はまだ使えません。' }), ` ${d.message || ''}`));
    else if (!drafts.length) draftBox.append(h('p', { class: 'empty', text: 'まだ下書きはありません。「作品を登録」から始めます。' }));
    else draftBox.append(h('ul', { class: 'wl' }, drafts.map((x) => draftItem(x))));
    const works = d.works || [];
    const workBox = h('section', { class: 'panel' }, h('h2', { text: '公開中の作品' }),
      h('p', { class: 'sub', text: '直す・売れた・値段の変更を管理画面から行うのは、次の段（R5）で作ります。' }),
      works.length ? h('ul', { class: 'wl' }, works.map((w) => h('li', { class: 'wl-item' },
        w.thumb ? h('img', { class: 'thumb', src: w.thumb, alt: '', width: 48, height: 48, loading: 'lazy' }) : h('span', { class: 'thumb' }),
        h('div', { class: 'wl-text' }, h('b', { text: w.title }), h('span', { class: 'note', text: [w.year, Array.isArray(w.size_cm) ? `${w.size_cm[0]} × ${w.size_cm[1]} cm` : '', { available: '販売中', sold: '売約済み', not_for_sale: '非売品' }[w.availability] || ''].filter(Boolean).join(' ・ ') })),
        w.url ? h('a', { class: 'text-btn', href: w.url, target: '_blank', rel: 'noopener', text: '作品ページ' }) : ''))) : h('p', { class: 'empty', text: '作品のカタログを読めませんでした。' }));
    listRoot.replaceChildren(draftBox, workBox);
  }
  function draftItem(x) {
    const w = x.data?.work || {};
    const li = h('li', { class: 'wl-item' });
    const err = h('p', { class: 'err', role: 'alert' }); err.hidden = true;
    const actions = h('div', { class: 'wl-act' },
      h('button', { type: 'button', class: 'text-btn', text: '開く', onclick: () => { remember(x.id); ui.goTab('register'); } }));
    if (x.status !== 'building' && x.status !== 'published') {
      const del = h('button', { type: 'button', class: 'text-btn', text: '捨てる' });
      del.addEventListener('click', () => {
        actions.replaceChildren(h('span', { class: 'warn', text: '写真ごと消します。戻せません。' }),
          h('button', { type: 'button', class: 'text-btn danger', text: '消す', onclick: async () => {
            try { await call(`/api/admin/works/${x.id}`, { method: 'DELETE' }); if (recalled() === x.id) remember(null); li.remove(); }
            catch (e) { if (e instanceof Unauthorized) return ui.onUnauthorized(); err.textContent = e.message; err.hidden = false; }
          } }),
          h('button', { type: 'button', class: 'text-btn', text: 'やめる', onclick: () => void loadList() }));
      });
      actions.append(del);
    }
    li.append(
      x.photo ? h('img', { class: 'thumb', src: x.photo.url, alt: '', width: 48, height: 48, loading: 'lazy' }) : h('span', { class: 'thumb' }),
      h('div', { class: 'wl-text' },
        h('b', { text: w.title?.ja || '（題名まだ）' }),
        h('span', { class: 'note' }, h('span', { class: `badge ${x.status}`, text: STATUS[x.status] || x.status }), ` ${fmt.format(x.updated_at)}`, x.status === 'draft' && x.missing?.length ? ` ・ あと ${x.missing.length} 項目` : ''),
        err),
      actions);
    return li;
  }

  return { load, loadList };
}
