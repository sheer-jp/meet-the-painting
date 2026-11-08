// 作品の登録が使えるか：GET /api/admin/works/config → { ready, reason, message, ai, publish }（docs/REGISTER.md「実装の記録」）
// ready が false のとき、管理画面は「登録はまだ使えません」を出す。ダッシュボードはそのまま動く
import { adminJson, publishConfigured } from '../../../_lib/admin-auth.js';
import { registerReady } from '../../../_lib/drafts.js';
import { NOT_READY } from '../../../_lib/works-api.js';

export async function onRequestGet({ env }) {
  const r = await registerReady(env);
  return adminJson(200, { ready: r.ok, reason: r.reason, message: r.reason ? /** @type {any} */ (NOT_READY)[r.reason] : null, ai: !!env.ANTHROPIC_API_KEY, publish: publishConfigured(env) });
}
