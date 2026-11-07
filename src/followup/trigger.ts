// 感想カードを「いつ出すか」だけを決める小さな部品（docs/ADMIN.md 3 節）。ページ用 JS に入るので軽く保つ。本体（index.ts）は出すときに import()
import { t } from '../i18n';

export type Place = 'story_end' | 'after' | 'exit' | 'rooms' | 'dwell' | 'link';
type Stat = (ev: string, id?: string | null, via?: string | null) => void;
export interface Card { moveTo(parent: HTMLElement): void; dismiss(): void; isOpen(): boolean }

export const SID_KEY = 'mtp.sid';
const CLOSED_PREFIX = 'mtp.fu.';      // localStorage：閉じた・送った作品
const SHOWN_KEY = 'mtp.fu.shown';     // sessionStorage：このタブで自動で出した作品
export const MAX_AUTO = 2;            // 1 つのタブで自動で出す作品の数
const DWELL_MS = 40_000;              // 作品ページにこれだけいたら
const STORY_END_MS = 6000;            // T5 の帯が出てからこれだけあとに
const AFTER_MS = 1800;                // 作品ページに戻ってきてから
const safe = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };

// タブごとのランダムな匿名 id。タブを閉じると消える。Global Privacy Control のときは作らない
export function sessionId(): string | null {
  return safe(() => {
    if ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return null;
    let id = sessionStorage.getItem(SID_KEY);
    if (!id) {
      id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      sessionStorage.setItem(SID_KEY, id);
    }
    return id;
  }, null);
}

// 自動で出してよいか：閉じた・送った作品には出さない。同じタブで出した作品にも出さない。タブごとに MAX_AUTO 作品まで
export function canAuto(workId: string, closed: string | null, shown: readonly string[]): boolean {
  return !closed && !shown.includes(workId) && shown.length < MAX_AUTO;
}
const readShown = (): string[] => safe(() => { const v = JSON.parse(sessionStorage.getItem(SHOWN_KEY) || '[]'); return Array.isArray(v) ? v : []; }, []);
export const workIdFromBase = (base: unknown): string | null => /(?:^|\/)works\/([a-z0-9][a-z0-9_-]*)\//.exec(String(base ?? ''))?.[1] ?? null;

export function createFollowup({ stat, lang }: { stat: Stat; lang: () => import('../i18n').Lang }) {
  let config: Promise<{ enabled: boolean; ai: boolean } | null> | null = null;
  const loadConfig = () => (config ||= fetch('/api/followup/config').then(async (r) => {
    if (!r.ok || !/json/.test(r.headers.get('content-type') || '')) return null;
    const c = await r.json() as { enabled?: unknown; ai?: unknown };
    return c?.enabled === true ? { enabled: true, ai: c.ai === true } : null;
  }).catch(() => null));

  let card: Card | null = null;
  let opening = false;
  const busy = () => opening || !!card?.isOpen();
  const inExperience = () => !!document.querySelector('#stage:not([hidden])');
  const inLightbox = () => !!document.querySelector('.lb');

  async function open(workId: string, place: Place, parent: HTMLElement, manual = false): Promise<void> {
    if (busy()) return;
    if (!manual && !canAuto(workId, safe(() => localStorage.getItem(CLOSED_PREFIX + workId), null), readShown())) return;
    opening = true;
    try {
      const c = await loadConfig();
      if (!c) return;
      const m = await import('./index');
      if (!manual) safe(() => sessionStorage.setItem(SHOWN_KEY, JSON.stringify([...readShown(), workId])), undefined);
      card = await m.openFollowup({
        workId, place, parent, lang: lang(), ai: c.ai, manual, stat, sid: sessionId(),
        remember: (v: string) => safe(() => localStorage.setItem(CLOSED_PREFIX + workId, v), undefined),
      });
    } catch (e) { console.warn('感想カードを出せない', e); } finally { opening = false; }
  }

  return {
    // 語りが終わった（T5 の帯が出た）。6 秒待って、まだ T5 にいれば帯の上に出す。「もう一度」を押したらカードは下げる
    listenStoryEnd() {
      window.addEventListener('mtp:story-end', (e) => {
        const id = workIdFromBase((e as CustomEvent).detail?.base);
        if (!id) return;
        setTimeout(() => {
          const stage = document.getElementById('stage');
          if (stage && !stage.hidden && document.querySelector('.end-band.on')) void open(id, 'story_end', stage);
        }, STORY_END_MS);
      });
      document.addEventListener('click', (e) => {
        if ((e.target as Element).closest?.('.end-band [data-action="again"]')) card?.dismiss();
      }, true);
    },
    // 作品ページ：絵の世界から戻ってきた（after=1）なら少しあとに。そうでなければ 40 秒いたら。小さなリンクはいつでも開ける
    onWorkPage(workId: string, after: boolean) {
      if (after) setTimeout(() => { void open(workId, 'after', document.body); }, AFTER_MS);
      setTimeout(() => { if (!document.hidden && !inExperience() && !inLightbox()) void open(workId, 'dwell', document.body); }, DWELL_MS);
      void loadConfig().then((c) => {
        const actions = document.querySelector('.actions');
        if (!c || !actions) return;
        const p = document.createElement('p');
        p.className = 'fu-entry';
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.i18n = 'fu_link'; b.textContent = t('fu_link', lang());
        b.addEventListener('click', () => { void open(workId, 'link', document.body, true); });
        p.appendChild(b);
        actions.after(p);
      });
    },
    // 作品ページで体験を閉じた：開いているカードは stage から body へ移す（書きかけを消さない）。無ければ少しあとに出す
    afterExperience(workId: string) {
      if (card?.isOpen()) { card.moveTo(document.body); return; }
      setTimeout(() => { void open(workId, 'exit', document.body); }, AFTER_MS);
    },
    afterRooms(workId: string) {
      setTimeout(() => { if (!inLightbox()) void open(workId, 'rooms', document.body); }, 800);
    },
  };
}
