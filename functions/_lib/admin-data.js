// 管理ページの集計（docs/ADMIN.md 4 節）。出来事の行から、数と流れを作る純関数
export const DAY_CHOICES = [7, 30, 90, 180];
export const TOP_N = 6;
export const FREE_LABEL = '自分のことばで';
export const NO_OPENER = '最初の選択が不明';
export const OTHER_OPENERS = 'その他の選択肢';
export const OTHER_QUESTIONS = 'その他の問い';
export const RULES_LABEL = '3 つの質問（ルールだけの版）';
export const NO_QUESTION = '問いなし';
export const NO_REC = 'おすすめの前に離れた';
export const OUTCOMES = [
  ['buy', '購入リンクへ'],
  ['enter', '絵の世界へ'],
  ['view', '作品ページへ'],
  ['other', '別のにするで終わり'],
  ['stop', 'ここまで'],
];
const OUTCOME_LABEL = Object.fromEntries(OUTCOMES);

/** @param {any} v */
export const parseDays = (v) => { const n = Number(v); return DAY_CHOICES.includes(n) ? n : 30; };

/** @param {Map<string, number>} m */
const ranked = (m) => [...m.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'ja'));
/** @param {Map<string, number>} m @param {string} key */
const inc = (m, key, by = 1) => m.set(key, (m.get(key) || 0) + by);

// 受付を通った会話か
const CONVERSATION = new Set(['concierge_start', 'cg_opener', 'cg_write', 'cg_free', 'cg_rule', 'cg_question', 'concierge_recommend']);

// 1 つの会話（匿名 id の出来事の列）を、流れの 4 段に直す。受付を通っていなければ null
/** @param {{ ev: string, work_id: string|null, detail: string|null }[]} list 時刻の順 */
export function pathOf(list) {
  if (!list.some((e) => CONVERSATION.has(e.ev))) return null;
  const first = (/** @type {string} */ ev) => list.find((e) => e.ev === ev);
  const has = (/** @type {string} */ ev) => list.some((e) => e.ev === ev);
  const op = first('cg_opener');
  const opener = op?.detail || (has('cg_free') || has('cg_write') ? FREE_LABEL : NO_OPENER);
  const q = first('cg_question');
  const question = q?.detail || (has('cg_rule') ? RULES_LABEL : NO_QUESTION);
  const rec = first('concierge_recommend');
  // どこまで進んだかは、すすめた作品について見る（すすめたあとに別の絵のページへ行っただけなら数えない）。「別のにする」で替わった絵はどれも「すすめた作品」
  const recommended = new Set(list.filter((e) => e.ev === 'concierge_recommend').map((e) => e.work_id));
  const onRec = (/** @type {string} */ ev) => list.some((e) => e.ev === ev && recommended.has(e.work_id));
  const outcome = !rec ? 'stop' : onRec('buy_click') ? 'buy' : onRec('enter') ? 'enter' : onRec('work_view') ? 'view' : has('concierge_other') ? 'other' : 'stop';
  return { opener, question, work: rec?.work_id || null, outcome };
}

/**
 * @param {{ sid: string, ev: string, work_id: string|null, detail: string|null, at: number }[]} rows 時刻の順
 * @param {{ work_id: string, reaction: string|null, n: number }[]} feedback 感想の数（作品 × 反応）
 * @param {{ id: string, title?: any }[]} works カタログ
 */
export function summarize(rows, feedback = [], works = []) {
  /** @type {Map<string, any[]>} */
  const bySid = new Map();
  // views は作品ページを開いた回数の全部。qr はそのうち会場の QR から開いた回数（views に含まれる）
  /** @type {Record<string, { recommended: number, entered: number, picked: number, views: number, qr: number, feedback: number, buys: number }>} */
  const perWork = {};
  const work = (/** @type {string} */ id) => (perWork[id] ||= { recommended: 0, entered: 0, picked: 0, views: 0, qr: 0, feedback: 0, buys: 0 });
  for (const w of works) work(w.id);
  const openers = new Map(), questions = new Map(), reactions = new Map(), langs = new Map();
  let free = 0, others = 0, rules = 0;
  const seenLang = new Set();
  for (const r of rows) {
    if (!bySid.has(r.sid)) bySid.set(r.sid, []);
    bySid.get(r.sid).push(r);
    if (r.lang && !seenLang.has(r.sid)) { seenLang.add(r.sid); inc(langs, r.lang); }
    switch (r.ev) {
      case 'cg_opener': if (r.detail) inc(openers, r.detail); break;
      case 'cg_free': free++; break;
      case 'cg_rule': rules++; break;
      case 'cg_question': if (r.detail) inc(questions, r.detail); break;
      case 'concierge_other': others++; break;
      case 'concierge_recommend': if (r.work_id) work(r.work_id).recommended++; break;
      case 'enter': if (r.work_id) work(r.work_id).entered++; break;
      case 'gallery_pick': if (r.work_id) work(r.work_id).picked++; break;
      case 'work_view': if (r.work_id) { const w = work(r.work_id); w.views++; if (r.detail === 'qr') w.qr++; } break;
      case 'buy_click': if (r.work_id) work(r.work_id).buys++; break;
    }
  }
  let feedbackTotal = 0;
  const fbReactions = new Map();
  for (const f of feedback) {
    work(f.work_id).feedback += f.n;
    feedbackTotal += f.n;
    if (f.reaction) inc(fbReactions, f.reaction, f.n);
  }
  const paths = [...bySid.values()].map(pathOf).filter((p) => p !== null);
  const sum = (/** @type {'recommended'|'entered'|'picked'|'views'|'qr'|'buys'} */ k) => Object.values(perWork).reduce((a, w) => a + w[k], 0);
  return {
    // views と qr：作品ページを開いた回数と、そのうち会場の QR から（オンラインは views - qr）
    totals: { visits: bySid.size, conversations: paths.length, recommended: sum('recommended'), entered: sum('entered'), views: sum('views'), qr: sum('qr'), buys: sum('buys'), feedback: feedbackTotal, free, others, rules },
    works: Object.entries(perWork).map(([id, w]) => ({ id, ...w })).sort((a, b) => b.recommended + b.entered + b.feedback - (a.recommended + a.entered + a.feedback) || a.id.localeCompare(b.id)),
    openers: ranked(openers),
    questions: ranked(questions),
    reactions: ranked(fbReactions),
    langs: ranked(langs),
    flow: buildFlow(paths),
  };
}

// 上位 n 件のほかを other に束ねる。「その他」の札は下に置く
/** @param {Map<string, number>} counts @param {number} n @param {string} other @param {string[]} [tail] 順位によらず下に置く札 */
function topLabels(counts, n, other, tail = []) {
  const main = ranked(counts).map((x) => x.label).filter((l) => !tail.includes(l) && l !== other);
  const keep = new Set(main.slice(0, n));
  const grouped = main.slice(n).length > 0 || counts.has(other);
  const map = (/** @type {string} */ l) => (keep.has(l) || tail.includes(l) ? l : other);
  const order = [...main.slice(0, n), ...(grouped ? [other] : []), ...tail.filter((t) => counts.has(t))];
  return { map, order };
}

// 4 段の流れ：最初のことば → 問い → すすめた絵 → どこまで進んだか
/** @param {{ opener: string, question: string, work: string|null, outcome: string }[]} paths */
export function buildFlow(paths) {
  const c0 = new Map(), c1 = new Map(), c2 = new Map();
  for (const p of paths) { inc(c0, p.opener); inc(c1, p.question); inc(c2, p.work ?? NO_REC); }
  const a = topLabels(c0, TOP_N, OTHER_OPENERS, [FREE_LABEL, NO_OPENER]);
  const b = topLabels(c1, TOP_N, OTHER_QUESTIONS, [RULES_LABEL, NO_QUESTION]);
  const wOrder = [...ranked(c2).map((x) => x.label).filter((l) => l !== NO_REC), ...(c2.has(NO_REC) ? [NO_REC] : [])];
  /** @type {Map<string, number>} */
  const links = new Map();
  /** @type {Map<string, number>[]} */
  const nodes = [new Map(), new Map(), new Map(), new Map()];
  const link = (/** @type {number} */ col, /** @type {string} */ from, /** @type {string} */ to) => inc(links, JSON.stringify([col, from, to]));
  for (const p of paths) {
    const st = [a.map(p.opener), b.map(p.question), p.work ?? NO_REC, OUTCOME_LABEL[p.outcome]];
    st.forEach((s, i) => { inc(nodes[i], s); if (i < 3) link(i, s, st[i + 1]); });
  }
  const outOrder = OUTCOMES.map(([, l]) => l).filter((l) => nodes[3].has(l));
  const col = (/** @type {string} */ title, /** @type {string[]} */ order, /** @type {number} */ i) => ({ title, nodes: order.filter((l) => nodes[i].has(l)).map((l) => ({ label: l, n: nodes[i].get(l) })) });
  return {
    total: paths.length,
    columns: [col('最初のことば', a.order, 0), col('案内役の問い', b.order, 1), col('すすめた絵', wOrder, 2), col('どこまで進んだか', outOrder, 3)],
    links: [...links.entries()].map(([k, n]) => { const [c, from, to] = JSON.parse(k); return { col: c, from, to, n }; }).sort((x, y) => x.col - y.col || y.n - x.n),
  };
}

// 会話 1 つの出来事を、日本語の 1 行にする（感想の「この人の流れ」）
const VIA_JA = { concierge: '受付から', page: '作品ページから', gallery: 'ギャラリーから', direct: '直接', qr: '会場の QR から' };
const REACT_JA = { love: '好き', curious: '気になる', unsure: 'ちょっと違うかも', write: 'ことばで書く' };
/** @param {{ ev: string, work_id: string|null, detail: string|null }} e @param {(id: string) => string} title */
export function describeEvent(e, title = (id) => id) {
  const w = e.work_id ? title(e.work_id) : '';
  const d = e.detail || '';
  switch (e.ev) {
    case 'concierge_start': return '受付で話し始めた';
    case 'cg_opener': return `選択肢を押した：${d}`;
    case 'cg_write': return '「自分のことばで書く」を押した';
    case 'cg_free': return '自由入力あり（文は保存していません）';
    case 'cg_rule': return `ルールの質問に答えた：${d}`;
    case 'cg_question': return `案内役の問い：${d}`;
    case 'concierge_recommend': return `おすすめ：${w}`;
    case 'concierge_other': return '「別のにする」を押した';
    case 'concierge_skip': return '受付を飛ばしてギャラリーへ';
    case 'enter': return `絵の世界へ：${w}（${/** @type {any} */ (VIA_JA)[d] || d}）`;
    case 'gallery_pick': return `ギャラリーで選んだ：${w}`;
    case 'work_view': return `作品ページを見た：${w}（${/** @type {any} */ (VIA_JA)[d] || d}）`;
    case 'buy_click': return `購入リンクを押した：${w}`;
    case 'fu_shown': return `感想カードが出た：${w}`;
    case 'fu_reaction': return `感想カードの反応：${/** @type {any} */ (REACT_JA)[d] || d}`;
    case 'fu_free': return '感想カードで自由入力あり';
    case 'fu_close': return '感想カードを閉じた';
    case 'fu_sent': return `感想を作家に届けた：${w}`;
    default: return e.ev;
  }
}
