import { t, type Lang } from '../i18n';

export interface Hud {
  root: HTMLDivElement; close: HTMLButtonElement; skip: HTMLButtonElement; pause: HTMLButtonElement; title: HTMLDivElement; paused: HTMLDivElement;
  ending: HTMLDivElement; once: HTMLDivElement; caption: HTMLDivElement; vignette: HTMLDivElement; debug: HTMLDivElement; textLayer: HTMLDivElement;
  setLang(l: Lang): void; dispose(): void;
}

export function buildHud(parent: HTMLElement, lang: Lang, opts: { fromQr: boolean; debug: boolean; hasRooms: boolean; contact: string | null }): Hud {
  const root = document.createElement('div'); root.className = 'hud';
  const textLayer = document.createElement('div'); textLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  const vignette = document.createElement('div'); vignette.className = 'vignette';
  const close = document.createElement('button'); close.className = 'close'; close.textContent = '×';
  const skip = document.createElement('button'); skip.className = 'skip';
  const pause = document.createElement('button'); pause.className = 'pausebtn'; pause.textContent = '❚❚'; pause.hidden = true;   // 語りの間だけ見せる（StoryMode）
  const title = document.createElement('div'); title.className = 'title';
  const paused = document.createElement('div'); paused.className = 'paused';
  const once = document.createElement('div'); once.className = 'once';
  const ending = document.createElement('div'); ending.className = 'ending';
  // 終わりに絵が部屋へ着地したあとの、比較の一文（「このドアの約 3 分の 1 の高さ。」）。終わりのボタンの上に置く
  const caption = document.createElement('div'); caption.className = 'caption';
  const debug = document.createElement('div'); debug.className = 'debug'; debug.hidden = !opts.debug;
  const btn = (id: string, key: string, primary = false) => { const b = document.createElement('button'); b.className = 'btn' + (primary ? ' primary' : ''); b.dataset.i18n = key; b.dataset.action = id; ending.appendChild(b); return b; };
  btn('again', 'again', true);
  if (opts.fromQr) btn('save', 'save');
  if (opts.hasRooms) btn('rooms', 'rooms_other');   // 終わりの画面は絵がもう部屋に掛かっているので「ほかの部屋でも見る」（11-08 作家）
  if (opts.contact) btn('contact', 'contact');
  btn('close', 'close');
  root.append(vignette, textLayer, title, paused, once, caption, ending, pause, skip, close, debug);
  parent.appendChild(root);
  // 一時停止ボタンの読み上げは操作の文言（「一時停止」／「再開」）。状態の表示（paused の「一時停止中」）とは分ける（FIX-A の引き継ぎ）。
  // 状態は StoryMode が記号（❚❚ / ▶）で切り替えるので、記号の変化を見て当て直す
  let cur = lang;
  const labelPause = () => pause.setAttribute('aria-label', t(pause.textContent === '▶' ? 'hud_resume' : 'hud_pause', cur));
  new MutationObserver(labelPause).observe(pause, { childList: true, characterData: true, subtree: true });
  const hud: Hud = {
    root, close, skip, pause, title, paused, ending, once, caption, vignette, debug, textLayer,
    setLang(l) {
      close.setAttribute('aria-label', t('close', l)); skip.textContent = t('skip', l); paused.textContent = t('pause', l); cur = l; labelPause();
      once.textContent = opts.fromQr ? t('once_more', l) : '';
      ending.querySelectorAll<HTMLElement>('[data-i18n]').forEach((b) => (b.textContent = t(b.dataset.i18n!, l)));
    },
    dispose() { root.remove(); },
  };
  hud.setLang(lang);
  return hud;
}
