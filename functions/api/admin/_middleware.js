// /api/admin/* の門番（docs/ADMIN.md 5 節）。既定で拒否。例外は config と login だけ（新しい API を足しても閉じたまま）
// 公開専用のトークン（docs/REGISTER.md 5.3）：/api/admin/works/<id>/export と /result だけは、Cookie ではなく Authorization: Bearer <PUBLISH_TOKEN> で通す
// （公開のスクリプトから呼ぶので Origin が無い。この 2 つは Cookie では通さず、トークンもほかの API では通らない）
import { adminConfigured, adminJson, currentAdmin, sameOriginWrite, publishTokenOk, ADMIN_HEADERS, PUBLISH_PATH_RE } from '../../_lib/admin-auth.js';

const PUBLIC = new Set(['/api/admin/config', '/api/admin/login']);

export async function onRequest(ctx) {
  const { request: req, env } = ctx;
  const path = new URL(req.url).pathname.replace(/\/$/, '');
  if (PUBLISH_PATH_RE.test(path)) {
    if (!await publishTokenOk(req, env)) return adminJson(401, { error: 'unauthorized' });
    ctx.data.publisher = true;
  } else if (!PUBLIC.has(path)) {
    if (!adminConfigured(env)) return adminJson(503, { error: 'not_configured' });
    const admin = await currentAdmin(req, env);
    if (!admin) return adminJson(401, { error: 'unauthorized' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOriginWrite(req)) return adminJson(403, { error: 'csrf' });
    ctx.data.admin = admin;
  }
  const res = await ctx.next();
  // 404 など、どの応答にも noindex と no-store を付ける
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', ADMIN_HEADERS['Cache-Control']);
  out.headers.set('X-Robots-Tag', ADMIN_HEADERS['X-Robots-Tag']);
  return out;
}
