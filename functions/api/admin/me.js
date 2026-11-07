import { adminJson } from '../../_lib/admin-auth.js';

export function onRequestGet({ data }) {
  return adminJson(200, { name: data.admin.name });
}
