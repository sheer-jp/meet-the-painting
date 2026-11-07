// 計測（E-14）：会話と閲覧のカウンターの純関数。数だけを数える。IP・UA・会話の文は扱わない
// 鍵：日ごと d:<YYYY-MM-DD>:<ev>[:<via>][:<id>]、累計 t:<ev>[:<via>][:<id>]。日付は日本時間（JST）

// 許すイベント。needId：作品 id が要る。via：enter だけ、入った経路
export const EVENTS = {
  concierge_start: { needId: false },
  concierge_turn: { needId: false },
  concierge_recommend: { needId: true },
  concierge_other: { needId: false },
  concierge_skip: { needId: false },
  enter: { needId: true, via: ['concierge', 'page', 'gallery'] },
  gallery_pick: { needId: true },
  buy_click: { needId: true },
};

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DAY_TTL = 60 * 60 * 24 * 40;   // 日ごとの鍵は 40 日で消える（見る口は直近 30 日）

// 本文 { ev, id, via } を検査して正規化する。だめなら null
export function normalizeEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const ev = body.ev;
  if (typeof ev !== 'string' || !Object.prototype.hasOwnProperty.call(EVENTS, ev)) return null;
  const def = EVENTS[ev];
  let id = null;
  if (def.needId) {
    if (typeof body.id !== 'string' || !ID_RE.test(body.id)) return null;
    id = body.id;
  } else if (body.id != null) return null;
  let via = null;
  if (def.via) {
    if (!def.via.includes(body.via)) return null;
    via = body.via;
  } else if (body.via != null) return null;
  return { ev, id, via };
}

// 日本時間の日付（YYYY-MM-DD）
export function jstDate(now = Date.now()) {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}

// 1 回の出来事で +1 する 2 つの鍵 [日ごと, 累計]
export function statKeys({ ev, id, via }, date) {
  const name = [ev, via, id].filter(Boolean).join(':');
  return [`d:${date}:${name}`, `t:${name}`];
}

// 鍵（d:/t:）を名前と日付に分ける。形が違えば null
export function parseKey(key) {
  const d = /^d:(\d{4}-\d{2}-\d{2}):(.+)$/.exec(key);
  if (d) return { kind: 'd', date: d[1], name: d[2] };
  const t = /^t:(.+)$/.exec(key);
  if (t) return { kind: 't', date: null, name: t[1] };
  return null;
}

// 見る口の鍵の照合。expected が空なら常に false（STATS_KEY が無ければ見せない）。長さで早く抜けない
export function checkStatsKey(expected, given) {
  const want = String(expected ?? '');
  if (!want) return false;
  const got = String(given ?? '');
  const n = Math.max(want.length, got.length);
  let diff = want.length ^ got.length;
  for (let i = 0; i < n; i++) diff |= (want.charCodeAt(i) || 0) ^ (got.charCodeAt(i) || 0);
  return diff === 0;
}

// list の結果（{ name, metadata }[]）を { total, days } にまとめる。days は since（YYYY-MM-DD）以降だけ
export function summarize(keys, since) {
  const total = {};
  const days = {};
  for (const k of keys) {
    const p = parseKey(k.name);
    if (!p) continue;
    const n = Number(k.metadata?.n) || 0;
    if (p.kind === 't') total[p.name] = n;
    else if (p.date >= since) (days[p.date] ||= {})[p.name] = n;
  }
  return { total, days };
}
