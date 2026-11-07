import { adminJson, clearCookie } from '../../_lib/admin-auth.js';

export function onRequestPost() {
  return adminJson(200, { ok: true }, { 'Set-Cookie': clearCookie() });
}
