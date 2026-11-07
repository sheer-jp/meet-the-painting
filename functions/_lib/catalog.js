// カタログ（/catalog.json）を読む。isolate の中に 10 分持つ。読めなければ null
const TTL = 600_000;
/** @type {{ at: number, data: any } | null} */
let memo = null;
/** @param {Request} req @param {any} env @param {number} [now] */
export async function readCatalog(req, env, now = Date.now()) {
  if (memo && now - memo.at < TTL) return memo.data;
  try {
    const url = new URL('/catalog.json', req.url);
    const res = env.ASSETS ? await env.ASSETS.fetch(new Request(url)) : await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    memo = { at: now, data };
    return data;
  } catch { return null; }
}
export function resetCatalogMemo() { memo = null; }
