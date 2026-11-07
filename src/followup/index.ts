// 感想カードの本体（docs/ADMIN.md 3 節）。絵を見たあとに案内役が小さく現れて「この絵は気に入った？」と聞く
// 送るまで何も保存しない。「作家に届ける」を押した文だけが /api/followup/send に行く。Claude が使えなければ定型文で最後まで通す
// 文はすべて textContent で入れる
import { t, ensureLang, type Lang } from '../i18n';
import { splitPhrases } from '../text/phrases';
import type { Card, Place } from './trigger';
import './followup.css';

type Reaction = 'love' | 'curious' | 'unsure';
export const TEXT_MAX = 300;
export const TURNS = 2;
const CHAT_TIMEOUT_MS = 12_000;
const SENT_CLOSE_MS = 5000;

export interface FollowupOptions {
  workId: string; place: Place; parent: HTMLElement; lang: Lang; ai: boolean; manual: boolean; sid: string | null;
  stat: (ev: string, id?: string | null, via?: string | null) => void;
  remember: (v: 'closed' | 'sent') => void;
}

export const REPLY_KEY: Record<Reaction | 'write', string> = { love: 'fu_after_love', curious: 'fu_after_curious', unsure: 'fu_after_unsure', write: 'fu_after_write' };

// 送る文：話した順に改行でつなぐ
export const joinTexts = (texts: readonly string[]) => texts.map((s) => s.trim()).filter(Boolean).join('\n');

const newId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

// 日本語は文節の間だけで改行する（docs/DESIGN.md「改行の決まり」）
function setText(node: HTMLElement, text: string, lang: Lang) {
  if (!lang.startsWith('ja')) { node.textContent = text; return; }
  node.replaceChildren();
  text.split('\n').forEach((ln, i) => {
    if (i) node.appendChild(document.createElement('br'));
    for (const ph of splitPhrases(ln, 'ja')) {
      const s = document.createElement('span');
      s.className = 'fu-ph';
      s.textContent = ph;
      node.appendChild(s);
    }
  });
}

export async function openFollowup(o: FollowupOptions): Promise<Card> {
  await ensureLang(o.lang);
  const lang = o.lang;
  const tt = (k: string) => t(k, lang);
  const sendId = newId();
  let reaction: Reaction | null = null;
  let texts: string[] = [];     // いま確認の欄に出す文（案内役にも渡す）。確認で直したら、直した文に置きかえる
  let turns = 0;                // 話した回数
  let open = true;
  let freeLogged = false;
  let closeTimer = 0;
  const pending = new AbortController();

  const root = el('aside', 'fu');
  root.setAttribute('aria-label', tt('fu_aria'));
  root.tabIndex = -1;
  const x = el('button', 'fu-x', root);
  x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', tt('fu_close'));
  const head = el('div', 'fu-head', root);
  const pic = el('img', 'fu-face', head);
  pic.src = '/concierge/artist/smile-bust.webp'; pic.alt = ''; pic.width = 44; pic.height = 44; pic.decoding = 'async';
  const say = el('p', 'fu-say', head);
  say.setAttribute('aria-live', 'polite');
  const mine = el('p', 'fu-mine', root);
  mine.hidden = true;
  const body = el('div', 'fu-body', root);

  // 帯の上に出す（T5）。キーボードが出たらその上へ
  const placeAboveBand = () => {
    const band = root.parentElement?.id === 'stage' ? document.querySelector('.end-band.on') : null;
    root.style.setProperty('--fu-bottom', band ? `${Math.round(band.getBoundingClientRect().height) + 8}px` : '0px');
  };
  const vv = window.visualViewport;
  const onViewport = () => { if (vv) root.style.setProperty('--fu-kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`); };
  vv?.addEventListener('resize', onViewport);

  // スマホで作品ページに戻ったとき：カードが説明文と帯に被らないよう、被る分だけページを上げる。ページの終わりもカードに隠れないよう余白を足す
  const pageMain = () => (root.parentElement === document.body ? document.querySelector<HTMLElement>('main.work') : null);
  const keepClear = () => {
    const main = pageMain();
    if (!main || root.hidden || !matchMedia('(max-width: 639.98px)').matches) return;
    const top = root.getBoundingClientRect().top;
    main.style.paddingBottom = `${Math.round(innerHeight - top) + 16}px`;
    const anchor = document.querySelector('.via-band') || document.querySelector('.titling');
    const over = anchor ? anchor.getBoundingClientRect().bottom + 8 - top : 0;
    if (over > 0) window.scrollBy({ top: over, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const dispose = () => {
    if (!open) return;
    open = false;
    clearTimeout(closeTimer);
    pending.abort();
    vv?.removeEventListener('resize', onViewport);
    const main = pageMain();
    if (main) main.style.paddingBottom = '';
    root.remove();
  };
  const close = () => { o.stat('fu_close', o.workId); o.remember('closed'); dispose(); };
  x.addEventListener('click', close);
  // 物語モードの操作（絵に触れる、Esc で閉じる、スペース）に届かないように
  root.addEventListener('pointerdown', (e) => e.stopPropagation());
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') e.stopPropagation();
  });

  const focusIfFine = (node: HTMLElement) => { if (matchMedia('(pointer: fine)').matches) node.focus({ preventScroll: true }); else root.focus({ preventScroll: true }); };
  const button = (label: string, cls: string, onClick: () => void, parent: HTMLElement = body) => {
    const b = el('button', cls, parent);
    b.type = 'button';
    setText(b, label, lang);
    b.addEventListener('click', onClick);
    return b;
  };

  // ───── 1. 反応 ─────
  function renderAsk() {
    setText(say, tt('fu_ask'), lang);
    body.replaceChildren();
    const list = el('div', 'fu-opts', body);
    for (const r of ['love', 'curious', 'unsure'] as const) {
      button(tt(`fu_r_${r}`), 'fu-opt', () => { reaction = r; o.stat('fu_reaction', o.workId, r); renderTalk(tt(REPLY_KEY[r])); }, list);
    }
    button(tt('fu_write'), 'fu-opt', () => { o.stat('fu_reaction', o.workId, 'write'); renderTalk(tt(REPLY_KEY.write)); }, list);
  }

  // ───── 2. ことば ─────
  function renderTalk(line: string) {
    setText(say, line, lang);
    body.replaceChildren();
    const form = el('form', 'fu-form', body);
    const area = el('textarea', 'fu-area', form);
    area.rows = 2; area.maxLength = TEXT_MAX; area.placeholder = tt('fu_placeholder'); area.setAttribute('aria-label', tt('fu_placeholder'));
    const talk = button(tt('fu_talk'), 'fu-send', () => {}, form);
    talk.type = 'submit'; talk.disabled = true;
    area.addEventListener('input', () => { talk.disabled = !area.value.trim(); });
    if (o.ai) setText(el('p', 'fu-note', form), tt('fu_ai_note'), lang);   // 返事を作るために Claude API へ渡す（docs/ADMIN.md 1 節）
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = area.value.trim();
      if (v) void talkTo(v);
    });
    // 文を書かなくても、反応だけ届けられる（反応を選んだときだけ）
    if (turns) button(tt('fu_no_more'), 'fu-sub', () => renderConfirm(tt('fu_confirm')));
    else if (reaction) button(tt('fu_no_words'), 'fu-sub', () => renderConfirm(tt('fu_confirm_reaction')));
    focusIfFine(area);
  }

  // ───── 3. 案内役の返事（1〜2 往復）。保存しない。だめなら定型文 ─────
  async function askGuide(): Promise<string | null> {
    if (!o.ai) return null;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    pending.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
    try {
      // 確認で直した長い文は、API の 1 文の上限まで
      const res = await fetch('/api/followup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lang, work: o.workId, reaction, texts: texts.map((s) => s.slice(0, TEXT_MAX)) }), signal: ctrl.signal });
      if (!res.ok) return null;
      const d = await res.json() as { reply?: unknown };
      return typeof d.reply === 'string' && d.reply ? d.reply : null;
    } catch { return null; } finally { clearTimeout(timer); pending.signal.removeEventListener('abort', onAbort); }
  }
  async function talkTo(v: string) {
    texts = [...texts, v];
    turns++;
    if (!freeLogged) { freeLogged = true; o.stat('fu_free', o.workId); }   // あったことだけ。文は送らない
    mine.hidden = false;
    setText(mine, v, lang);
    body.replaceChildren();
    const dots = el('p', 'fu-dots', body);
    dots.setAttribute('aria-label', tt('fu_thinking'));
    for (let i = 0; i < 3; i++) el('i', '', dots);
    const reply = await askGuide();
    if (!open) return;
    mine.hidden = true;
    renderConfirm(tt('fu_confirm'), reply || tt('fu_thanks'));
  }

  // ───── 4. 確認して送る ─────
  function renderConfirm(question: string, reply?: string) {
    setText(say, reply ? `${reply}\n${question}` : question, lang);
    body.replaceChildren();
    const words = joinTexts(texts);
    let area: HTMLTextAreaElement | null = null;
    if (words) {
      area = el('textarea', 'fu-area', body);
      area.rows = Math.min(6, Math.max(2, words.split('\n').reduce((n, ln) => n + Math.ceil(ln.length / 17 || 1), 0)));
      area.maxLength = 620; area.value = words; area.setAttribute('aria-label', tt('fu_placeholder'));
    } else if (reaction) {
      setText(el('p', 'fu-picked', body), tt(`fu_r_${reaction}`), lang);
    }
    const note = el('p', 'fu-note', body);
    setText(note, tt('fu_note'), lang);
    const link = el('a', 'fu-data', note);
    link.href = '/data-note.html'; link.target = '_blank'; link.rel = 'noopener'; link.textContent = tt('fu_data');
    const send = button(tt('fu_send'), 'fu-send', () => void doSend(area, send, status));
    const status = el('p', 'fu-status', body);
    status.setAttribute('role', 'status');
    // 文を全部消して、反応も選んでいないときは届けるものが無い：押せなくして、理由を添える
    if (area && !reaction) area.addEventListener('input', () => {
      const empty = !area!.value.trim();
      send.disabled = empty;
      setText(status, empty ? tt('fu_need_words') : '', lang);
    });
    if (o.ai && turns && turns < TURNS) button(tt('fu_more'), 'fu-sub', () => {
      // 確認の欄で直した文を残す（次の返事にも、次の確認にも、直した文を使う）
      const edited = area ? area.value.trim() : '';
      if (edited !== words) texts = edited ? [edited] : [];
      renderTalk(tt('fu_more_line'));
    });
    button(tt('fu_no_send'), 'fu-sub', close);
    focusIfFine(send);
  }

  async function doSend(area: HTMLTextAreaElement | null, send: HTMLButtonElement, status: HTMLElement) {
    const text = area ? area.value.trim() : '';
    if (!text && !reaction) return;
    send.disabled = true;
    setText(send, tt('fu_sending'), lang);
    setText(status, '', lang);
    let ok = false;
    try {
      const res = await fetch('/api/followup/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sendId, sid: o.sid, work: o.workId, reaction, text, lang, place: o.place }), signal: pending.signal });
      ok = res.ok;
    } catch { ok = false; }
    if (!open) return;
    if (!ok) {
      // 正直に伝える。文はそのまま。同じ id で送り直すので二重にならない
      send.disabled = false;
      setText(send, tt('fu_retry'), lang);
      setText(status, tt('fu_fail'), lang);
      return;
    }
    o.stat('fu_sent', o.workId);
    o.remember('sent');
    setText(say, tt('fu_sent'), lang);
    body.replaceChildren();
    closeTimer = window.setTimeout(dispose, SENT_CLOSE_MS);
  }

  o.parent.appendChild(root);
  placeAboveBand();
  onViewport();
  requestAnimationFrame(keepClear);
  o.stat('fu_shown', o.workId, o.place);
  renderAsk();
  if (o.manual) root.querySelector<HTMLElement>('.fu-opt')?.focus({ preventScroll: true });   // 自分で開いたときだけフォーカスを移す

  return {
    isOpen: () => open,
    dismiss: dispose,
    setHidden(h) { root.hidden = h; if (!h) { onViewport(); requestAnimationFrame(keepClear); } },
    moveTo(parent) { if (open && root.parentElement !== parent) { parent.appendChild(root); placeAboveBand(); requestAnimationFrame(keepClear); } },
  };
}
