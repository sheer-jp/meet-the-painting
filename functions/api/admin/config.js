// 設定が済んでいるかだけを返す（ID や Secret の中身は返さない）
import { adminConfigured, adminJson } from '../../_lib/admin-auth.js';

export function onRequestGet({ env }) {
  return adminJson(200, { configured: adminConfigured(env) });
}
