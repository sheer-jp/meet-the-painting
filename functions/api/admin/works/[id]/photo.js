// 下書きの写真：PUT（ブラウザで長辺 2000px に縮めた JPEG か PNG をそのまま本文で）、GET（確認カードに出す）
// 種類は中身で確かめる（拡張子や Content-Type を信じない）、15MB まで、EXIF などを消してから R2 に置く（docs/REGISTER.md 7 節）
import { adminJson } from '../../../../_lib/admin-auth.js';
import { registerReady, getDraft, photoKey } from '../../../../_lib/drafts.js';
import { checkPhoto, MAX_PHOTO_BYTES } from '../../../../_lib/image.js';
import { draftJson } from '../../../../_lib/works-api.js';

const MESSAGES = {
  too_large: '写真が 15MB を超えています。',
  heic: 'HEIC はこのまま受け取れません。JPEG か PNG で選んでください。',
  type: 'JPEG か PNG の写真を選んでください。',
  broken: '写真を読めませんでした。別の写真で試してください。',
  small: '写真が小さすぎます（長辺 1600px 以上で撮ってください）。',
  big: '写真が大きすぎます（長辺 2000px に縮めてから送ります。画面を読み直してください）。',
};

export async function onRequestPut({ request: req, params, env }) {
  const r = await registerReady(env);
  if (!r.ok) return adminJson(503, { error: 'not_ready', reason: r.reason });
  const n = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(n) && n > MAX_PHOTO_BYTES) return adminJson(413, { error: 'too_large', message: MESSAGES.too_large });
  const d = await getDraft(env.DB, String(params.id));
  if (!d) return adminJson(404, { error: 'not_found' });
  if (d.status !== 'draft' && d.status !== 'failed') return adminJson(409, { error: 'locked', status: d.status });
  let bytes;
  try { bytes = new Uint8Array(await req.arrayBuffer()); } catch { return adminJson(400, { error: 'bad_request' }); }
  const c = checkPhoto(bytes);
  if (!c.ok) return adminJson(c.error === 'too_large' ? 413 : 415, { error: c.error, message: /** @type {any} */ (MESSAGES)[c.error] });
  try {
    await env.WORK_UPLOADS.put(photoKey(d.id), c.bytes, { httpMetadata: { contentType: c.type } });
    await env.DB.prepare("UPDATE work_drafts SET photo_key = ?, photo_type = ?, photo_w = ?, photo_h = ?, photo_bytes = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'failed')")
      .bind(photoKey(d.id), c.type, c.width, c.height, c.bytes.length, Date.now(), d.id).run();
    return draftJson(200, await getDraft(env.DB, d.id));
  } catch (e) {
    console.error('写真を置けない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}

export async function onRequestGet({ params, env }) {
  const r = await registerReady(env);
  if (!r.ok) return adminJson(503, { error: 'not_ready' });
  const d = await getDraft(env.DB, String(params.id));
  if (!d?.photo) return adminJson(404, { error: 'not_found' });
  const obj = await env.WORK_UPLOADS.get(photoKey(d.id));
  if (!obj) return adminJson(404, { error: 'not_found' });
  return new Response(obj.body, { status: 200, headers: { 'Content-Type': d.photo.type === 'image/png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
}
