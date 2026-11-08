// 「公開する」：POST /api/admin/works/<id>/queue。R1 では状態を queued にするだけ（公開は R2 のコマンド scripts/publish-draft.mjs）
// 項目がそろっていないと 422。1 日 5 件まで（docs/REGISTER.md 7 節）
import { adminJson } from '../../../../_lib/admin-auth.js';
import { readCatalog } from '../../../../_lib/catalog.js';
import { takeDaily } from '../../../../_lib/events.js';
import { registerReady, getDraft, takenIds } from '../../../../_lib/drafts.js';
import { missingForPublish } from '../../../../_lib/register.js';
import { draftJson } from '../../../../_lib/works-api.js';

export const QUEUE_DAILY_CAP = 5;

export async function onRequestPost({ request: req, params, env }) {
  const r = await registerReady(env);
  if (!r.ok) return adminJson(503, { error: 'not_ready', reason: r.reason });
  const d = await getDraft(env.DB, String(params.id));
  if (!d) return adminJson(404, { error: 'not_found' });
  if (d.status === 'queued') return draftJson(200, d, { message: '公開の準備ができています（R2 のコマンドで公開します）' });
  if (d.status !== 'draft' && d.status !== 'failed') return adminJson(409, { error: 'locked', status: d.status });
  const missing = missingForPublish(d);
  if (missing.length) return adminJson(422, { error: 'incomplete', missing, message: `${missing.join('、')}が足りません` });
  try {
    const taken = await takenIds(env.DB, await readCatalog(req, env), d.id);
    if (taken.has(d.work_id)) return adminJson(422, { error: 'id_taken', message: `作品の id「${d.work_id}」はもう使われています` });
    if (!await takeDaily(env.DB, 'register_queue', QUEUE_DAILY_CAP)) return adminJson(429, { error: 'daily_cap', message: `公開は 1 日 ${QUEUE_DAILY_CAP} 件までです。明日もう一度押してください` });
    const now = Date.now();
    await env.DB.prepare("UPDATE work_drafts SET status = 'queued', queued_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'failed')").bind(now, now, d.id).run();
    return draftJson(200, await getDraft(env.DB, d.id), { message: '公開の準備ができました（R2 のコマンドで公開します）' });
  } catch (e) {
    console.error('公開の待ちにできない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}
