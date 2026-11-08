// 公開の手順が結果を書く：POST /api/admin/works/<id>/result（公開専用のトークンだけ。docs/REGISTER.md 5.3 の 6）
// { status: 'building' | 'published' | 'failed', commit?, deploy_url?, page_url?, log? }
// building は「この下書きを公開し始める」の札。ほかに building があれば 409（公開は 1 件ずつ。docs/REGISTER.md 7 節）
import { adminJson } from '../../../../_lib/admin-auth.js';
import { registerReady, getDraft } from '../../../../_lib/drafts.js';
import { readJson } from '../../../../_lib/works-api.js';

const MAX_BODY = 16_000;
const FROM = { building: ['queued'], published: ['building'], failed: ['queued', 'building'] };

/** @param {any} v @param {RegExp} re @param {number} max */
const opt = (v, re, max) => (v == null || v === '' ? null : typeof v === 'string' && v.length <= max && re.test(v) ? v : undefined);

export async function onRequestPost({ request: req, params, env, data }) {
  if (!data?.publisher) return adminJson(401, { error: 'unauthorized' });
  const r = await registerReady(env);
  if (!r.ok) return adminJson(503, { error: 'not_ready', reason: r.reason });
  const b = await readJson(req, MAX_BODY);
  if (!b || typeof b !== 'object' || !Object.prototype.hasOwnProperty.call(FROM, b.status)) return adminJson(400, { error: 'bad_request' });
  const commit = opt(b.commit, /^[0-9a-f]{7,40}$/, 40);
  const deploy = opt(b.deploy_url, /^https:\/\/[^\s]+$/, 300);
  const page = opt(b.page_url, /^https:\/\/[^\s]+$/, 300);
  if (commit === undefined || deploy === undefined || page === undefined) return adminJson(400, { error: 'bad_request' });
  // 最後の 40 行まで
  const log = typeof b.log === 'string' ? b.log.split('\n').slice(-40).join('\n').slice(-8000) : null;
  const d = await getDraft(env.DB, String(params.id));
  if (!d) return adminJson(404, { error: 'not_found' });
  const from = /** @type {any} */ (FROM)[b.status];
  if (!from.includes(d.status)) return adminJson(409, { error: 'bad_state', status: d.status });
  const now = Date.now();
  try {
    if (b.status === 'building') {
      const other = await env.DB.prepare("SELECT id FROM work_drafts WHERE status = 'building' AND id != ? LIMIT 1").bind(d.id).first();
      if (other) return adminJson(409, { error: 'busy' });
    }
    const res = await env.DB.prepare(`UPDATE work_drafts SET status = ?, publish_commit = COALESCE(?, publish_commit), publish_deploy_url = COALESCE(?, publish_deploy_url), publish_page_url = COALESCE(?, publish_page_url),
      publish_log = ?, published_at = ?, updated_at = ? WHERE id = ? AND status = ?`)
      .bind(b.status, commit, deploy, page, log, b.status === 'published' ? now : null, now, d.id, d.status).run();
    if (!(res.meta?.changes > 0)) return adminJson(409, { error: 'bad_state' });
    return adminJson(200, { ok: true, status: b.status });
  } catch (e) {
    console.error('公開の結果を書けない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}
