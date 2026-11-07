// 受付（E-1 / E-5）：合言葉の照合、上流の再試行、/api/recommend/config、光の色
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkPassphrase, retryableStatus, fetchUpstream, onRequestPost } from '../functions/api/recommend.js';
import { onRequestGet } from '../functions/api/recommend/config.js';
import { glowColor } from '../src/concierge/index';
import { galleryPage } from '../scripts/generate/pages.js';
import { nextStage, stageMs, presentSchedule, STAGE_MS, FAST_MS, type Stage } from '../src/concierge/stages';
import { vrEntryAllowed, bandFor, afterUrl } from '../src/concierge/enter';

afterEach(() => { vi.restoreAllMocks(); });

describe('checkPassphrase', () => {
  it('期待値が空なら照合しない', () => {
    expect(checkPassphrase('', null)).toBe(true);
    expect(checkPassphrase(undefined, 'x')).toBe(true);
  });
  it('一致したときだけ通す', () => {
    expect(checkPassphrase('kanazawa', 'kanazawa')).toBe(true);
    expect(checkPassphrase('kanazawa', 'kanazaw')).toBe(false);
    expect(checkPassphrase('kanazawa', 'kanazawa2')).toBe(false);
    expect(checkPassphrase('kanazawa', '')).toBe(false);
    expect(checkPassphrase('kanazawa', null)).toBe(false);
  });
});

const req = (headers: Record<string, string> = {}) => new Request('https://example.com/api/recommend', {
  method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json', 'CF-Connecting-IP': `ip-${Math.random()}`, ...headers },
  body: JSON.stringify({ lang: 'ja', messages: [{ role: 'user', content: '朝' }] }),
});

describe('POST /api/recommend の合言葉', () => {
  it('PASSPHRASE があって X-Passphrase が違えば 403 passphrase（値はログに出さない）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await onRequestPost({ request: req({ 'X-Passphrase': 'wrong' }), env: { PASSPHRASE: 'right-one' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'passphrase' });
    expect(JSON.stringify(err.mock.calls)).not.toContain('right-one');
    expect(JSON.stringify(err.mock.calls)).not.toContain('wrong');
  });
  it('ヘッダが無くても 403', async () => {
    const res = await onRequestPost({ request: req(), env: { PASSPHRASE: 'right-one' } });
    expect(res.status).toBe(403);
  });
  it('合っていれば合言葉の先へ進む（ここではカタログが無いので 502）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { PASSPHRASE: 'right-one', ASSETS: { fetch: async () => new Response('no', { status: 404 }) } };
    const res = await onRequestPost({ request: req({ 'X-Passphrase': 'right-one' }), env });
    expect(res.status).toBe(502);
  });
});

describe('GET /api/recommend/config', () => {
  it('合言葉が要るかどうかだけを返す（値は返さない）、no-store', async () => {
    const on = onRequestGet({ env: { PASSPHRASE: 'secret-value' } });
    expect(on.headers.get('Cache-Control')).toBe('no-store');
    const body = await on.text();
    expect(JSON.parse(body)).toEqual({ passphrase: true });
    expect(body).not.toContain('secret-value');
    expect(await onRequestGet({ env: {} }).json()).toEqual({ passphrase: false });
    expect(await onRequestGet({ env: { PASSPHRASE: '' } }).json()).toEqual({ passphrase: false });
  });
});

describe('fetchUpstream（上流の一時的な失敗は 1 回だけ再試行）', () => {
  it('再試行する状態：429 / 5xx / 529', () => {
    for (const s of [429, 500, 502, 503, 529]) expect(retryableStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 403, 404, 422]) expect(retryableStatus(s)).toBe(false);
  });
  it('529 のあと 200 なら 200（2 回呼ぶ）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 529 })).mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const r = await fetchUpstream(f, 0);
    expect(r?.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('例外のあと例外なら null（2 回まで）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockRejectedValue(new Error('net'));
    expect(await fetchUpstream(f, 0)).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('400 は再試行しない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue(new Response('bad', { status: 400 }));
    expect((await fetchUpstream(f, 0))?.status).toBe(400);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('2 回とも 503 なら最後の応答（呼び出し側が 502 にする）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn().mockImplementation(async () => new Response('x', { status: 503 }));
    expect((await fetchUpstream(f, 0))?.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('glowColor（ピカーンの光の色）', () => {
  it('主要色の色相のまま明るくする。白にはしない', () => {
    expect(glowColor('#df4f09')).toMatch(/^hsl\(20 85% 80%\)$/);
    expect(glowColor('#1d2b3a')).toMatch(/80%\)$/);
    expect(glowColor(undefined)).toMatch(/^hsl\(/);
    expect(glowColor('#ffffff')).toBe('hsl(0 0% 100%)');
  });
});

describe('3 段の状態機械（docs/ENTRANCE.md 3.5：読ませる → 考えている → C2）', () => {
  it('おすすめが決まると read → thinking → sink → present と進む', () => {
    let s: Stage = 'talk';
    const seen: Stage[] = [];
    s = nextStage(s, 'recommend');
    while (s !== 'present') { seen.push(s); s = nextStage(s, 'tick'); }
    expect(seen).toEqual(['read', 'thinking', 'sink']);
    expect(nextStage('present', 'tick')).toBe('present');   // C2 は時間では進まない
  });
  it('時間：読ませる 1.6 秒、考えている 1.4 秒（ルールだけの版は 1.0 秒）、沈む 0.5 秒', () => {
    expect(STAGE_MS).toEqual({ read: 1600, thinking: 1400, thinkingRules: 1000, sink: 500 });
    expect(stageMs('read', { rules: false })).toBe(1600);
    expect(stageMs('thinking', { rules: false })).toBe(1400);
    expect(stageMs('thinking', { rules: true })).toBe(1000);
    expect(stageMs('sink', { rules: true })).toBe(500);
    expect(stageMs('present', { rules: false })).toBe(0);
    expect(stageMs('talk', { rules: false, fast: true })).toBe(0);
  });
  it('予定：AI の版は 3.5 秒、ルールだけの版は 3.1 秒で C2。テスト用の fast は各段 100ms', () => {
    expect(presentSchedule({ rules: false })).toEqual([
      { stage: 'read', at: 0 }, { stage: 'thinking', at: 1600 }, { stage: 'sink', at: 3000 }, { stage: 'present', at: 3500 },
    ]);
    expect(presentSchedule({ rules: true }).at(-1)).toEqual({ stage: 'present', at: 3100 });
    expect(presentSchedule({ rules: false, fast: true }).map((x) => x.at)).toEqual([0, FAST_MS, 2 * FAST_MS, 3 * FAST_MS]);
  });
  it('会話に戻る → もう一度見る、もう一度話すはどこからでも最初へ', () => {
    expect(nextStage('present', 'close')).toBe('back');
    expect(nextStage('back', 'reopen')).toBe('present');
    expect(nextStage('back', 'recommend')).toBe('read');   // 戻ったあと AI が新しく提案したら、また 3 段
    for (const s of ['read', 'thinking', 'sink', 'present', 'back'] as Stage[]) expect(nextStage(s, 'again')).toBe('talk');
  });
  it('決まっていない組み合わせは動かない', () => {
    expect(nextStage('talk', 'close')).toBe('talk');
    expect(nextStage('talk', 'reopen')).toBe('talk');
    expect(nextStage('read', 'close')).toBe('read');
    expect(nextStage('present', 'recommend')).toBe('present');   // C2 の中の差し替えは 3 段を通らない
    expect(nextStage('talk', 'tick')).toBe('talk');
  });
});

describe('受付の最初の画面はボタンだけ（11-06 作家）', () => {
  const html = galleryPage({ works: [{ id: 'harmoney' }], baseUrl: 'https://example.com' });
  it('扉の入場（ENTRANCE 3.7）：既定で隠し、判定のスクリプトは受付の <main> より前。JS が止まっても CSS だけで消える', () => {
    expect(html).toContain('.door{display:none}');
    expect(html).toMatch(/\.door\{display:none\}[\s\S]*@keyframes door-bail\{from,to\{visibility:hidden;/);
    const door = html.indexOf('<div class="door" id="door" aria-hidden="true">');
    const script = html.indexOf('<script>(function(){', door);
    const main = html.indexOf('<main class="cg"');
    expect(door).toBeGreaterThan(-1);
    expect(door).toBeLessThan(script);
    expect(script).toBeLessThan(main);
    expect(html).toContain('prefers-reduced-motion');
    expect(html).toContain('sessionStorage');
  });
  it('入力欄は最初は隠し、3 つの選択肢の下に 4 つ目「自分のことばで書く」', () => {
    expect(html).toMatch(/<form class="cg-form"[^>]*\shidden>/);
    const opts = [...html.matchAll(/<button type="button" class="cg-opt[^"]*" data-opener-index="([^"]+)"/g)].map((m) => m[1]);
    expect(opts).toEqual(['0', '1', '2', 'write']);
    expect(html).toContain('class="cg-opt cg-write"');
    expect(html).toContain('自分のことばで書く');
    expect(html).toContain('Write in my own words');
    expect(html).toContain('近いものがあれば、選んでください');
  });
  it('最初の 3 文は data-greet で catalog の greeting の何番目かを持つ（他の言語の差し替え用。E-15）', () => {
    const idx = [...html.matchAll(/<p class="cg-line cg-ai cg-greet" data-greet="(\d)"/g)].map((m) => m[1]);
    expect(idx).toEqual(['0', '1', '2']);
    expect(html).toContain('<span class="cg-openers-cap"><span lang="ja" data-lang="ja">近いものがあれば、選んでください</span><span lang="en" data-lang="en" hidden>Pick one if it fits</span></span>');
  });
  it('おすすめの画面 C2 の枠とひとこと（present_line）が HTML にある', () => {
    expect(html).toMatch(/<section class="cg2"[^>]*hidden>/);
    expect(html).toContain('これ、どうかな。');
    expect(html).toContain('今日は、どんな絵を探してる？');
    expect(html).toContain('How about this one?');
  });
});

// E-12：C2 から一気に絵の中へ。終わったら作品ページ（?via=concierge&after=1）の帯、VR ボタンの出し分け
describe('作品ページの帯（bandFor）', () => {
  const q = (s: string) => new URLSearchParams(s);
  it('受付から来ていなければ帯は無い', () => {
    expect(bandFor(q(''), true)).toBeNull();
    expect(bandFor(q('via=gallery'), true)).toBeNull();
    expect(bandFor(q('after=1'), true)).toBeNull();
  });
  it('via=concierge だけなら「今日のあなたへの 1 点」＋「別のにする」「ギャラリー全体を見る」', () => {
    const b = bandFor(q('via=concierge'), true)!;
    expect(b.kind).toBe('via');
    expect(b.head).toBe('cg_card_head');
    expect(b.items.map((i) => i.key)).toEqual(['cg_other', 'cg_all']);
  });
  it('after=1 なら「絵の中から戻ってきました」＋「もう一度のぞく」「部屋で見る」「ギャラリー全体を見る」', () => {
    const b = bandFor(q('via=concierge&after=1'), true)!;
    expect(b.kind).toBe('after');
    expect(b.head).toBe('cg_after_head');
    expect(b.items.map((i) => i.action)).toEqual(['again', 'rooms', 'gallery']);
  });
  it('部屋の画像が無い作品では「部屋で見る」を出さない', () => {
    expect(bandFor(q('via=concierge&after=1'), false)!.items.map((i) => i.action)).toEqual(['again', 'gallery']);
  });
  it('after が 1 以外なら通常の帯', () => {
    expect(bandFor(q('via=concierge&after=0'), true)!.kind).toBe('via');
  });
  it('終わったあとの URL は /w/<id>/?via=concierge&after=1', () => {
    expect(afterUrl('w/harmoney/', 'https://example.com/catalog.json')).toBe('https://example.com/w/harmoney/?via=concierge&after=1');
  });
});

describe('「VR でのぞく」の出し分け（vrEntryAllowed）', () => {
  const quest = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0 Chrome/126.0 VR Safari/537.36';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  it('Quest のブラウザで immersive-vr が使えるときだけ出す', () => {
    expect(vrEntryAllowed(true, quest, false)).toBe(true);
    expect(vrEntryAllowed(false, quest, false)).toBe(false);
  });
  it('Android Chrome（Cardboard で true を返すことがある）や PC では出さない', () => {
    expect(vrEntryAllowed(true, android, false)).toBe(false);
    expect(vrEntryAllowed(true, mac, false)).toBe(false);
  });
  it('?vr=1 の強制は UA を問わないが、immersive-vr が使えないときは出さない', () => {
    expect(vrEntryAllowed(true, mac, true)).toBe(true);
    expect(vrEntryAllowed(false, mac, true)).toBe(false);
  });
});
