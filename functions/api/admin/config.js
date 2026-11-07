// ログインの画面が要るものだけ。クライアント ID は公開してよい値。許可リストやメールアドレスは返さない
import { adminConfigured, adminJson } from '../../_lib/admin-auth.js';

export function onRequestGet({ env }) {
  return adminJson(200, adminConfigured(env) ? { configured: true, clientId: env.GOOGLE_CLIENT_ID } : { configured: false, clientId: null });
}
