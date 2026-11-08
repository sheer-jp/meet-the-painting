// 作品の登録の API（functions/api/admin/works/*）の共通部分。確認カードに出す「見え方」を下書きから作る
import { adminJson } from './admin-auth.js';
import { publicDraft } from './drafts.js';
import { autoRooms, roomLabel, payLine, missingForPublish, composeNext, nextField, pendingFields, AVAIL_JA } from './register.js';
import { ROOMS } from './rooms-list.js';

/** 本文を JSON で読む。大きすぎ・壊れていれば null @param {Request} req @param {number} max */
export async function readJson(req, max) {
  const n = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(n) && n > max) return null;
  try {
    const text = await req.text();
    if (text.length > max) return null;
    return JSON.parse(text);
  } catch { return null; }
}

/** 確認カードの材料（ブラウザは計算しない） @param {any} d */
export function viewOf(d) {
  const w = d.data.work || {};
  const auto = Array.isArray(w.size_cm) ? autoRooms(w.size_cm) : [];
  const chosen = w.rooms?.length ? w.rooms : auto;
  return {
    next: nextField(d),
    pending: pendingFields(d),
    missing: missingForPublish(d),
    say: composeNext(d),
    pay_line: payLine(w),
    availability_ja: w.availability ? /** @type {any} */ (AVAIL_JA)[w.availability] : null,
    rooms: chosen.map((name) => ({ name, label: roomLabel(name) })),
    rooms_auto: !w.rooms?.length,
    room_choices: ROOMS.filter((r) => !r.disabled).map((r) => ({ name: r.name, label: r.label, suits_cm: r.suits_cm })),
    page_url: d.work_id ? `https://meet.sheerarts.com/w/${d.work_id}/` : null,
  };
}

/** 下書きと見え方を返す @param {number} status @param {any} d @param {Record<string, any>} [extra] */
export const draftJson = (status, d, extra = {}) => adminJson(status, { draft: publicDraft(d), view: viewOf(d), ...extra });

/** 「登録はまだ使えません」の理由（作家向け） */
export const NOT_READY = {
  no_db: '保存先（Cloudflare D1）がつながっていません。',
  no_table: '下書きの表（migrations/0004）がまだ作られていません。',
  no_bucket: '写真の置き場（Cloudflare R2 の WORK_UPLOADS）がまだつながっていません。',
};
