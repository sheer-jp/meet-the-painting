// 登録の聞き役：POST /api/admin/works/chat { id, messages, colors?, focus? } → { reply, mode, draft, view, errors }（docs/REGISTER.md 3 節）
// 会話の文は保存しない（ログにも出さない）。保存するのは道具で確かめた項目の値だけ。写真は送らない
// ANTHROPIC_API_KEY が無い・上流が失敗・1 日の上限を超えたら、決まった順に聞くだけの版（ルールだけの版）で続ける
import { adminJson, makeRateLimit } from '../../../_lib/admin-auth.js';
import { readCatalog } from '../../../_lib/catalog.js';
import { takeDaily } from '../../../_lib/events.js';
import { registerReady, getDraft, saveDraft, takenIds, ensureWorkId } from '../../../_lib/drafts.js';
import { validateChatBody, claudeTurn, rulesTurn, callClaudeApi } from '../../../_lib/register-chat.js';
import { readJson, draftJson } from '../../../_lib/works-api.js';

const MAX_BODY = 40_000;
export const AI_DAILY_CAP = 300;   // 登録の聞き役が Claude に聞く回数の 1 日の上限（1 件 20 往復ほど）
const limited = makeRateLimit(30);

/**
 * テストから Claude の呼び出しを差し替えられるように分けてある
 * @param {Request} req @param {any} env @param {{ callClaude?: (body: any) => Promise<any|null> }} [o]
 */
export async function handleChat(req, env, o = {}) {
  const ready = await registerReady(env);
  if (!ready.ok) return adminJson(503, { error: 'not_ready', reason: ready.reason });
  if (limited('register')) return adminJson(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  const chat = validateChatBody(await readJson(req, MAX_BODY));
  if (!chat) return adminJson(400, { error: 'bad_request' });
  const d = await getDraft(env.DB, chat.id);
  if (!d) return adminJson(404, { error: 'not_found' });
  if (d.status !== 'draft' && d.status !== 'failed') return adminJson(409, { error: 'locked', status: d.status });
  if (!d.photo) return adminJson(409, { error: 'no_photo' });
  if (chat.colors.length) d.data = { ...d.data, colors: chat.colors };

  const last = chat.messages[chat.messages.length - 1].content;
  let out = null, mode = 'rules';
  const callClaude = o.callClaude || (env.ANTHROPIC_API_KEY ? (/** @type {any} */ body) => callClaudeApi(env, body) : null);
  if (callClaude && await takeDaily(env.DB, 'register_ai', AI_DAILY_CAP)) {
    try {
      const r = await claudeTurn(d, chat, env.CLAUDE_MODEL || 'claude-sonnet-5-5', callClaude);
      if (r.reply != null) { out = r; mode = 'ai'; }
    } catch (e) { console.error('登録の聞き役：Claude との往復に失敗', String(e)); }
  }
  if (!out) out = { ...rulesTurn(d, last, chat.focus), errors: [] };

  let next = out.draft;
  try {
    next = ensureWorkId(next, await takenIds(env.DB, await readCatalog(req, env), d.id));
    if (!await saveDraft(env.DB, next)) return adminJson(409, { error: 'locked' });
    const saved = await getDraft(env.DB, d.id);
    return draftJson(200, saved, { reply: out.reply, mode, errors: out.errors || [] });
  } catch (e) {
    console.error('下書きを保存できない', String(e));
    return adminJson(503, { error: 'unavailable' });
  }
}

export const onRequestPost = (/** @type {any} */ { request, env }) => handleChat(request, env);
