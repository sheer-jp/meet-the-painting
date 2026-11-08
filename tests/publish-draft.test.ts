// 公開の手順（docs/REGISTER.md 5.3、scripts/publish-draft.mjs）：段取りと、止まったときにコミットも配置もしないこと
// コマンド・通信・ファイルは差し替え（本物の generate・git・wrangler は動かさない）
import { describe, it, expect } from 'vitest';
import { parseArgs, planSteps, runPublish, workFromSource, tail, classifyChanges, onlyGeneratedAt } from '../scripts/publish-lib.js';

const WORK = { id: 'test-blue', title: { ja: 'テストの青', en: 'Test Blue' }, year: 2026, size_cm: [53, 65.2], messages: ['一。', '二。', '三。'], availability: 'available', buy: { price_jpy: 198000 } };
const EXPORT = { id: 'draft_aaaaaaaaaaaaaaaa', work_id: 'test-blue', status: 'queued', work: WORK, photo: { type: 'image/jpeg', base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') } };

// generate のあとの作業ツリー（ほかの作品の space.json は generated_at だけが変わる）
const AFTER = [' M public/catalog.json', ' M public/og/gallery.png', ' M public/works.json', '?? rooms/check/entrance-house_test-blue.jpg', '?? works/test-blue/generated/space.json', '?? works/test-blue/painting.jpg', '?? works/test-blue/work.json', ' M works/harmoney/generated/space.json'];
const GEN_AT = '--- a/works/harmoney/generated/space.json\n+++ b/works/harmoney/generated/space.json\n@@ -228 +228 @@\n-  "generated_at": "2026-11-08T01:00:00.000Z"\n+  "generated_at": "2026-11-08T08:00:00.000Z"\n';
function fakeDeps(o: { fail?: string; status?: string; branch?: string; exportStatus?: number; after?: string[]; diff?: string } = {}) {
  const files = new Map<string, any>();
  const cmds: string[] = [];
  const posts: any[] = [];
  const root = '/repo';
  // ビルドの中身（check が見る）
  files.set('/repo/dist/w/test-blue/index.html', '<h1>テストの青</h1>');
  files.set('/repo/dist/works/test-blue/generated/space.json', JSON.stringify({ painting: 'painting_1024.jpg', rooms: [{ image: 'rooms/sq-sofa.jpg' }] }));
  for (const f of ['painting_1024.jpg', 'rooms/sq-sofa.jpg', 'qr.svg']) files.set(`/repo/dist/works/test-blue/generated/${f}`, 'x');
  return {
    files, cmds, posts,
    deps: {
      root,
      log: () => {},
      exec: async (cmd: string, args: string[]) => {
        const line = `${cmd} ${args.join(' ')}`;
        cmds.push(line);
        if (o.fail && line.includes(o.fail)) return { code: 1, out: 'line1\nline2\nエラーの行' };
        if (line === 'git status --porcelain') return { code: 0, out: o.status ?? '' };
        if (line === 'git status --porcelain --untracked-files=all') return { code: 0, out: (o.after ?? AFTER).join('\n') };
        if (line.startsWith('git diff --unified=0 -- ')) return { code: 0, out: o.diff ?? GEN_AT };
        if (line === 'git rev-parse --abbrev-ref HEAD') return { code: 0, out: `${o.branch ?? 'main'}\n` };
        if (line === 'git rev-parse HEAD') return { code: 0, out: 'abc1234def\n' };
        if (line === 'npx wrangler pages deploy') return { code: 0, out: 'Deployment complete! https://abc123.enter-the-painting.pages.dev' };
        return { code: 0, out: 'ok' };
      },
      http: async (method: string, url: string, body?: any) => {
        if (method === 'GET') return o.exportStatus === 204 ? { status: 204, json: null } : { status: o.exportStatus ?? 200, json: EXPORT };
        posts.push({ url, body });
        return { status: 200, json: { ok: true } };
      },
      fs: {
        exists: (p: string) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
        mkdir: () => {}, write: (p: string, d: any) => files.set(p, d), read: (p: string) => files.get(p), rm: (p: string) => { for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k); },
      },
      toJpeg: async (b: Uint8Array) => b,
    },
  };
}

describe('publish-draft の引数と段取り', () => {
  it('npm run publish-draft -- <id> は API から。段取りは 5.3 の 1〜6 の順', () => {
    const o = parseArgs(['draft_aaaaaaaaaaaaaaaa']);
    expect(o.api).toBe('https://meet.sheerarts.com');
    expect(planSteps(o)).toEqual(['preflight', 'fetch', 'claim', 'write', 'generate', 'test', 'build', 'check', 'commit', 'push', 'deploy', 'result']);
  });
  it('--dry-run は generate と build（と確かめ）で止め、サーバーの状態も変えない', () => {
    const steps = planSteps(parseArgs(['x', '--dry-run']));
    expect(steps).toEqual(['preflight', 'fetch', 'write', 'generate', 'test', 'build', 'check']);
    expect(steps).not.toContain('claim');
    expect(planSteps(parseArgs(['x', '--dry-run', '--cleanup']))).toContain('cleanup');
  });
  it('手元の JSON と写真、--no-push、--no-deploy、--ci', () => {
    const o = parseArgs(['x', '--json', 'd.json', '--photo', 'p.jpg', '--no-push', '--no-deploy', '--ci', '--allow-branch']);
    expect(o.api).toBeNull();
    expect(planSteps(o)).toEqual(['preflight', 'fetch', 'write', 'ci', 'generate', 'test', 'build', 'check', 'commit']);
    // API からでも、配置しない試しはサーバーの状態（claim・result）を動かさない
    expect(planSteps(parseArgs(['x', '--no-deploy', '--allow-branch']))).not.toContain('claim');
    expect(() => parseArgs(['x', '--json', 'd.json'])).toThrow(/--photo/);
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(['x', '--cleanup'])).toThrow(/dry-run/);
    expect(parseArgs(['--queued']).queued).toBe(true);
  });
  it('下書きの形：export の形でも、D1 の行でも work.json にできる', () => {
    expect(workFromSource(EXPORT)).toMatchObject({ workId: 'test-blue', work: WORK });
    const row = { id: 'draft_bbbbbbbbbbbbbbbb', work_id: 'red-one', status: 'queued', data: JSON.stringify({ work: { title: { ja: '赤' }, size_cm: [18, 14], messages: ['a', 'b', 'c'], availability: 'not_for_sale' } }) };
    expect(workFromSource(row)).toMatchObject({ draftId: 'draft_bbbbbbbbbbbbbbbb', workId: 'red-one', work: { id: 'red-one', title: { ja: '赤' } } });
    expect(() => workFromSource({})).toThrow();
    expect(tail(Array.from({ length: 80 }, (_, i) => `l${i}`).join('\n')).split('\n')).toHaveLength(40);
  });
});

describe('publish-draft の実行（差し替え）', () => {
  it('dry-run：works/<id>/ を書き、generate（BASE_URL は本番）→ test → build → 確かめ。コミット・push・配置・結果の書き込みはしない', async () => {
    const f = fakeDeps();
    const r = await runPublish(parseArgs(['draft_aaaaaaaaaaaaaaaa', '--dry-run']), f.deps);
    expect(r.ok).toBe(true);
    expect(JSON.parse(f.files.get('/repo/works/test-blue/work.json'))).toEqual(WORK);
    expect(f.files.has('/repo/works/test-blue/painting.jpg')).toBe(true);
    expect(f.cmds).toContain('npm run generate -- test-blue');
    expect(f.cmds.some((c) => c.startsWith('git commit') || c.startsWith('git push') || c.includes('wrangler'))).toBe(false);
    expect(f.posts).toEqual([]);
  });
  it('全部：claim → … → works/<id>/ だけをパス指定でコミット → push → 配置 → 結果（published、コミット、URL）', async () => {
    const f = fakeDeps();
    process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
    const r = await runPublish(parseArgs(['draft_aaaaaaaaaaaaaaaa']), f.deps);
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    expect(r.ok).toBe(true);
    // コミットに入る道のり：works/<id>/ と、追跡している共有の生成物（変わったものだけ）。ほかの作品の generated_at だけの変化は戻す
    const paths = 'public/catalog.json public/og/gallery.png public/works.json rooms/check/entrance-house_test-blue.jpg works/test-blue';
    expect(f.cmds).toContain('git checkout -- works/harmoney/generated/space.json');
    expect(f.cmds.indexOf('git checkout -- works/harmoney/generated/space.json')).toBeLessThan(f.cmds.findIndex((c) => c.startsWith('git commit')));
    expect([...f.cmds.find((c) => c.startsWith('git add'))!.replace('git add -- ', '').split(' ')].sort().join(' ')).toBe(paths);
    expect(f.cmds.find((c) => c.startsWith('git commit'))!.split(' -- ')[1].split(' ').sort().join(' ')).toBe(paths);
    expect(f.cmds.find((c) => c.startsWith('git commit'))).not.toContain('harmoney');
    expect(f.cmds.some((c) => /git add (-A|\.)/.test(c))).toBe(false);
    expect(f.cmds.indexOf('git push origin main')).toBeLessThan(f.cmds.indexOf('npx wrangler pages deploy'));
    expect(f.posts[0].body).toEqual({ status: 'building' });
    expect(f.posts[1].body).toMatchObject({ status: 'published', commit: 'abc1234def', deploy_url: 'https://abc123.enter-the-painting.pages.dev', page_url: 'https://meet.sheerarts.com/w/test-blue/' });
  });
  for (const step of ['generate', 'npm test', 'build']) {
    it(`${step} で止まったら、コミットも配置もせず、failed と最後の行を書く`, async () => {
      const f = fakeDeps({ fail: step === 'build' ? 'npm run build' : step === 'generate' ? 'npm run generate' : 'npm test' });
      process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
      const r = await runPublish(parseArgs(['draft_aaaaaaaaaaaaaaaa']), f.deps);
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      expect(r.ok).toBe(false);
      expect(r.step).toBe(step === 'npm test' ? 'test' : step);
      expect(f.cmds.some((c) => c.startsWith('git commit') || c.startsWith('git push') || c.includes('wrangler'))).toBe(false);
      expect(f.posts.at(-1).body.status).toBe('failed');
      expect(f.posts.at(-1).body.log).toContain('エラーの行');
    });
  }
  it('作業ツリーに変更があれば始めない。main 以外から push・配置しない。同じ id の作品があれば止める', async () => {
    const dirty = fakeDeps({ status: ' M src/page.ts' });
    expect(await runPublish(parseArgs(['x', '--dry-run']), dirty.deps)).toMatchObject({ ok: false, step: 'preflight' });
    const branch = fakeDeps({ branch: 'register-chat' });
    expect(await runPublish(parseArgs(['x', '--no-deploy']), branch.deps)).toMatchObject({ ok: false, step: 'preflight' });
    expect(await runPublish(parseArgs(['x', '--no-push', '--no-deploy']), branch.deps)).toMatchObject({ ok: false, step: 'preflight' });
    expect(branch.posts).toEqual([]);   // 始める前に止まったら、サーバーには何も書かない
    const exists = fakeDeps();
    exists.files.set('/repo/works/test-blue/work.json', '{}');
    expect(await runPublish(parseArgs(['x', '--dry-run']), exists.deps)).toMatchObject({ ok: false, step: 'fetch' });
  });
  it('generate が思わないファイルを変えたら、コミットせずに止める（ほかの作品の space.json の中身が変わったときも）', async () => {
    const odd = fakeDeps({ after: [...AFTER, ' M src/page.ts'] });
    const r = await runPublish(parseArgs(['x', '--allow-branch', '--no-push', '--no-deploy']), odd.deps);
    expect(r).toMatchObject({ ok: false, step: 'commit' });
    expect(r.log).toContain('src/page.ts');
    expect(odd.cmds.some((c) => c.startsWith('git commit') || c.startsWith('git add'))).toBe(false);
    const real = fakeDeps({ diff: '@@ -3 +3 @@\n-  "size_cm": [18, 14],\n+  "size_cm": [14, 18],\n' });
    expect(await runPublish(parseArgs(['x', '--allow-branch', '--no-push', '--no-deploy']), real.deps)).toMatchObject({ ok: false, step: 'commit' });
    expect(real.cmds.some((c) => c.startsWith('git commit'))).toBe(false);
  });
  it('道のりの分け方（純関数）', () => {
    const c = classifyChanges([...AFTER, '?? rooms/check/sq-sofa_test-blue-2.jpg', ' M rooms/check/sq-sofa_harmoney.jpg'], 'test-blue');
    expect(c.include.sort()).toEqual(['public/catalog.json', 'public/og/gallery.png', 'public/works.json', 'rooms/check/entrance-house_test-blue.jpg', 'works/test-blue']);
    expect(c.maybeRestore).toEqual(['works/harmoney/generated/space.json']);
    expect(c.unexpected).toEqual(['rooms/check/sq-sofa_test-blue-2.jpg', 'rooms/check/sq-sofa_harmoney.jpg']);
    expect(onlyGeneratedAt(GEN_AT)).toBe(true);
    expect(onlyGeneratedAt('')).toBe(false);
  });
  it('試し：main 以外のブランチでも --allow-branch --no-push --no-deploy ならコミットまで', async () => {
    const f = fakeDeps({ branch: 'tmp-publish-trial' });
    const r = await runPublish(parseArgs(['x', '--allow-branch', '--no-push', '--no-deploy']), f.deps);
    expect(r.ok).toBe(true);
    expect(f.cmds.some((c) => c.startsWith('git commit'))).toBe(true);
    expect(f.cmds.some((c) => c.startsWith('git push') || c.includes('wrangler'))).toBe(false);
    expect(f.posts).toEqual([]);
  });
  it('queued が無ければ none（何もしない）', async () => {
    const f = fakeDeps({ exportStatus: 204 });
    const r = await runPublish(parseArgs(['--queued', '--dry-run']), f.deps, 'next');
    expect(r.none).toBe(true);
    expect(f.files.has('/repo/works/test-blue/work.json')).toBe(false);
  });
  it('確かめ：部屋の画像が無ければ止める', async () => {
    const f = fakeDeps();
    f.files.delete('/repo/dist/works/test-blue/generated/rooms/sq-sofa.jpg');
    expect(await runPublish(parseArgs(['x', '--dry-run']), f.deps)).toMatchObject({ ok: false, step: 'check' });
  });
});
