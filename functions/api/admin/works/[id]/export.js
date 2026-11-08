// 公開の手順が下書きを受け取る：GET /api/admin/works/<id>/export（公開専用のトークンだけ。docs/REGISTER.md 5.3 の 1）
// <id> が next なら、いちばん古い queued。無ければ 204
// → { id, work_id, status, work（work.json の形）, photo: { type, width, height, base64 } }
import { adminJson } from '../../../../_lib/admin-auth.js';
import { registerReady, getDraft, photoKey } from '../../../../_lib/drafts.js';
import { toWorkJson, missingForPublish } from '../../../../_lib/register.js';

/** @param {Uint8Array} b */
function toBase64(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function onRequestGet({ params, env, data }) {
  if (!data?.publisher) return adminJson(401, { error: 'unauthorized' });
  const r = await registerReady(env);
  if (!r.ok) return adminJson(503, { error: 'not_ready', reason: r.reason });
  let id = String(params.id);
  if (id === 'next') {
    const row = await env.DB.prepare("SELECT id FROM work_drafts WHERE status = 'queued' ORDER BY queued_at, id LIMIT 1").first();
    if (!row) return new Response(null, { status: 204 });
    id = row.id;
  }
  const d = await getDraft(env.DB, id);
  if (!d) return adminJson(404, { error: 'not_found' });
  if (d.status !== 'queued' && d.status !== 'building') return adminJson(409, { error: 'not_queued', status: d.status });
  const missing = missingForPublish(d);
  if (missing.length) return adminJson(422, { error: 'incomplete', missing });
  const obj = await env.WORK_UPLOADS.get(photoKey(d.id));
  if (!obj) return adminJson(404, { error: 'no_photo' });
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return adminJson(200, { id: d.id, work_id: d.work_id, status: d.status, work: toWorkJson(d), photo: { type: d.photo.type, width: d.photo.width, height: d.photo.height, base64: toBase64(bytes) } });
}
