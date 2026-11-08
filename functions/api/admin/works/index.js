// 作品の一覧と下書き：GET /api/admin/works → { ready, drafts, works }。新しい下書き：POST /api/admin/works → 201 { draft, view }
import { adminJson } from '../../../_lib/admin-auth.js';
import { readCatalog } from '../../../_lib/catalog.js';
import { registerReady, listDrafts, createDraft, publicDraft } from '../../../_lib/drafts.js';
import { draftJson, NOT_READY } from '../../../_lib/works-api.js';
import { missingForPublish } from '../../../_lib/register.js';

const MAX_OPEN = 30;   // 書きかけの下書きの上限（作りすぎを防ぐ）

export async function onRequestGet({ request: req, env }) {
  const catalog = await readCatalog(req, env);
  const works = (catalog?.works || []).map((/** @type {any} */ w) => ({
    id: w.id, title: w.title?.ja || w.title?.en || w.id, year: w.year ?? null, size_cm: w.size_cm, availability: w.availability ?? null,
    thumb: typeof w.image === 'string' ? `/${w.image.replace(/painting_1024\.jpg$/, 'painting_480.jpg')}` : null, url: w.url ? `/${w.url}` : null,
  }));
  const r = await registerReady(env);
  if (!r.ok) return adminJson(200, { ready: false, reason: r.reason, message: /** @type {any} */ (NOT_READY)[r.reason || 'no_db'], drafts: [], works });
  try {
    const drafts = (await listDrafts(env.DB)).map((d) => ({ ...publicDraft(d), missing: missingForPublish(d) }));
    return adminJson(200, { ready: true, drafts, works });
  } catch (e) {
    console.error('下書きを読めない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}

export async function onRequestPost({ env }) {
  const r = await registerReady(env);
  if (!r.ok) return adminJson(503, { error: 'not_ready', reason: r.reason });
  try {
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM work_drafts WHERE status = 'draft'").first();
    if (Number(open?.n ?? 0) >= MAX_OPEN) return adminJson(429, { error: 'too_many_drafts' });
    return draftJson(201, await createDraft(env.DB));
  } catch (e) {
    console.error('下書きを作れない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}
