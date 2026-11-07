// 感想を消す：DELETE /api/admin/feedback/<id>。門番が認可と CSRF を確かめたあとだけ来る
import { adminJson } from '../../../_lib/admin-auth.js';
import { dbReady } from '../../../_lib/events.js';

export async function onRequestDelete({ params, env }) {
  const id = String(params.id ?? '');
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(id)) return adminJson(400, { error: 'bad_request' });
  if (!await dbReady(env)) return adminJson(503, { error: 'unavailable' });
  try {
    await env.DB.prepare('DELETE FROM feedback WHERE id = ?').bind(id).run();
    return adminJson(200, { ok: true });
  } catch (e) {
    console.error('感想を消せない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}
