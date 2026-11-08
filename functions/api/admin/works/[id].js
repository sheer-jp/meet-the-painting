// 1 つの下書き：GET（読む）、PATCH（確認カードからの変更）、DELETE（捨てる。写真もすぐ消す）
// PATCH の本文（どれか 1 つ）：
//   { confirm: 'messages', value: [...] } / { confirm: 'moods', value: { ja: [...], fit } }  作家が直して「これでいい」
//   { rooms: [...] | null }   部屋を選び直す（null で自動に戻す）
//   { work_id: '...' }        作品の id（URL）を直す
//   { tool: '<道具の名前>', input: {...} }  会話と同じ道具で 1 項目を直す（同じ検査を通す）
//   { reopen: true }          公開の待ち（queued）・失敗（failed）から下書きに戻す
import { adminJson } from '../../../_lib/admin-auth.js';
import { readCatalog } from '../../../_lib/catalog.js';
import { registerReady, getDraft, saveDraft, takenIds, checkWorkId, ensureWorkId, photoKey } from '../../../_lib/drafts.js';
import { applyPatch, confirmProposal, validateTool, checkRooms, TOOL_NAMES } from '../../../_lib/register.js';
import { readJson, draftJson } from '../../../_lib/works-api.js';

const MAX_BODY = 8000;

/** @param {any} env */
async function ready(env) {
  const r = await registerReady(env);
  return r.ok ? null : adminJson(503, { error: 'not_ready', reason: r.reason });
}

export async function onRequestGet({ params, env }) {
  const nr = await ready(env); if (nr) return nr;
  const d = await getDraft(env.DB, String(params.id));
  return d ? draftJson(200, d) : adminJson(404, { error: 'not_found' });
}

export async function onRequestPatch({ request: req, params, env }) {
  const nr = await ready(env); if (nr) return nr;
  const body = await readJson(req, MAX_BODY);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return adminJson(400, { error: 'bad_request' });
  const d = await getDraft(env.DB, String(params.id));
  if (!d) return adminJson(404, { error: 'not_found' });
  try {
    if (body.reopen === true) {
      if (d.status !== 'queued' && d.status !== 'failed') return adminJson(409, { error: 'locked', status: d.status });
      await env.DB.prepare("UPDATE work_drafts SET status = 'draft', queued_at = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')").bind(Date.now(), d.id).run();
      return draftJson(200, await getDraft(env.DB, d.id));
    }
    if (d.status !== 'draft' && d.status !== 'failed') return adminJson(409, { error: 'locked', status: d.status });
    let next = d;
    if (body.confirm === 'messages' || body.confirm === 'moods') {
      const r = confirmProposal(d.data, body.confirm, body.value);
      if (!r.ok) return adminJson(422, { error: 'invalid', message: r.error });
      next = { ...d, data: r.data };
    } else if ('rooms' in body) {
      if (body.rooms === null) {
        const data = applyPatch(d.data, { work: { rooms: null } });
        next = { ...d, data };
      } else {
        const r = checkRooms(body.rooms);
        if (!r.ok) return adminJson(422, { error: 'invalid', message: r.error });
        next = { ...d, data: applyPatch(d.data, { work: { rooms: r.rooms } }) };
      }
    } else if ('work_id' in body) {
      const r = checkWorkId(body.work_id, await takenIds(env.DB, await readCatalog(req, env), d.id));
      if (!r.ok) return adminJson(422, { error: 'invalid', message: r.error });
      next = { ...d, work_id: r.id, data: { ...d.data, id_source: 'manual' } };
    } else if (typeof body.tool === 'string' && TOOL_NAMES.includes(body.tool)) {
      const v = validateTool(body.tool, body.input, { photo: d.photo });
      if (!v.ok) return adminJson(422, { error: 'invalid', message: v.error });
      next = ensureWorkId({ ...d, data: applyPatch(d.data, v.patch) }, await takenIds(env.DB, await readCatalog(req, env), d.id));
    } else return adminJson(400, { error: 'bad_request' });
    if (!await saveDraft(env.DB, next)) return adminJson(409, { error: 'locked' });
    return draftJson(200, await getDraft(env.DB, d.id));
  } catch (e) {
    console.error('下書きを直せない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}

export async function onRequestDelete({ params, env }) {
  const nr = await ready(env); if (nr) return nr;
  const d = await getDraft(env.DB, String(params.id));
  if (!d) return adminJson(404, { error: 'not_found' });
  if (d.status === 'building' || d.status === 'published') return adminJson(409, { error: 'locked', status: d.status });
  try {
    await env.WORK_UPLOADS.delete(photoKey(d.id));
    await env.DB.prepare("DELETE FROM work_drafts WHERE id = ? AND status NOT IN ('building', 'published')").bind(d.id).run();
    return adminJson(200, { ok: true });
  } catch (e) {
    console.error('下書きを消せない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}
