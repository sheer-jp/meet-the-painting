// 受付（docs/ENTRANCE.md 3 節）。上にキャラクター、下に会話。おすすめの 1 点は別の画面（C2）に 3 段で出す（3.5）
// 見出し・キャラクター・最初の 2 文・選択肢・入力欄・C2 の枠は HTML にあり（pages.js）、ここは会話を動かすだけ
// 会話の文はこのタブのメモリにだけ持ち、どこにも保存しない。ブラウザに残すのは合言葉（通ったときだけ）と、直前のおすすめ（sessionStorage）。押した選択肢などの出来事は page.ts が送る（docs/ADMIN.md）
import { t, pick, applyLang, titlePair, onLangLoaded, type Lang } from '../i18n';
import { recommendByRules, targetAxes, axisDistance, pickMoods, buildReason, type Answers, type Catalog, type CatalogWork } from '../recommend/rules';
import { splitRecommendation, resolveRecommendation, parseRecommendEvent, reasonText, type RecJson } from '../recommend/parse';
import { LAST_REC_KEY, type LastRec } from './last';
import { nextStage, stageMs, type Stage } from './stages';
import { vrAvailable, afterUrl } from './enter';
import { Soundscape } from '../audio/Soundscape';
import { splitPhrases } from '../text/phrases';
import './concierge.css';

declare global { interface Window { __ETP_FAST?: boolean } }   // テストで 3 段の待ち時間を縮める

type Msg = { role: 'user' | 'assistant'; content: string };
export type Face = 'listening' | 'smile' | 'present';
const FACES = ['listening', 'smile', 'present'] as const;
const IDLE_MOTIONS = ['nod', 'tilt', 'tilt2'];   // 待っている・聞いているあいだの小さな動き

// ───── コマ列の定義（frames.json の 1 項目）。["a", "b"]（1 コマ ms 既定）か { "seq": [...], "ms": 160 | [120, 160, ...] } ─────
export const FRAME_MS = 120;
export type FrameDef = { seq: string[]; ms: number[] };
export function parseFrameDef(v: unknown, defMs = FRAME_MS): FrameDef | null {
  const o = Array.isArray(v) ? { seq: v, ms: undefined } : v && typeof v === 'object' ? v as { seq?: unknown; ms?: unknown } : null;
  if (!o || !Array.isArray(o.seq) || !o.seq.length || !o.seq.every((x) => typeof x === 'string' && /^[a-z0-9-]+$/i.test(x))) return null;
  const seq = o.seq as string[];
  const okMs = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 30 && x <= 3000;
  const base = okMs(o.ms) ? o.ms : defMs;
  const ms = seq.map((_, i) => (Array.isArray(o.ms) && okMs(o.ms[i]) ? o.ms[i] as number : base));
  return { seq, ms };
}

// ───── 文節の改行（P-14。docs/DESIGN.md「改行の決まり」）。日本語は文節ごとに inline-block の span、改行は文節の間だけ ─────
// 文節の並び。改行（\n）はそれだけの要素として返す（span の外に置く）
export function phraseRuns(text: string, lang: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((ln, i) => {
    if (i) out.push('\n');
    // 文節の端の空白は別の要素に（inline-block の端の空白は行末の処理で消え、「New Chapter」が「NewChapter」になるため）
    if (ln) for (const ph of splitPhrases(ln, lang)) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(ph)!;
      for (const x of [m[1], m[2], m[3]]) if (x) out.push(x);
    }
  });
  return out;
}
// ストリーミングで、文が確定したところまでの長さ：最後の改行のあと、または句読点のあとに「次の文節の頭」（閉じ括弧・句読点・空白でない文字）が
// もう来ているところ。句読点が終わりの文字のときや閉じ括弧が続くときは確定させない（「はい。」と の「と」は閉じ括弧の前にくっつくので、
// 閉じ括弧で切ると全文で切ったときと文節がずれる。REVIEW-2 P2）
const PUNCT = /[。、，．！？!?…]/;
const NOT_HEAD = /[\s。、，．！？!?…」』）)\]】〉》〕”’]/;
export function settledLength(text: string): number {
  for (let i = text.length - 2; i >= 0; i--) {
    if (text[i] === '\n') return i + 1;
    if (PUNCT.test(text[i]) && !NOT_HEAD.test(text[i + 1])) return i + 1;
  }
  return 0;
}
// 要素の中身を文節の span にする（日本語以外は文字列のまま）。done が偽なら、確定していない終わりの部分は文字列のまま
// ストリーミング（REVIEW-2 P2）：確定した長さを要素ごとに覚え、伸びた分の文節だけ span を足す。未確定の終わりは最後の 1 つの文字ノードの中身だけ差し替える
// （毎回作り直すと span の数が文の長さの 2 乗で増え、aria-live の欄で同じ文節が繰り返し読まれるおそれがある）
// 確定した前置部は句読点のあとで切れるので、足した分を別に文節にしても、全文を一度に文節にしたときと境目は同じ
const filled = new WeakMap<HTMLElement, { text: string; tail: Text }>();   // 確定して span にした文字列と、終わりの文字ノード
export function fillPhrases(el: HTMLElement, text: string, lang: string, done = true) {
  const ja = lang.startsWith('ja');
  const n = !ja || done ? text.length : settledLength(text);
  let st = filled.get(el);
  // 前回の続きでなければ（別の文・言語の切り替えなど）最初から
  if (!st || !text.startsWith(st.text) || el.lastChild !== st.tail) {
    el.textContent = '';
    st = { text: '', tail: document.createTextNode('') };
    el.appendChild(st.tail);
    filled.set(el, st);
  }
  const add = text.slice(st.text.length, Math.max(n, st.text.length));
  if (add) {
    const frag = document.createDocumentFragment();
    if (!ja) frag.append(add);
    else for (const ph of phraseRuns(add, lang)) {
      if (/^\s+$/.test(ph)) { frag.append(ph); continue; }   // 改行・空白は span の外の文字（空白は折り返しの位置にもなる）
      const sp = document.createElement('span');
      sp.className = 'cg-ph';
      sp.textContent = ph;
      frag.appendChild(sp);
    }
    el.insertBefore(frag, st.tail);
    st.text += add;
  }
  const rest = text.slice(st.text.length);
  if (st.tail.data !== rest) st.tail.data = rest;
}

const FIRST_BYTE_MS = 20000;          // 最初の文字がこれだけ来なければルールだけの版へ（モデルの思考で最初の文が遅れることがある）
const STALL_MS = 20000;               // 文が来始めたあと、これだけ何も来なければ止まったとみなす（REVIEW-1 P2。上流を切ってルールだけの版へ）

// 選択肢のプールから n 個の番号（REVIEW-1 P2）。Fisher–Yates で偏りなく並べ替え、種類（kinds）が重ならないものを先に、足りなければ残りから。
// 選んだ番号は会話のあいだ持ち続ける（言語を切り替えても選び直さない）。rand はテストで差し替える
export function pickOpeners(pool: readonly unknown[], kinds: readonly string[], n: number, rand: () => number = Math.random): number[] {
  const idx = [...pool.keys()];
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const used = new Set<string>(); const out: number[] = [];
  for (const i of idx) { const k = kinds[i] || String(i); if (used.has(k)) continue; used.add(k); out.push(i); if (out.length === n) return out; }
  for (const i of idx) { if (out.length === n) break; if (!out.includes(i)) out.push(i); }
  return out;
}
// 選んだ番号の文を、閲覧者の言語で（無ければ en → ja）
export function openerTexts(pool: Partial<Record<Lang, string[]>>, picked: readonly number[], lang: Lang): string[] {
  return picked.map((i) => pool[lang]?.[i] ?? pool.en?.[i] ?? pool.ja?.[i] ?? '');
}
const PASS_KEY = 'etp.passphrase';    // 合言葉を覚える localStorage の鍵（通ったときだけ保存）
// 全身を見せる条件（pages.js の FULL_MQ と同じ。HTML の <source media> があればそれを使う）
const FULL_MQ = '(orientation: landscape) and (max-height: 500px), (orientation: landscape) and (min-width: 900px)';

// ルールだけの版の 3 問
const QUESTIONS = [
  { key: 'time', q: 'rec_q_time', opts: ['morning', 'day', 'night'], label: 'rec_time_' },
  { key: 'color', q: 'rec_q_color', opts: ['warm', 'cool', 'vivid', 'soft'], label: 'rec_color_' },
  { key: 'mood', q: 'rec_q_mood', opts: ['quiet', 'lively'], label: 'rec_mood_' },
] as const;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

const store = (s: () => Storage) => ({
  get(k: string): string | null { try { return s().getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { s().setItem(k, v); } catch { /* 保存できなくても進める */ } },
  del(k: string) { try { s().removeItem(k); } catch { /* 同上 */ } },
});
const local = store(() => localStorage);
const session = store(() => sessionStorage);

// 光の色：絵の主要色（palette の先頭）の色相のまま、明度を上げる（白のベタ光にしない）
export function glowColor(hex: string | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 'hsl(40 60% 82%)';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let hue = 0;
  if (d) hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return `hsl(${Math.round((hue * 60 + 360) % 360)} ${Math.round(Math.min(sat, 0.85) * 100)}% ${Math.round(Math.max(l, 0.8) * 100)}%)`;
}

export interface ConciergeOptions {
  lang: Lang;
  api: string | null;          // POST /api/recommend。null ならルールだけの版
  configUrl: string;           // GET /api/recommend/config（{ passphrase: boolean }）
  catalogUrl: string;          // catalog.json（受付と同じ階層）
  retry: string | null;        // ?retry=<id>：作品ページの「別のにする」から戻ってきた
  stat?: (ev: string, id?: string | null, via?: string | null) => void;   // 計測（E-14。page.ts の stat。数だけ）
}

// catalog.json の受付の固定文（E-15。scripts/generate/catalog.js）。無い古いカタログでは HTML の ja / en のまま
type UiCatalog = Catalog & {
  openers_pool?: Partial<Record<Lang, string[]>> & { kinds?: string[] };   // 選択肢のプール（11-07）。kinds は種類
  greeting?: Partial<Record<Lang, string[]>>;
  present_line?: Partial<Record<Lang, string>>;
  ui_hint?: Partial<Record<Lang, string>>;
  ui_write?: Partial<Record<Lang, string>>;
};

export type SoldStatuses = Record<string, { soldOut?: boolean } | undefined>;
// 売れた絵を除く。全部売れていたら除かない（元のカタログは変えない）
export function dropSold<T extends { works: { title?: { ja?: string } }[] }>(c: T, st: SoldStatuses): T {
  const left = c.works.filter((w) => !st[w.title?.ja ?? '']?.soldOut);
  return left.length && left.length < c.works.length ? { ...c, works: left } : c;
}

export function mountConcierge(root: HTMLElement, opts: ConciergeOptions): void {
  if (root.dataset.mounted) return;
  root.dataset.mounted = '1';
  let lang = opts.lang;
  const catalogHref = new URL(opts.catalogUrl, location.href);
  const abs = (p: string) => new URL(p, catalogHref).href;

  const thread = root.querySelector<HTMLElement>('.cg-thread')!;
  const form = root.querySelector<HTMLFormElement>('.cg-form')!;
  const input = form.querySelector<HTMLInputElement>('input')!;
  const send = form.querySelector<HTMLButtonElement>('button')!;
  const faces = root.querySelector<HTMLElement>('.cg-faces')!;
  const initialThread = thread.innerHTML;   // 「もう一度、話す」で最初の 2 文と選択肢に戻すため
  // おすすめの画面 C2（3.5）。枠とひとこと（present_line）は HTML。キャラクターとカードはここで入れる
  const c2 = root.querySelector<HTMLElement>('.cg2')!;
  const c2Host = c2.querySelector<HTMLElement>('.cg2-host')!;
  const c2Line = c2.querySelector<HTMLElement>('.cg2-line')!;
  const c2LineInit = c2Line.innerHTML;
  const behind = [...root.children].filter((el) => el !== c2) as HTMLElement[];   // C2 のあいだは操作できなくする
  let stage: Stage = 'talk';
  let c2Pushed = false;             // C2 を history に積んでいる
  if (history.state?.cg2) history.replaceState(null, '');   // 読み直したときに古い C2 の履歴を残さない

  // API が無い・オフラインなら最初からルールだけの版。一度落ちたらこのページではそのまま
  const noApi = !opts.api || navigator.onLine === false;
  let rulesMode = noApi;
  let messages: Msg[] = [];
  let busy = false;
  const stat = opts.stat ?? (() => {});
  let statStarted = false;          // concierge_start は 1 回の会話に 1 回（reset で戻す）
  let sess = 0;                     // 「もう一度」で古い応答を捨てるための番号
  let mode: 'talk' | 'pass' | 'done' = 'talk';
  let pending: { text: string; extra: boolean } | null = null;   // 合言葉を聞いている間、最初のことばを預かる
  let passphrase = local.get(PASS_KEY);
  // いま出しているおすすめと、「別のにする」の状態
  let current: { id: string; alt: string | null } | null = null;
  let shown = new Set<string>();
  let otherPresses = 0;
  // 会話ごとの種（AI が投げる問いの選び方に使う。「もう一度」で引き直す）
  let seed = newSeed();
  function newSeed() { return Math.random().toString(36).slice(2, 10); }
  // 選択肢のプールから 3 つ（読み込みごと・「もう一度」ごとにシャッフル。11-07 作家）。最初の 3 つ（従来の選択肢）も候補に入る
  let openerPick: number[] = [];
  let extraUsed = false;            // AI への「別の絵を」の 1 往復を使った
  let rulesRank: string[] | null = null;   // ルールだけの版：近い順の作品

  // 合言葉が要るか（読めない・形が違うときは要らないものとして進める）
  const passNeeded: Promise<boolean> = noApi ? Promise.resolve(false) : fetch(opts.configUrl, { headers: { accept: 'application/json' } })
    .then(async (r) => {
      if (!r.ok || !/json/.test(r.headers.get('content-type') || '')) return false;
      const c = await r.json() as { passphrase?: unknown };
      return c?.passphrase === true;
    })
    .catch(() => false);

  let catalog: Catalog | null = null;
  // 売れた絵は候補から外す（「別のにする」とルールだけの版も）。販売状況を取れないときは全作品のまま
  const statusCtrl = new AbortController();
  setTimeout(() => statusCtrl.abort(), 7000);
  const statusReady: Promise<SoldStatuses> = fetch('/api/works-status', { signal: statusCtrl.signal })
    .then((r) => (r.ok ? r.json() as Promise<{ statuses?: SoldStatuses }> : null)).then((d) => d?.statuses ?? {}).catch(() => ({}));
  // 選択肢の文はカタログが届いたらすぐ出す（販売状況を待たない）。おすすめを出すときは catalogReady で販売状況まで待つ
  const catalogLoaded = fetch(catalogHref)
    .then((r) => { if (!r.ok) throw new Error('catalog ' + r.status); return r.json() as Promise<Catalog>; })
    .then((c) => { catalog = c && Array.isArray(c.works) ? c : null; labelOpeners(); return catalog; })
    .catch((e) => { console.warn('カタログを読めない', e); return null; });
  const catalogReady: Promise<Catalog | null> = catalogLoaded.then(async (c) => { if (!c) return c; catalog = dropSold(c, await statusReady); return catalog; });

  // ───── 表情（listening / smile / present）。300ms のクロスフェードは CSS。reduced-motion では即時 ─────
  const faceBase = abs('concierge/artist/');   // キャラクターは女の子に確定（11-06 作家）
  function faceEl(face: Face): HTMLElement {
    let el = faces.querySelector<HTMLElement>(`.cg-face[data-face="${face}"]`);
    if (el) return el;
    // 最初は smile だけが HTML にある。他の表情は初めて使うときに足す（pages.js の facePicture() と同じ形）
    const b = faceBase + face;
    const set = (v: string, ext: string) => `${b}-${v}.${ext} 1x, ${b}-${v}@2x.${ext} 2x`;
    el = h('picture', 'cg-face');
    el.dataset.face = face;
    const full = faces.querySelector<HTMLSourceElement>('source[media]')?.media || FULL_MQ;
    for (const [media, type, v, ext] of [[full, 'image/webp', 'full', 'webp'], [full, '', 'full', 'png'], ['', 'image/webp', 'bust', 'webp']]) {
      const src = h('source');
      if (media) src.media = media;
      if (type) src.type = type;
      src.srcset = set(v, ext);
      el.appendChild(src);
    }
    const img = h('img');
    img.src = `${b}-bust.png`; img.srcset = set('bust', 'png');
    img.width = 512; img.height = 412; img.alt = ''; img.decoding = 'async';
    el.appendChild(img);
    faces.appendChild(el);
    return el;
  }
  let face: Face = 'smile';
  // keepThinking：考え中の「…」を出すとき（thinking / ponder）だけ真。それ以外で表情を変えたら考え中は終わり
  function setFace(f: Face, keepThinking = false) {
    if (!keepThinking) setThinking(false);
    if (f === face) return;
    face = f;
    const next = faceEl(f);
    const show = () => {
      if (face !== f) return;
      faces.querySelectorAll<HTMLElement>('.cg-face').forEach((el) => el.classList.toggle('is-on', el === next));
      onFace(f, next);
    };
    const img = next.querySelector('img')!;
    // 読み込み前に切り替えると一瞬空になるので、読めてから（失敗しても）切り替える
    if (img.complete) show(); else { img.addEventListener('load', show, { once: true }); img.addEventListener('error', show, { once: true }); }
  }
  setTimeout(() => { faceEl('listening'); faceEl('present'); }, 1200);   // 最初の表示を邪魔しないよう、少し後に先読み

  // ───── コマのアニメーション（docs/ENTRANCE.md 3.3）。frames.json とコマの画像があるときだけ。無ければ待機の呼吸（CSS）だけ ─────
  // frames.json：{ "blink": ["listening", "blink", "listening"], "nod": { "seq": [...], "ms": 160 }, ... }（parseFrameDef）。既定は 1 コマ 120ms
  // コマ列の中の表情の名前（listening / smile / present）は、いまの「止まっているコマ」（data-rest。smileDeep のあとは smile-2）に置き換えて再生する
  // 動かし方（11-07 A-1、作家「もっとアニメーションっぽく」）：
  //   待っている・聞いている（smile / listening）：6〜12 秒ごとに nod / tilt / tilt2 のどれか（同じものは続けない）。listening はまばたきも
  //   入力中：3 秒ごとに nod。考え中（「…」）：think の 1 コマ目で止め、2 秒ごとに think（まばたき）。おすすめ：happy → wave。「別のにする」：tilt
  // 11-07 A-2：手の位置を合わせたコマ。いまの表情に合う列を選ぶ（smile → nod / tilt、listening → nod-down / tilt-down、present → happy-up → wave）。
  //   合う列が無い表情では動かさない（手が 1 コマで跳ぶので）
  const sequences: Record<string, FrameDef> = {};   // frames.json の列（読めたコマかどうかは canPlay が上半身／全身ごとに見る）
  // 読み込めたコマ（`<名前>-<bust|full>` → 先読みした画像）。画像の参照を持ち続けて、メモリのキャッシュに残す（下の先読みの注を参照）
  const okFrames = new Map<string, HTMLImageElement>();
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frameTimer = 0;
  let blinkTimer = 0;
  let idleTimer = 0;
  let typeTimer = 0;
  let thinkTimer = 0;
  let playingPic: HTMLElement | null = null;   // いまコマ列を再生しているキャラクター
  let thinkPic: HTMLElement | null = null;     // 考え中の顔にしているキャラクター
  let thinkingNow = false;
  let lastIdle = '';
  const swapName = (url: string, name: string) => url.replace(/\/([^/\s]+?)-(full|bust)((?:@2x)?\.(?:png|webp))/g, `/${name}-$2$3`);
  const restOf = (pic: HTMLElement) => pic.dataset.rest || pic.dataset.face!;
  // そのキャラクターがいま出している版：全身の <source media> が当たっていれば full、無ければ上半身（受付の最初の smile と C2 の写しは上半身だけ）
  const variantOf = (pic: HTMLElement): 'full' | 'bust' => {
    const m = pic.querySelector<HTMLSourceElement>('source[media]')?.media;
    return m && matchMedia(m).matches ? 'full' : 'bust';
  };
  // 動きの種類 → いまの表情に合う列（手の位置が同じコマだけ）
  const MOTION: Record<string, Partial<Record<Face, string>>> = {
    nod: { smile: 'nod', listening: 'nod-down' },
    tilt: { smile: 'tilt', listening: 'tilt-down' },
    tilt2: { smile: 'tilt2', listening: 'tilt-down2' },
    happy: { present: 'happy-up' },
  };
  const motionFor = (kind: string, pic: HTMLElement | null) => (pic ? MOTION[kind]?.[pic.dataset.face as Face] ?? null : null);
  // 列の全コマが、そのキャラクターの版（上半身／全身）で読み込めているか。読めていない列は使わない（その場で取りに行くと 120ms のコマに間に合わない）
  function canPlay(seqName: string | null, pic: HTMLElement | null): boolean {
    const def = seqName ? sequences[seqName] : null;
    if (!def || !pic) return false;
    const v = variantOf(pic);
    return def.seq.every((n) => (FACES as readonly string[]).includes(n) || okFrames.has(`${n}-${v}`));
  }
  function setFrame(pic: HTMLElement, name: string) {
    if (pic.dataset.frame === name || (!pic.dataset.frame && name === pic.dataset.face)) return;
    pic.dataset.frame = name;
    pic.querySelectorAll('source').forEach((s) => { s.srcset = swapName(s.srcset, name); });
    const img = pic.querySelector('img')!;
    img.srcset = swapName(img.srcset, name);
    img.src = swapName(img.src, name);
  }
  // いま見えているキャラクター：C2 が出ていれば C2 の上の写し（受付の窓は C2 の下に隠れている）、無ければ受付の窓
  const visiblePic = () => (!c2.hidden ? c2Host.querySelector<HTMLElement>('.cg-face') : faces.querySelector<HTMLElement>('.cg-face.is-on'));
  // 再生中のコマ列を止めて、止まっているコマに戻す
  function stopFrames() {
    clearTimeout(frameTimer);
    if (playingPic) setFrame(playingPic, restOf(playingPic));
    playingPic = null;
  }
  // 再生先は o.pic（無ければいま見えているキャラクター）。then には再生したキャラクターを渡す（続けて流すときに同じ相手か確かめる）
  function play(seqName: string | null, o: { hold?: boolean; then?: (pic: HTMLElement) => void; pic?: HTMLElement | null } = {}): boolean {
    const pic = o.pic ?? visiblePic();
    if (!seqName || !pic || reduced() || document.hidden || !canPlay(seqName, pic)) return false;
    const def = sequences[seqName];
    stopFrames();
    playingPic = pic;
    const rest = restOf(pic);
    const seq = def.seq.map((n) => ((FACES as readonly string[]).includes(n) ? rest : n));
    let i = 0;
    const step = () => {
      if (!pic.isConnected || !pic.classList.contains('is-on')) { playingPic = null; setFrame(pic, pic.dataset.face!); return; }
      setFrame(pic, seq[i]);
      const ms = def.ms[i];
      i++;
      if (i < seq.length) { frameTimer = window.setTimeout(step, ms); return; }
      frameTimer = window.setTimeout(() => {
        if (o.hold) pic.dataset.rest = seq[seq.length - 1];   // 最後のコマで止める
        else setFrame(pic, restOf(pic));
        playingPic = null;
        o.then?.(pic);
      }, ms);
    };
    step();
    return true;
  }
  function scheduleBlink() {
    clearTimeout(blinkTimer);
    if (!sequences.blink || document.hidden) return;
    blinkTimer = window.setTimeout(() => {
      if (face !== 'listening') return;
      if (!playingPic && !thinkingNow && c2.hidden) play('blink');
      scheduleBlink();
    }, 4000 + Math.random() * 3000);
  }
  // 待っている・聞いているあいだの小さな動き（6〜12 秒ごと）。条件に合わないときは見送って次を待つ
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (reduced()) return;
    idleTimer = window.setTimeout(() => {
      if (c2.hidden && (face === 'smile' || face === 'listening') && !thinkingNow && !typeTimer && !playingPic && !document.hidden) {
        const pic = visiblePic();
        const pool = IDLE_MOTIONS.filter((n) => n !== lastIdle && canPlay(motionFor(n, pic), pic));
        const n = pool[Math.floor(Math.random() * pool.length)];
        if (n && play(motionFor(n, pic), { pic })) lastIdle = n;
      }
      scheduleIdle();
    }, 6000 + Math.random() * 6000);
  }
  // 入力中（入力欄にフォーカスがあり、文字がある）：すぐに 1 回、そのあと 3 秒ごとにうなずき（表情に合う列）
  const typingNow = () => document.activeElement === input && !!input.value && mode === 'talk' && !busy && c2.hidden;
  function stopTyping() { clearTimeout(typeTimer); typeTimer = 0; }
  function onTyping() {
    if (!typingNow() || !Object.keys(sequences).length) { stopTyping(); return; }
    if (typeTimer) return;
    const tick = () => {
      if (!typingNow()) { stopTyping(); return; }
      if (!playingPic) { const pic = visiblePic(); play(motionFor('nod', pic), { pic }); }
      typeTimer = window.setTimeout(tick, 3000);
    };
    typeTimer = window.setTimeout(tick, 0);
  }
  // 考え中（「…」の吹き出し・「…考え中」の行のあいだ）：think の 1 コマ目で止め、2 秒ごとに think（まばたき）
  function startThink(pic: HTMLElement) {
    if (!canPlay('think', pic) || reduced()) return;
    clearInterval(thinkTimer);
    stopFrames();
    thinkPic = pic;
    pic.dataset.rest = sequences.think.seq[0];
    setFrame(pic, pic.dataset.rest);
    thinkTimer = window.setInterval(() => { if (!playingPic) play('think', { hold: true, pic }); }, 2000);
  }
  function setThinking(on: boolean) {
    if (on === thinkingNow) return;
    thinkingNow = on;
    if (on) { stopTyping(); const pic = visiblePic(); if (pic) startThink(pic); return; }
    clearInterval(thinkTimer);
    stopFrames();
    if (thinkPic) { thinkPic.dataset.rest = thinkPic.dataset.face!; setFrame(thinkPic, thinkPic.dataset.face!); }
    thinkPic = null;
  }
  // 表情が切り替わったとき：前のコマを戻し、表情に応じたコマ列を 1 回
  function onFace(f: Face, pic: HTMLElement) {
    stopFrames();
    faces.querySelectorAll<HTMLElement>('.cg-face').forEach((el) => { if (el !== pic) { delete el.dataset.rest; setFrame(el, el.dataset.face!); } });
    pic.dataset.rest = f;
    setFrame(pic, f);
    if (thinkingNow) { const v = visiblePic(); if (v) startThink(v); return; }   // 考え中に表情が切り替わった（画像の読み込み待ちのあと）
    if (f === 'listening') scheduleBlink();
    else clearTimeout(blinkTimer);
    if (f === 'present') {
      // うれしそうに（手を差し出したまま）→ 手を振る。再生先はいま見えている C2 の写しに固定し、
      // happy-up のあいだに C2 を閉じた・「もう一度」を押したときは wave を流さない（受付の窓に手を振るコマが出ないように。REVIEW-2 P2）
      const target = visiblePic();
      const wave = (p: HTMLElement) => { if (p === visiblePic() && face === 'present' && p.isConnected) play('wave', { pic: p }); };
      if (target && !play(motionFor('happy', target), { pic: target, then: wave })) wave(target);
    }
    if (f === 'smile') play('smileDeep', { hold: true });   // 最後のコマで止める
  }
  // タブが隠れたら、まばたき・考え中・入力中のタイマーとコマ列を止め、見えたら戻す（docs/ENTRANCE.md 3.3。REVIEW-2 P2）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopFrames(); clearTimeout(blinkTimer); clearInterval(thinkTimer); stopTyping();
      return;
    }
    if (thinkingNow) { const v = visiblePic(); if (v) startThink(v); }
    else if (face === 'listening') scheduleBlink();
    onTyping();
  });
  // frames.json を読み、コマの画像を先に読み込む。無い・壊れているときは何もしない
  // 先読み（REVIEW-2 P1）：必要になる順に、3 本ずつ並べて読む。最初の表情（smile、上半身）の列 → C2 の列（happy-up・wave・think、
  // C2 の写しはいつも上半身）→ 聞いているとき（listening。PC の横長は全身）の列。解像度（1x / @2x、WebP / PNG）は最初の顔が選んだものに合わせる。
  // 通信を節約する設定（navigator.connection.saveData）のときはコマを読まない（呼吸だけ。コマ無しで成り立つ）
  const saveData = !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  fetch(faceBase + 'frames.json')
    .then((r) => (r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : {}))
    .then(async (defs: unknown) => {
      if (!defs || typeof defs !== 'object') return;
      for (const [k, raw] of Object.entries(defs as Record<string, unknown>)) {
        const def = parseFrameDef(raw, FRAME_MS);
        if (def) sequences[k] = def;
      }
      if (face === 'listening') scheduleBlink();
      scheduleIdle();
      onTyping();
      if (saveData) return;
      const first = faces.querySelector<HTMLImageElement>('.cg-face img')!;
      if (!first.complete) await new Promise((res) => { first.addEventListener('load', res, { once: true }); first.addEventListener('error', res, { once: true }); });
      const m = /-(?:full|bust)(@2x)?\.(webp|png)(?:[?#].*)?$/.exec(first.currentSrc || first.src);
      const tail = m ? `${m[1] || ''}.${m[2]}` : '.png';
      const listenV = variantOf(faceEl('listening'));
      // 列の端の表情（smile / listening / present）も読んで持つ（コマから戻るときの画像。C2 の写しの present-bust など、手放すとメモリのキャッシュから落ちる）
      const queue: string[] = [];   // `<名前>-<版>`、必要な順、重なりなし
      const plan: [string[], string][] = [[['smileDeep', 'nod', 'tilt', 'tilt2'], 'bust'], [['happy-up', 'wave', 'think'], 'bust'], [['nod-down', 'think', 'tilt-down', 'tilt-down2', 'blink'], listenV]];
      for (const [names, v] of plan) for (const k of names) for (const n of sequences[k]?.seq ?? []) {
        const key = `${n}-${v}`;
        if (!queue.includes(key)) queue.push(key);
      }
      // 読んだ画像は参照を持ち続ける（okFrames。手放すとメモリのキャッシュから落ち、差し替えのたびに取りに行く。Cloudflare Pages の既定は
      // max-age=0, must-revalidate なので 1 往復の確認が入り、120ms のコマに間に合わない）
      const worker = async () => {
        for (let key = queue.shift(); key; key = queue.shift()) {
          const k = key;
          const im = new Image();
          const ok = await new Promise<boolean>((res) => {
            im.onload = () => res(true); im.onerror = () => res(false);
            im.src = `${faceBase}${k}${tail}`;
          });
          if (ok) okFrames.set(k, im);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    })
    .catch(() => { /* コマが無くても待機の呼吸だけで成り立つ */ });
  // ───── 文言 ─────
  function labelUi() {
    const key = mode === 'pass' ? 'cg_pass_placeholder' : 'cg_placeholder';
    input.placeholder = t(key, lang);
    input.setAttribute('aria-label', t(key, lang));
    send.textContent = t('rec_send', lang);
  }
  // ja と en は HTML の data-lang で出し分ける。他の言語はカタログに本当の訳（en と違う）があれば差し替える。
  // 差し替えるときも元の HTML（ja / en の span）を data-orig に残し、ja / en に戻したら復元する
  //（11-06 深夜：外国語にしてから日本語に戻すと英語が残るバグの修正）
  function swapText(el: HTMLElement, s: string | undefined, en: string | undefined) {
    if (el.dataset.orig === undefined) el.dataset.orig = el.innerHTML;
    if (lang !== 'ja' && lang !== 'en' && s && s !== en) { el.textContent = s; return; }
    el.innerHTML = el.dataset.orig;
    applyLang(el, lang);
  }
  // 受付の固定文（E-15）：最初の 3 文、選択肢、選択肢の上の案内、4 つ目のボタン
  function labelOpeners() {
    const c = catalog as UiCatalog | null;
    const lists = (k: 'openers' | 'greeting') => [c?.[k]?.[lang], c?.[k]?.en] as const;
    let [list, en] = lists('openers');
    const pool = c?.openers_pool;
    if (pool && (pool.ja?.length ?? 0) >= 3) {
      // 種類（kinds）がばらけるように（11-07 作家「属性がバラバラなものが出るといい」）。言語の切り替えでは選び直さない
      if (openerPick.length !== 3) openerPick = pickOpeners(pool.ja!, pool.kinds || [], 3);
      list = openerTexts(pool, openerPick, lang);
      en = openerTexts(pool, openerPick, 'en');
    }
    thread.querySelectorAll<HTMLButtonElement>('button[data-opener-index]:not(.cg-write)').forEach((b) => {
      const i = +b.dataset.openerIndex!;
      if (pool && openerPick.length === 3) {
        // プールの文で HTML の元（ja + 隠した en）を作り直す（swapText は ja / en のとき data-orig に戻すため）
        const ja = pool.ja?.[openerPick[i]] ?? '', enText = pool.en?.[openerPick[i]] ?? '';
        const s1 = h('span', '', ja); s1.setAttribute('lang', 'ja'); s1.dataset.lang = 'ja';
        const s2 = h('span', '', enText); s2.setAttribute('lang', 'en'); s2.dataset.lang = 'en'; s2.hidden = true;
        b.dataset.orig = s1.outerHTML + (enText ? s2.outerHTML : '');
      }
      swapText(b, list?.[i], en?.[i]);
    });
    const [greet, greetEn] = lists('greeting');
    thread.querySelectorAll<HTMLElement>('[data-greet]').forEach((p) => { const i = +p.dataset.greet!; swapText(p, greet?.[i], greetEn?.[i]); });
    const cap = thread.querySelector<HTMLElement>('.cg-openers-cap');
    if (cap) {
      swapText(cap, c?.ui_hint?.[lang], c?.ui_hint?.en);
      cap.parentElement?.setAttribute('aria-label', ([...cap.children].find((e) => !(e as HTMLElement).hidden) || cap).textContent?.trim() || '');
    }
    const w = thread.querySelector<HTMLElement>('.cg-write');
    if (w) swapText(w, c?.ui_write?.[lang], c?.ui_write?.en);
    thread.querySelectorAll<HTMLElement>('.cg-greet.cg-line, .cg-opt, .cg-openers-cap').forEach(phrasify);
    labelPresent();
  }
  // HTML にある日本語の文（あいさつ・選択肢・案内・ひとこと）を文節の span に。ja / en の span があれば ja の span の中だけ
  // swapText で元の HTML に戻したあとにも呼ぶ（何度呼んでもよい）
  function phrasify(el: HTMLElement) {
    const leaves = el.querySelectorAll<HTMLElement>('span[data-lang="ja"]');
    if (leaves.length) { leaves.forEach((s) => { if (!s.querySelector('.cg-ph')) fillPhrases(s, s.textContent || '', 'ja'); }); return; }
    if (!lang.startsWith('ja') || el.querySelector('.cg-ph') || el.children.length) return;
    // 他の言語から日本語に戻したなど、文字だけのとき。ボタン（flex）は文節が横に並ばないよう、包む span を 1 つ挟む
    const text = el.textContent || '';
    if (el.tagName === 'BUTTON') { const w = h('span'); fillPhrases(w, text, 'ja'); el.replaceChildren(w); } else fillPhrases(el, text, 'ja');
  }
  // おすすめの画面のひとこと（present_line）。C2 の中で差し替えた後の「では、こちらは」のときは触らない
  function labelPresent() {
    if (c2Line.dataset.other) return;
    const c = catalog as UiCatalog | null;
    swapText(c2Line, c?.present_line?.[lang], c?.present_line?.en);
    phrasify(c2Line);
  }
  labelUi();
  const langSelect = document.getElementById('lang') as HTMLSelectElement | null;
  langSelect?.addEventListener('change', () => { lang = langSelect.value as Lang; labelUi(); labelOpeners(); });
  onLangLoaded((l) => { if (l === lang) { labelUi(); labelOpeners(); } });   // 日英以外の文言が届いたら貼り直す

  // ───── 会話の吹き出し（キャラクターは左、自分は右。1 吹き出しずつ） ─────
  // 会話は末尾に合わせる。迎えの状態（ボタンだけ。is-talk が無い）は先頭に：低い画面（390×664）で最初の 1 文が窓の下に隠れないように（AUDIT-1 P1-2）
  const scrollEnd = () => { thread.scrollTop = root.classList.contains('is-talk') ? thread.scrollHeight : 0; };
  function line(who: 'ai' | 'me', text: string): HTMLParagraphElement {
    const p = h('p', `cg-line cg-${who} cg-new`);
    if (who === 'ai') fillPhrases(p, text, lang); else p.textContent = text;
    thread.appendChild(p);
    scrollEnd();
    return p;
  }
  const dotsEl = () => {
    const dots = h('span', 'cg-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(h('i'), h('i'), h('i'));
    return dots;
  };
  // 「…」の吹き出し。C2 が出ているとき（「別のにする」で AI にもう 1 往復）は C2 の上に「…考え中」を重ねる
  function thinking(): HTMLParagraphElement {
    if (stage === 'present') return ponder(c2);
    const p = h('p', 'cg-line cg-ai cg-thinking cg-new');
    p.append(dotsEl(), h('span', 'cg-vh', t('rec_thinking', lang)));
    thread.appendChild(p);
    scrollEnd();
    setFace('listening', true);
    setThinking(true);
    return p;
  }
  // 「…考え中」の小さな行（3 段の 2 段目は会話の下、C2 の上では重ねて出す）
  function ponder(into: HTMLElement): HTMLParagraphElement {
    const p = h('p', into === c2 ? 'cg-ponder cg2-wait' : 'cg-ponder cg-new');
    p.setAttribute('role', 'status');
    p.append(dotsEl(), h('span', '', t('rec_thinking', lang)));
    into.appendChild(p);
    if (into === thread) scrollEnd();
    setFace('listening', true);
    setThinking(true);
    return p;
  }
  const hideOpeners = () => thread.querySelector('.cg-openers')?.remove();
  const setInputEnabled = (on: boolean) => { input.disabled = send.disabled = !on; };

  function reset() {
    sess++;
    messages = []; busy = false; pending = null; mode = 'talk'; statStarted = false;
    current = null; shown = new Set(); otherPresses = 0; extraUsed = false; rulesRank = null; seed = newSeed(); openerPick = [];
    if (c2Pushed && history.state?.cg2) history.back();   // C2 の履歴を下ろす（popstate は stage が talk なので何もしない）
    c2Pushed = false;
    stage = nextStage(stage, 'again');
    hideC2();
    root.classList.remove('is-talk');   // 迎えの状態（キャラクターは大きく）に戻す
    c2.querySelector('.cg-card')?.remove();
    c2Line.innerHTML = c2LineInit; delete c2Line.dataset.other;
    thread.innerHTML = initialThread;
    applyLang(thread, lang);
    labelOpeners();
    form.hidden = true;   // 最初の画面はボタンだけ（4 つ目の「自分のことばで書く」で入力欄を出す）
    input.type = 'text';
    input.value = '';
    setInputEnabled(true);
    labelUi();
    stopTyping();
    setFace('smile');
    scrollEnd();
    thread.querySelector<HTMLButtonElement>('.cg-opt')?.focus({ preventScroll: true });
  }

  // ───── 人のことばを受け取る（選択肢 or 入力欄） ─────
  async function say(text: string) {
    if (busy || mode === 'done') return;
    if (mode === 'pass') { submitPass(text); return; }
    text = text.trim().slice(0, 600);
    if (!text) return;
    if (!statStarted) { statStarted = true; stat('concierge_start'); }
    stat('concierge_turn');   // 数だけ。文は送らない
    hideOpeners();
    root.classList.add('is-talk');   // 会話の状態：キャラクターを小さくして会話を広く
    line('me', text);
    if (rulesMode) { startRules(); return; }
    await sendUser(text, false);
  }

  // AI に 1 往復。最初の送信の前に合言葉が要れば聞く。extra は「別の絵を」の 1 往復（上限を 1 回だけ超えてよい）
  async function sendUser(text: string, extra: boolean) {
    busy = true;
    setInputEnabled(false);
    const my = sess;
    if (!passphrase && messages.length === 0 && await passNeeded) {
      if (my !== sess) return;
      busy = false;
      askPass({ text, extra });
      return;
    }
    if (my !== sess) return;
    messages.push({ role: 'user', content: text });
    await talk(my, extra);
  }

  async function talk(my: number, extra: boolean) {
    busy = true;
    form.hidden = false;
    setInputEnabled(false);
    const ok = await askAi(my, extra);
    if (my !== sess) return;
    busy = false;
    if (!ok || mode === 'done') return;
    if (stage === 'present') closeC2();   // C2 の上で待っていたら、AI が問いを返した：会話に戻って答えてもらう
    setInputEnabled(true);
    setFace('listening');
    input.focus({ preventScroll: true });
  }

  // ───── 合言葉（実験のあいだ）：最初の送信の前に 1 回だけ聞く ─────
  function askPass(p: { text: string; extra: boolean }) {
    pending = p;
    mode = 'pass';
    form.hidden = false;
    line('ai', t('cg_pass_ask', lang));
    setFace('smile');
    const box = h('div', 'cg-choices cg-new');
    const none = h('button', 'cg-opt', t('cg_pass_none', lang));
    phrasify(none);
    none.type = 'button';
    none.addEventListener('click', () => {
      box.remove();
      line('me', none.textContent || '');
      mode = 'talk'; pending = null;
      input.type = 'text'; labelUi();
      toRules(false);
    });
    box.appendChild(none);
    thread.appendChild(box);
    scrollEnd();
    input.type = 'password';
    labelUi();
    setInputEnabled(true);
    input.focus({ preventScroll: true });
  }

  function submitPass(value: string) {
    value = value.trim();
    if (!value || !pending) return;
    thread.querySelector('.cg-choices')?.remove();
    line('me', '•'.repeat(Math.min(8, value.length)));
    passphrase = value;
    mode = 'talk';
    input.type = 'text';
    labelUi();
    messages.push({ role: 'user', content: pending.text });
    const extra = pending.extra;
    pending = null;
    talk(sess, extra);
  }

  // ルールだけの版へ（API に届かない・拒否・合言葉が違う）。失敗したことは言わない
  function toRules(withPause: boolean) {
    rulesMode = true;
    busy = false;
    form.hidden = true;
    if (withPause) line('ai', t('cg_wait', lang));
    if (current) { other(true); return; }   // 「別のにする」の途中で落ちたら、近い作品に差し替える
    startRules();
  }

  // ───── AI に聞く。ストリームを受けて文を少しずつ出す。失敗したらルールだけの版へ落ちて false ─────
  async function askAi(my: number, extra: boolean): Promise<boolean> {
    const wait = thinking();
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), FIRST_BYTE_MS);
    const rearm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), STALL_MS); };   // 文が来るたびに張り直す「無音の時間切れ」
    let acc = '';
    let out: HTMLParagraphElement | null = null;
    let toolRec: RecJson | null = null;   // data: {"recommend": ...}（ツール呼び出し）で受けたおすすめ
    const usedPass = passphrase;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (usedPass) headers['X-Passphrase'] = usedPass;
      const res = await fetch(opts.api!, { method: 'POST', headers, body: JSON.stringify({ lang, messages, seed, sid: session.get('mtp.sid') }), signal: ctrl.signal });
      if (res.status === 403) {
        const e = await res.json().catch(() => null) as { error?: string } | null;
        // 違う合言葉は覚えない（覚えていたものも消す）
        if (e?.error === 'passphrase') { local.del(PASS_KEY); passphrase = null; }
        throw new Error('api 403');
      }
      if (!res.ok || !res.body || !/event-stream/.test(res.headers.get('content-type') || '')) throw new Error('api ' + res.status);
      if (usedPass) local.set(PASS_KEY, usedPass);   // 通った合言葉だけを覚える
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let done = false;
      while (!done) {
        const r = await reader.read();
        if (my !== sess) { ctrl.abort(); return false; }
        if (r.done) break;
        if (out || toolRec) rearm();
        buf += dec.decode(r.value, { stream: true });
        let k: number;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, k); buf = buf.slice(k + 2);
          for (const l of ev.split('\n')) {
            if (!l.startsWith('data:')) continue;
            let d: { text?: string; done?: boolean; error?: string; recommend?: unknown };
            try { d = JSON.parse(l.slice(5)); } catch { continue; }
            if (d.error) throw new Error(d.error);
            if (d.done) { done = true; break; }
            if (d.recommend !== undefined) {
              const rec = parseRecommendEvent(d.recommend);
              if (rec) { toolRec = rec; rearm(); }
              continue;
            }
            if (typeof d.text === 'string') {
              if (!out) {
                rearm();
                out = h('p', 'cg-line cg-ai cg-new');
                // C2 の上の「…考え中」は、カードが来るまで出したまま。文は会話（後ろ）に積む
                if (wait.parentElement === thread) { wait.replaceWith(out); setFace('smile'); } else thread.appendChild(out);
              }
              acc += d.text;
              fillPhrases(out, splitRecommendation(acc).prose, lang, false);   // 確定した文から文節の span に
              scrollEnd();
            }
          }
          if (done) break;
        }
      }
      if (!acc && !toolRec) throw new Error('empty');
    } catch (e) {
      clearTimeout(timer);
      ctrl.abort();   // 途中の {error}・時間切れ：上流の読み込みを切る（REVIEW-1 P2）
      if (my !== sess) return false;
      console.warn('AI に届かない。ルールだけの版にする', e);
      wait.remove();
      setThinking(false);
      if (out && !splitRecommendation(acc).prose) out.remove();
      toRules(true);
      return false;
    }
    clearTimeout(timer);
    const split = splitRecommendation(acc);
    if (out) fillPhrases(out, split.prose, lang);   // 言い終わり：残りも文節に
    // ツール呼び出しで受けたおすすめを優先し、無ければ文の中の JSON を拾う（保険）
    const json = toolRec || split.json;
    const prose = split.prose || (json ? reasonText(json, lang) : '');
    // 会話の履歴は文だけ（API は空の assistant を受け付けないので、文が空なら理由で埋める）
    messages.push({ role: 'assistant', content: acc || prose || '…' });
    if (json) {
      const c = await catalogReady;
      if (my !== sess) return false;
      if (!c?.works.length) { offline(); return false; }
      if (out && !out.textContent) out.remove();
      else if (!out) wait.remove();
      if (wait.parentElement === thread || !wait.isConnected) setThinking(false);
      const r = resolveRecommendation(json, c);
      const w = c.works.find((x) => x.id === r.id)!;
      // 使ったことば：AI が選んだ語のうち、その作品の moods にあるものだけ
      const known = new Set(Object.values(w.moods || {}).flat());
      const moods = (json.matched_moods || []).filter((m) => known.size === 0 || known.has(m));
      showCard(c, r, { reason: reasonText(json, lang) || defaultReason(w), moods: moods.length ? moods : pickMoods(w, lang).slice(0, 2), json });
      return true;
    }
    // 最大の往復まで来てもおすすめが出なかった：次の送信は Function が 400 にするので、先にルールだけの版へ
    wait.remove();
    setThinking(false);
    const maxTurns = ((await catalogReady)?.turns?.[1] ?? 3) + (extra || extraUsed ? 1 : 0);
    if (my !== sess) return false;
    if (messages.filter((m) => m.role === 'user').length >= maxTurns) { toRules(false); return false; }
    return true;
  }

  // ───── ルールだけの版：3 問を選択肢で聞く（同じ画面・同じキャラクター） ─────
  async function startRules() {
    const my = sess;
    form.hidden = true;
    const c = await catalogReady;
    if (my !== sess) return;
    if (!c?.works.length) { offline(); return; }
    const answers: Partial<Answers> = {};
    const ask = (i: number) => {
      if (my !== sess) return;
      if (i >= QUESTIONS.length) { finishRules(c, answers as Answers); return; }
      const q = QUESTIONS[i];
      setFace('smile');
      line('ai', t(q.q, lang));
      const box = h('div', 'cg-choices cg-new');
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', t(q.q, lang));
      for (const v of q.opts) {
        const b = h('button', 'cg-opt', t(q.label + v, lang));
        b.type = 'button';
        b.dataset.value = v;
        phrasify(b);
        b.addEventListener('click', () => {
          (answers as Record<string, string>)[q.key] = v;
          box.remove();
          line('me', b.textContent || v);
          ask(i + 1);
        });
        box.appendChild(b);
      }
      thread.appendChild(box);
      scrollEnd();
      (box.firstElementChild as HTMLButtonElement).focus({ preventScroll: true });
    };
    ask(0);
  }

  function finishRules(c: Catalog, answers: Answers) {
    let r: { id: string; alt: string | null };
    if (c.works.length === 1) { line('ai', t('rec_only_one', lang)); r = { id: c.works[0].id, alt: null }; }
    else r = recommendByRules(c, answers);
    // 「別のにする」は 2 番目、3 番目…に近い作品へ
    const target = targetAxes(answers);
    rulesRank = c.works.map((w, i) => ({ id: w.id, i, d: axisDistance(target, w.axes) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.id);
    const w = c.works.find((x) => x.id === r.id)!;
    showCard(c, r, { reason: defaultReason(w), moods: pickMoods(w, lang).slice(0, 2) });
  }

  const defaultReason = (w: CatalogWork) => buildReason(t('rec_reason', lang), pick(w.title, lang), pickMoods(w, lang));

  function offline() {
    line('ai', t('cg_offline', lang));
    const card = h('div', 'cg-card cg-new');
    const all = h('a', 'cg-btn', t('cg_all', lang));
    all.href = abs('gallery/');
    card.append(all, againButton());
    thread.appendChild(card);
    form.hidden = true;
    mode = 'done';
    scrollEnd();
    setFace('smile');
  }

  const smallButton = (cls: string, key: string, fn: () => void) => {
    const b = h('button', cls, t(key, lang));
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  const againButton = () => smallButton('cg-again', 'cg_again', reset);
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

  // ───── おすすめの画面 C2（docs/ENTRANCE.md 3.5）：開く・閉じる。URL は変えず、history に 1 つ積む ─────
  function setBehind(off: boolean) { behind.forEach((el) => { el.inert = off; }); }
  function hideC2() {
    c2.hidden = true;
    c2.querySelector('.cg2-wait')?.remove();
    root.classList.remove('is-sink');
    setBehind(false);
  }
  function openC2(push: boolean) {
    stage = 'present';
    thread.querySelector('.cg-after')?.remove();
    // キャラクター（上半身、小さめ、present）：present の画像を写し、全身の source は外す
    const pic = faceEl('present').cloneNode(true) as HTMLElement;
    pic.querySelectorAll('source[media]').forEach((s) => s.remove());
    pic.className = 'cg-face is-on';
    delete pic.dataset.rest;
    setFrame(pic, 'present');   // 写したときに途中のコマ（手を振る途中など）だったら戻す
    c2Host.replaceChildren(pic);
    c2.hidden = false;
    c2.scrollTop = 0;
    setBehind(true);
    setFace('present');
    if (push && !c2Pushed) { history.pushState({ cg2: 1 }, ''); c2Pushed = true; }
    c2.focus({ preventScroll: true });
  }
  // 会話に戻る（会話は残す。入力欄は出さず「もう一度、話す」と「おすすめをもう一度見る」だけ）
  function closeC2() {
    if (stage !== 'present') return;
    stage = nextStage(stage, 'close');
    hideC2();
    setFace('smile');
    if (mode === 'done' && current) {
      const after = h('div', 'cg-after cg-new');
      after.append(smallButton('cg-again cg-reopen', 'cg_reopen', () => { stage = nextStage(stage, 'reopen'); openC2(true); }), againButton());
      thread.appendChild(after);
    }
    scrollEnd();
    requestAnimationFrame(scrollEnd);
  }
  // 「会話に戻る」：積んだ履歴があれば戻るボタンと同じに（popstate で閉じる）
  const backFromC2 = () => { if (c2Pushed && history.state?.cg2) history.back(); else closeC2(); };
  window.addEventListener('popstate', (e) => {
    const s = (e.state as { cg2?: number } | null)?.cg2;
    if (!s && stage === 'present') { c2Pushed = false; closeC2(); }
    else if (s && stage === 'back' && current && mode === 'done') { c2Pushed = true; stage = nextStage(stage, 'reopen'); openC2(false); }
  });

  // 3 段：読ませる（1.6 秒）→ 考えている（1.4 秒、ルールだけの版は 1.0 秒）→ 会話画面が沈む（0.5 秒）→ C2
  async function presentFlow(my: number, img: string): Promise<boolean> {
    const o = { rules: rulesMode, fast: window.__ETP_FAST === true };
    stage = nextStage(stage, 'recommend');
    form.hidden = true;
    thread.querySelector('.cg-after')?.remove();
    await sleep(stageMs(stage, o));
    if (my !== sess) return false;
    stage = nextStage(stage, 'tick');
    const p = ponder(thread);
    new Image().src = img;   // この間にカードの絵を先読み
    await sleep(stageMs(stage, o));
    if (my !== sess) return false;
    stage = nextStage(stage, 'tick');
    root.classList.add('is-sink');
    await sleep(stageMs(stage, o));
    p.remove();
    if (my !== sess) return false;
    return true;
  }

  // ───── おすすめのカード（docs/ENTRANCE.md 3.1、3.4）：見出し、絵（くるんくるん → ピカーン）、題名、寸法、理由、ことば、3 つの選択 ─────
  // C2 が出ていなければ 3 段を経て C2 に、出ていれば C2 の中で差し替える（短い登場）
  async function showCard(c: Catalog, r: { id: string; alt: string | null }, info: { reason: string; moods: string[]; json?: RecJson }, swap = false) {
    const w = c.works.find((x) => x.id === r.id)!;
    stat('concierge_recommend', w.id);
    current = r;
    shown.add(w.id);
    // 直前のおすすめを sessionStorage に（作品ページの帯の「別のにする」から戻ったときに使う）
    const last: LastRec = { recommend: w.id, alt: r.alt, reason: info.json?.reason ?? null, matched_moods: info.moods };
    session.set(LAST_REC_KEY, JSON.stringify(last));
    form.hidden = true;
    mode = 'done';
    busy = false;
    const inC2 = stage === 'present';
    if (!inC2) {
      const my = sess;
      if (!await presentFlow(my, abs(w.image))) return;
    }
    swap = swap || inC2;

    const card = h('div', `cg-card${swap ? ' is-swap' : ''}`);
    card.dataset.work = w.id;
    card.style.setProperty('--glow-c', glowColor(w.palette?.[0]));
    const head = h('h2', 'cg-card-head');
    fillPhrases(head, t('cg_card_head', lang), lang);
    card.append(head);
    // キャンバス：表は絵、裏は紙白の面。回転は CSS（.cg-canvas の animation）
    const stageEl = h('div', 'cg-stage');
    // 絵をタップしても入れる（11-06 作家）。主ボタンと同じ流れ。ホバーで手の形に
    stageEl.setAttribute('role', 'button'); stageEl.setAttribute('tabindex', '0'); stageEl.setAttribute('aria-label', t('enter', lang)); stageEl.dataset.i18nAttr = 'aria-label:enter';
    stageEl.style.cursor = 'pointer';
    stageEl.addEventListener('click', () => { void enterHere(w, false); });
    stageEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void enterHere(w, false); } });
    const glow = h('i', 'cg-glow');
    glow.setAttribute('aria-hidden', 'true');
    const canvas = h('div', 'cg-canvas');
    const front = h('div', 'cg-front');
    const img = h('img');
    img.src = abs(w.image); img.alt = pick(w.title, lang);
    if (w.size_cm) { front.style.aspectRatio = `${w.size_cm[0]} / ${w.size_cm[1]}`; stageEl.style.setProperty('--ar', String(w.size_cm[0] / w.size_cm[1])); }
    const sheen = h('i', 'cg-sheen');
    sheen.setAttribute('aria-hidden', 'true');
    front.append(img, sheen);
    const back = h('div', 'cg-back');
    back.setAttribute('aria-hidden', 'true');
    canvas.append(front, back);
    stageEl.append(glow, canvas);
    card.appendChild(stageEl);

    // 回転が止まったあと 0.15 秒ずつ遅れて出るもの（--i が順番）
    let i = 0;
    const rise = <T extends HTMLElement>(el: T): T => { el.classList.add('cg-rise'); el.style.setProperty('--i', String(i++)); card.appendChild(el); return el; };
    const cap = h('p', 'cg-cap');
    {   // 題名の主従（日本語以外では英語を大きく、日本語を小さく）
      const tp = titlePair(w.title, lang);
      const b = h('b', tp.mainLatin ? 'latin' : '', tp.main);
      cap.appendChild(b);
      if (tp.sub) cap.appendChild(h('span', tp.mainLatin ? 't-sub' : 't-sub latin', tp.sub));
      cap.appendChild(h('span', '', sizeText(w)));
    }
    rise(cap);
    if (info.reason) { const r = h('p', 'cg-reason'); fillPhrases(r, info.reason, lang); rise(r); }
    if (info.moods.length) {
      const m = h('p', 'cg-moods');
      m.append(h('span', 'cg-moods-label', t('cg_moods', lang)));
      for (const s of info.moods.slice(0, 3)) m.append(h('span', 'cg-mood', s));
      rise(m);
    }
    // 「絵の世界をのぞく」（11-06 まで「この絵の中に入る」）：ページは移らず、その場で体験（物語モード）を始める。終わったら作品ページへ（E-12）
    // href は残す（JS が動かないとき・新しいタブで開くときの逃げ道）
    const enter = h('a', 'cg-btn primary cg-enter', t('rec_enter', lang));
    enter.href = withQuery(w.url, 'via', 'concierge');
    enter.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      enterHere(w, false);
    });
    rise(enter);
    // ボタンの直下に、何が起きるかを 1 行（初めての人に「のぞく」の中身を伝える。11-06 作家）
    { const n = h('p', 'cg-enter-note'); fillPhrases(n, t('enter_note', lang), lang); rise(n); }
    // 「VR でのぞく」：VR が使える端末（Quest のブラウザ）のときだけ、その下に小さく
    const enterVr = h('button', 'cg-enter-vr', t('enter_vr', lang));
    enterVr.type = 'button';
    enterVr.hidden = true;
    enterVr.addEventListener('click', () => enterHere(w, true));
    rise(enterVr);
    vrReady.then((ok) => { if (ok) enterVr.hidden = false; });
    prefetchSpace(w);
    rise(smallButton('cg-btn cg-other', 'cg_other', () => { if (!busy) stat('concierge_other'); other(); }));
    const all = h('a', 'cg-btn cg-all', t('cg_all', lang));
    all.href = withQuery('gallery/', 'from', w.id);
    rise(all);
    { const n = h('p', 'cg-note'); fillPhrases(n, t('rec_note', lang), lang); rise(n); }
    // 下に小さく「会話に戻る」と「もう一度、話す」
    const foot = h('div', 'cg2-foot');
    foot.append(smallButton('cg-again cg-back-talk', 'cg_back', backFromC2), againButton());
    rise(foot);

    if (c2.querySelector('.cg2-wait')) { c2.querySelector('.cg2-wait')!.remove(); setThinking(false); }
    const old = c2.querySelector('.cg-card');
    if (old) old.replaceWith(card); else c2.querySelector('.cg2-in')!.appendChild(card);
    // ひとこと：C2 が立ち上がるときは present_line（作家の 1 文）、C2 の中で差し替えたら「では、こちらはどうでしょう」
    if (inC2) { fillPhrases(c2Line, t('cg_other_line', lang), lang); c2Line.dataset.other = '1'; }
    else { delete c2Line.dataset.other; labelPresent(); }
    if (inC2) c2.scrollTo({ top: 0, behavior: 'smooth' });
    else openC2(true);
  }

  // ───── C2 から一気に絵の中へ（E-12）。作品ページの「入る」（page.ts の start）と同じ組み立て ─────
  // VR が使えるか（作品ページと同じ条件。?vr=1 で強制）。カードを出すたびに聞かないよう 1 回だけ
  const vrReady = vrAvailable(new URLSearchParams(location.search).get('vr') === '1');
  // 声のファイル（space.json の audio.voice）。押した操作の中で先に鳴らしておく（iOS）ため、カードを出したときに読んでおく
  const voiceOf = new Map<string, string | null>();
  function prefetchSpace(w: CatalogWork) {
    if (voiceOf.has(w.id)) return;
    voiceOf.set(w.id, null);
    fetch(abs(`works/${w.id}/generated/space.json`))
      .then((r) => (r.ok ? r.json() : null))
      .then((sp: { audio?: { voice?: string } } | null) => { if (sp?.audio?.voice) voiceOf.set(w.id, abs(`works/${w.id}/${sp.audio.voice}`)); })
      .catch(() => {});
  }
  let entering = false;
  // 体験のあいだ、C2 と会話の DOM は触らない（戻ってこないので消さない）。history も積まない
  // 体験の画面（#stage、page.css で全画面）は受付の HTML に無いので、ここで body の末尾に足す（C2 の上に重なる）
  async function enterHere(w: CatalogWork, vr: boolean) {
    if (entering) return;
    entering = true;
    stat('enter', w.id, 'concierge');
    // 押した操作の中で：音の許可、声の準備、XR セッションの要求（CLAUDE.md の作業ルール）
    const sound = new Soundscape();
    const unlocking = sound.unlock();
    const voiceUrl = voiceOf.get(w.id);
    if (voiceUrl) { const a = new Audio(voiceUrl); a.muted = true; a.play().then(() => { a.pause(); a.muted = false; }).catch(() => {}); }
    let xrSession: XRSession | null = null;
    if (vr) {
      try { xrSession = await (navigator as Navigator & { xr: XRSystem }).xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] }); }
      catch (e) { console.warn('XR セッションを要求できない', e); }
    }
    if (!document.getElementById('stage')) {
      const stageEl = h('div');
      stageEl.id = 'stage';
      stageEl.hidden = true;
      document.body.appendChild(stageEl);
    }
    // 終わったら（T5 のあと閉じた / 途中で閉じた / Esc）作品ページへ。「部屋で見る」「他の作品」はそこにある
    const done = afterUrl(w.url, catalogHref);
    try {
      await unlocking;
      const { run } = await import('../experience/main');
      await run({ workId: w.id, lang, vr, fromQr: false, debug: false, sound, xrSession });
      location.assign(done);
    } catch (e) {
      // 体験を始められなかった：作品ページ（帯は「今日のあなたへの 1 点」）へ。そこからもう一度「入る」を押せる
      console.warn('体験を始められない。作品ページへ', e);
      location.assign(withQuery(w.url, 'via', 'concierge'));
    }
  }

  // 「別のにする」：alt → AI に「別の絵を」の 1 往復 → 近い作品の順（API は呼ばない）
  // quiet：「では、こちらはどうでしょう」を言わない（?retry で「別の絵、考えてみるね」を先に言ったとき）
  function other(quiet = false) {
    const c = catalog;
    if (!c || !current || busy) return;
    otherPresses++;
    const altFree = current.alt && !shown.has(current.alt) && c.works.some((w) => w.id === current!.alt) ? current.alt : null;
    // 11-07 作家「2 回目の『別のにする』の反応が遅い」：ボタンからはいつも即座に次の絵（alt → 近い順）。AI にもう 1 往復聞くのは、作品ページから戻ってきたとき（quiet）だけ
    if (!rulesMode && !extraUsed && quiet && !altFree) { aiOther(false); return; }
    const next = rulesMode && rulesRank ? rulesRank.find((id) => !shown.has(id)) ?? nearest(c, current.id) : altFree ?? nearest(c, current.id);
    if (!next) return;
    if (!quiet) line('ai', t('cg_other_line', lang));   // 会話の記録にも残す（「会話に戻る」で読める）
    const w = c.works.find((x) => x.id === next)!;
    const inC2 = stage === 'present';
    showCard(c, { id: next, alt: null }, { reason: defaultReason(w), moods: pickMoods(w, lang).slice(0, 2) }, true);
    // 「では、こちらは」：C2 の写しは手を差し出した姿勢（present）なので、手の位置が合う happy-up を 1 回（かしげのコマは手を合わせた形で、手が跳ぶ）
    if (inC2 && !quiet) { const pic = visiblePic(); play(motionFor('happy', pic), { pic }); }
  }

  // まだ出していない作品のうち、3 軸でいちばん近いもの。全部出したら最初からやり直す
  function nearest(c: Catalog, fromId: string): string | null {
    const from = c.works.find((w) => w.id === fromId);
    let pool = c.works.filter((w) => !shown.has(w.id));
    if (!pool.length) { shown = new Set([fromId]); pool = c.works.filter((w) => w.id !== fromId); }
    if (!pool.length || !from) return pool[0]?.id ?? null;
    return pool.map((w, i) => ({ id: w.id, i, d: axisDistance(from.axes, w.axes) })).sort((a, b) => a.d - b.d || a.i - b.i)[0].id;
  }

  // AI に「別の絵を」（いま出している絵の題名を添える）。C2 が出ていれば、C2 の上に「…考え中」を重ねて待つ
  function aiOther(showMe: boolean) {
    const c = catalog!;
    const cur = c.works.find((w) => w.id === current?.id);
    extraUsed = true;
    const text = cur ? t('cg_other_req_not', lang, { title: pick(cur.title, lang) }) : t('cg_other_req', lang);
    if (showMe) line('me', t('cg_other_req', lang));
    mode = 'talk';
    sendUser(text, messages.length > 0);
  }

  const sizeText = (w: CatalogWork) => (w.size_cm ? `${w.size_cm[0]} × ${w.size_cm[1]} cm` : '');
  const withQuery = (path: string, k: string, v: string) => {
    const u = new URL(path, catalogHref);
    u.searchParams.set(k, v);
    return u.href;
  };

  // ───── 入口：選択肢と入力欄 ─────
  thread.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-opener-index]');
    if (!b) return;
    if (b.classList.contains('cg-write')) openWrite();
    else say(b.innerText || b.textContent || '');   // 隠れた訳（span[hidden]）は含めない
  });
  // 「自分のことばで書く」：選択肢を消し、入力欄を下にふわっと出してフォーカス（押した操作の中なので iOS でもキーボードが出る）
  function openWrite() {
    if (busy || mode !== 'talk') return;
    hideOpeners();
    root.classList.add('is-talk');
    form.hidden = false;
    form.classList.remove('cg-form-in');
    void form.offsetWidth;
    form.classList.add('cg-form-in');
    input.focus();
    setFace('listening');
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value;
    input.value = '';
    say(v);
  });
  // 打ち始めたら選択肢を消し、キャラクターは聞く顔に
  input.addEventListener('input', () => {
    if (mode !== 'talk' || !input.value) return;
    if (messages.length === 0) hideOpeners();
    if (!busy) setFace('listening');
    onTyping();
  });
  input.addEventListener('blur', stopTyping);

  // ───── 作品ページの「別のにする」から戻った（?retry=<id>）：会話は復元せず、別の絵を考える ─────
  if (opts.retry) {
    const retryId = opts.retry;
    let last: LastRec | null = null;
    try { last = JSON.parse(session.get(LAST_REC_KEY) || 'null'); } catch { /* 壊れていたら無視 */ }
    hideOpeners();
    root.classList.add('is-talk');
    setTimeout(async () => {
      const my = sess;
      line('ai', t('cg_retry', lang));
      const c = await catalogReady;
      if (my !== sess) return;
      if (!c?.works.length) { offline(); return; }
      if (!c.works.some((w) => w.id === retryId)) { reset(); return; }
      shown.add(retryId);
      current = { id: retryId, alt: last && last.recommend === retryId ? last.alt : null };
      // alt があれば alt、無ければ AI に再提案（ルールだけの版は近い作品）
      otherPresses = 0;
      stat('concierge_other');   // 作品ページの帯の「別のにする」
      other(true);
    }, 900);
  }

  // ───── スマホ：キーボードの高さを visualViewport で追い、会話を入力欄の上に詰める ─────
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      root.style.setProperty('--cg-h', `${Math.round(vv.height)}px`);
      root.style.setProperty('--cg-top', `${Math.round(vv.offsetTop)}px`);
      root.classList.toggle('is-kb', vv.height < window.innerHeight * 0.75);
      if (root.classList.contains('is-talk')) scrollEnd();   // 迎えの状態では、下の選択肢へスクロールした位置を戻さない
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
  }
}
