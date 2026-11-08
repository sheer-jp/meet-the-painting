// 公開の手順（docs/REGISTER.md 5.3 の 1〜6）。scripts/publish-draft.mjs の中身。段取り（planSteps）と実行（runPublish）を分け、
// 外とのやりとり（コマンド、通信、ファイル）は deps で差し替えられるようにしてある（tests/publish-draft.test.ts）
// 決まった手順だけを動かす。止まったら直さずに、止まった段と最後の 40 行を書いて終わる（コミットも配置もしない）
import { join } from 'node:path';
import { toWorkJson, draftFromRow, WORK_ID_RE } from '../functions/_lib/register.js';

export const DEFAULT_BASE_URL = 'https://meet.sheerarts.com';
const TAIL = 40;

/**
 * 引数を読む
 * npm run publish-draft -- <下書きの id> [--api <origin>] [--json <file> --photo <file>] [--dry-run] [--cleanup] [--no-push] [--no-deploy] [--ci] [--skip-tests] [--result <file>]
 * npm run publish-drafts（--queued：queued の下書きを 1 件ずつ）
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const o = { ids: /** @type {string[]} */ ([]), queued: false, api: null, json: null, photo: null, dryRun: false, cleanup: false, push: true, deploy: true, ci: false, tests: true, result: null, baseUrl: DEFAULT_BASE_URL, allowBranch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} の値がありません`); return v; };
    if (a === '--queued') o.queued = true;
    else if (a === '--api') o.api = val().replace(/\/$/, '');
    else if (a === '--json') o.json = val();
    else if (a === '--photo') o.photo = val();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--cleanup') o.cleanup = true;
    else if (a === '--no-push') o.push = false;
    else if (a === '--no-deploy') o.deploy = false;
    else if (a === '--ci') o.ci = true;
    else if (a === '--skip-tests') o.tests = false;
    else if (a === '--result') o.result = val();
    else if (a === '--base-url') o.baseUrl = val().replace(/\/$/, '');
    else if (a === '--allow-branch') o.allowBranch = true;   // main 以外のブランチへのコミット（試しのとき。push と配置は main からだけ）
    else if (a.startsWith('--')) throw new Error(`知らない引数：${a}`);
    else o.ids.push(a);
  }
  if (o.json && !o.photo) throw new Error('--json には --photo も要ります');
  if (!o.json && !o.api) o.api = DEFAULT_BASE_URL;
  if (o.json) o.api = null;
  if (o.queued && o.json) throw new Error('--queued は API から読むときだけ');
  if (!o.queued && o.ids.length !== 1) throw new Error('下書きの id を 1 つ渡してください（queued を全部なら npm run publish-drafts）');
  if (o.cleanup && !o.dryRun) throw new Error('--cleanup は --dry-run のときだけ');
  return o;
}

/**
 * 段取り。dry-run は確かめ（check）で止める：サーバーの状態も変えない（claim と result を飛ばす）
 * @param {ReturnType<typeof parseArgs>} o
 */
export function planSteps(o) {
  const api = !!o.api;
  const steps = ['preflight', 'fetch'];
  if (api && !o.dryRun) steps.push('claim');
  steps.push('write');
  if (o.ci) steps.push('ci');
  steps.push('generate');
  if (o.tests) steps.push('test');
  steps.push('build', 'check');
  if (o.dryRun) return o.cleanup ? [...steps, 'cleanup'] : steps;
  steps.push('commit');
  if (o.push) steps.push('push');
  if (o.deploy) steps.push('deploy');
  if (api) steps.push('result');
  return steps;
}

/** 失敗したときに書く、最後の 40 行 @param {string} s */
export const tail = (s) => String(s || '').split('\n').filter((l) => l.trim()).slice(-TAIL).join('\n');

/**
 * 下書き（API の export の形か、D1 の行・draftFromRow の形の JSON）から { draftId, workId, work }
 * @param {any} x
 */
export function workFromSource(x) {
  if (x && x.work && typeof x.work === 'object' && x.work_id) return { draftId: x.id ?? null, workId: x.work_id, work: x.work };
  // D1 の行（data が文字列）か、draftFromRow の形（data がオブジェクト）
  if (x && x.data) {
    const d = typeof x.data === 'string' ? draftFromRow(x) : x;
    return { draftId: d.id ?? null, workId: d.work_id, work: toWorkJson(d) };
  }
  throw new Error('下書きの JSON の形が違います（export の形か、下書きの行）');
}

/**
 * 実行。deps：
 *   exec(cmd, args, { env? }) → Promise<{ code, out }>  コマンド（out は標準出力と標準エラーをまとめたもの）
 *   http(method, url, body?) → Promise<{ status, json }>  API（公開専用のトークンは deps 側で付ける）
 *   fs：{ exists, mkdir, write, read, rm }
 *   log(line)
 *   root：リポジトリの場所
 * @param {ReturnType<typeof parseArgs>} o @param {any} deps @param {string} [id] 下書きの id（--queued のときは 'next'）
 * @returns {Promise<{ ok: boolean, step: string|null, draftId: string|null, workId: string|null, commit?: string|null, deployUrl?: string|null, pageUrl?: string|null, log?: string, ms: number, done: string[], none?: boolean, dirty?: string[] }>}
 */
export async function runPublish(o, deps, id = o.ids[0]) {
  const t0 = Date.now();
  const steps = planSteps(o);
  const done = [];
  const st = { draftId: /** @type {string|null} */ (o.json ? null : id), workId: /** @type {string|null} */ (null), work: /** @type {any} */ (null), photo: /** @type {Uint8Array|null} */ (null), title: '', commit: /** @type {string|null} */ (null), deployUrl: /** @type {string|null} */ (null), claimed: false, before: /** @type {string[]} */ ([]) };
  let out = '';
  const run = async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ env) => {
    deps.log(`$ ${cmd} ${args.join(' ')}`);
    const r = await deps.exec(cmd, args, env ? { env } : {});
    out += `\n$ ${cmd} ${args.join(' ')}\n${r.out}`;
    if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} が ${r.code} で止まった`);
    return r.out;
  };
  const dir = () => join(deps.root, 'works', /** @type {string} */ (st.workId));
  const finish = async (/** @type {boolean} */ ok, /** @type {string|null} */ step, /** @type {any} */ extra = {}) => {
    const res = { ok, step, draftId: st.draftId, workId: st.workId, commit: st.commit, deployUrl: st.deployUrl, pageUrl: st.workId ? `${o.baseUrl}/w/${st.workId}/` : null, ms: Date.now() - t0, done, ...extra };
    // 失敗を API に書く（claim したときだけ。書けなくても結果は返す）
    if (!ok && st.claimed && o.api) {
      try { await deps.http('POST', `${o.api}/api/admin/works/${st.draftId}/result`, { status: 'failed', log: `止まった段：${step}\n${res.log || ''}` }); } catch (e) { deps.log(`結果を書けない：${String(e)}`); }
    }
    return res;
  };

  for (const step of steps) {
    try {
      deps.log(`── ${step}`);
      if (step === 'preflight') {
        // 作業中の変更を巻き込まないよう、きれいな作業ツリーでだけ動く
        const status = (await run('git', ['status', '--porcelain'])).trim();
        if (status) throw new Error(`作業ツリーに変更があります。コミットするか片付けてから動かしてください：\n${status}`);
        const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        if (!o.dryRun && branch !== 'main' && (o.push || o.deploy)) throw new Error(`push と配置は main からだけ（いまは ${branch}）。試しなら --no-push --no-deploy`);
        if (!o.dryRun && branch !== 'main' && !o.allowBranch) throw new Error(`main 以外（${branch}）へのコミットは --allow-branch を付けたときだけ`);
        if (o.deploy && !o.dryRun && !process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID がありません（配置に要る）');
      } else if (step === 'fetch') {
        if (o.api) {
          const r = await deps.http('GET', `${o.api}/api/admin/works/${id}/export`);
          if (r.status === 204) return { ok: true, step: null, none: true, draftId: null, workId: null, ms: Date.now() - t0, done };
          if (r.status !== 200) throw new Error(`下書きを受け取れない（${r.status} ${r.json?.error || ''}）`);
          st.draftId = r.json.id;
          Object.assign(st, workFromSource(r.json));
          st.photo = Uint8Array.from(Buffer.from(r.json.photo.base64, 'base64'));
        } else {
          Object.assign(st, workFromSource(JSON.parse(deps.fs.read(/** @type {string} */ (o.json), 'utf8'))));
          st.photo = deps.fs.read(/** @type {string} */ (o.photo));
        }
        if (!st.workId || !WORK_ID_RE.test(st.workId)) throw new Error(`作品の id が正しくない：${st.workId}`);
        if (st.work.id !== st.workId) throw new Error('work.json の id と下書きの作品の id が違う');
        if (!Array.isArray(st.work.messages) || st.work.messages.length < 3 || !st.work.title?.ja || !Array.isArray(st.work.size_cm)) throw new Error('項目がそろっていない（題名、寸法、想いの文）');
        if (deps.fs.exists(dir())) throw new Error(`works/${st.workId}/ はもうあります（同じ作品を二度公開しない）`);
        st.title = st.work.title.ja;
        deps.log(`下書き ${st.draftId ?? '(手元の JSON)'} → works/${st.workId}/（${st.title}）`);
      } else if (step === 'claim') {
        const r = await deps.http('POST', `${o.api}/api/admin/works/${st.draftId}/result`, { status: 'building' });
        if (r.status !== 200) throw new Error(`公開を始められない（${r.status} ${r.json?.error || ''}。ほかの公開が動いているかもしれません）`);
        st.claimed = true;
      } else if (step === 'write') {
        deps.fs.mkdir(dir());
        deps.fs.write(join(dir(), 'work.json'), `${JSON.stringify(st.work, null, 2)}\n`);
        deps.fs.write(join(dir(), 'painting.jpg'), await deps.toJpeg(st.photo));
      } else if (step === 'ci') {
        await run('npm', ['ci']);
      } else if (step === 'generate') {
        await run('npm', ['run', 'generate', '--', /** @type {string} */ (st.workId)], { BASE_URL: o.baseUrl });
      } else if (step === 'test') {
        await run('npm', ['test']);
      } else if (step === 'build') {
        await run('npm', ['run', 'build']);
      } else if (step === 'check') {
        // 作品ページと部屋の帯が開くかの軽い確認（ビルドの中身を見る）
        const page = join(deps.root, 'dist', 'w', /** @type {string} */ (st.workId), 'index.html');
        if (!deps.fs.exists(page)) throw new Error(`作品ページが無い：dist/w/${st.workId}/index.html`);
        const html = String(deps.fs.read(page, 'utf8'));
        if (!html.includes(st.title)) throw new Error('作品ページに題名が無い');
        const gen = join(deps.root, 'dist', 'works', /** @type {string} */ (st.workId), 'generated');
        const space = JSON.parse(String(deps.fs.read(join(gen, 'space.json'), 'utf8')));
        if (!deps.fs.exists(join(gen, space.painting))) throw new Error('絵の画像が無い');
        if (!Array.isArray(space.rooms) || !space.rooms.length) throw new Error('部屋の合成が 1 枚も無い');
        const missing = space.rooms.filter((/** @type {any} */ r) => !deps.fs.exists(join(gen, r.image)));
        if (missing.length) throw new Error(`部屋の画像が無い：${missing.map((/** @type {any} */ r) => r.image).join('、')}`);
        if (!deps.fs.exists(join(gen, 'qr.svg'))) throw new Error('QR が無い');
        deps.log(`作品ページ、絵、部屋 ${space.rooms.length} 枚、QR を確かめた`);
      } else if (step === 'cleanup') {
        // dry-run のあと：作った works/<id>/ と、生成で増えた・変わったファイルを元に戻す（始める前は作業ツリーがきれいだったので、戻すのは生成の出力だけ）
        deps.fs.rm(dir());
        deps.fs.rm(join(deps.root, 'w', /** @type {string} */ (st.workId)));   // 生成した作品ページ（git では無視しているファイル）
        const changed = (await run('git', ['status', '--porcelain'])).split('\n').filter(Boolean);
        const tracked = changed.filter((l) => !l.startsWith('??')).map((l) => l.slice(3));
        const added = changed.filter((l) => l.startsWith('??')).map((l) => l.slice(3));
        for (const f of added) deps.fs.rm(join(deps.root, f));
        if (tracked.length) await run('git', ['checkout', '--', ...tracked]);
        deps.log(`片付けた：works/${st.workId}/、w/${st.workId}/、増えたファイル ${added.length}、戻したファイル ${tracked.length}。受付・ギャラリー・展示用の HTML と dist は、次の generate と build で作り直す`);
      } else if (step === 'commit') {
        const path = `works/${st.workId}`;
        await run('git', ['add', '--', path]);
        await run('git', ['commit', '-m', `作品を公開：${st.title}（${path}/。管理画面の下書き ${st.draftId ?? '手元の JSON'} から publish-draft で）`, '--', path]);
        st.commit = (await run('git', ['rev-parse', 'HEAD'])).trim();
      } else if (step === 'push') {
        await run('git', ['push', 'origin', 'main']);
      } else if (step === 'deploy') {
        const o2 = await run('npx', ['wrangler', 'pages', 'deploy']);
        st.deployUrl = /https:\/\/[a-z0-9.-]+\.pages\.dev\S*/.exec(o2)?.[0] ?? null;
      } else if (step === 'result') {
        const r = await deps.http('POST', `${o.api}/api/admin/works/${st.draftId}/result`, { status: 'published', commit: st.commit, deploy_url: st.deployUrl, page_url: `${o.baseUrl}/w/${st.workId}/`, log: tail(out) });
        if (r.status !== 200) deps.log(`結果を書けない（${r.status}）。公開はできている`);
      }
      done.push(step);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.log(`止まった：${step}：${msg}`);
      return finish(false, step, { log: tail(`${out}\n${msg}`) });
    }
  }
  // コミットしたのは works/<id>/ だけ。生成で変わったほかのファイル（カタログなど）は残るので知らせる
  let dirty = [];
  if (!o.dryRun || !o.cleanup) {
    try { dirty = (await deps.exec('git', ['status', '--porcelain'], {})).out.split('\n').filter(Boolean); } catch { /* 知らせるだけ */ }
  }
  return finish(true, null, { log: tail(out), dirty });
}
