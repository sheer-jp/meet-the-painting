// 公開の手順（docs/REGISTER.md 5.3）：管理画面の下書きから works/<id>/ を書き、generate → test → build → 確かめ → コミット → push → 配置
//   npm run publish-draft -- <下書きの id> [--dry-run [--cleanup]] [--no-push] [--no-deploy] [--allow-branch] [--ci] [--skip-tests]
//   npm run publish-drafts [-- --dry-run]          queued の下書きを古い順に 1 件ずつ（失敗したらそこで止める）
//   手元の JSON と写真から：npm run publish-draft -- x --json <draft.json> --photo <painting.jpg> [...]
// API から読むときは環境変数 PUBLISH_TOKEN（公開専用のトークン。export と result だけに効く）。宛先は --api（既定 https://meet.sheerarts.com）
// 結果は result.json（--result で場所を決める。既定は一時フォルダ）。止まったらコミットも配置もしない
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { parseArgs, runPublish, planSteps } from './publish-lib.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

/** @param {string} cmd @param {string[]} args @param {{ env?: Record<string, string> }} [o] */
function exec(cmd, args, o = {}) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...(o.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    // 子の出力は「  │ 」を付けて流す（行の途中で切れても、次の行の頭に付ける）
    let atStart = true;
    const take = (/** @type {Buffer} */ b) => {
      const s = b.toString();
      out += s;
      process.stdout.write(s.replace(/(^|\n)(?=[^\n])/g, (m, nl, i) => (i === 0 && !atStart ? m : `${nl}  │ `)));
      atStart = s.endsWith('\n');
    };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('close', (code) => { if (!atStart) process.stdout.write('\n'); res({ code: code ?? 1, out }); });
    p.on('error', (e) => res({ code: 1, out: `${out}\n${String(e)}` }));
  });
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exit(2); }
  const token = process.env.PUBLISH_TOKEN || '';
  if (o.api && !token) { console.error('PUBLISH_TOKEN がありません（公開専用のトークン）'); process.exit(2); }
  /** @param {string} method @param {string} url @param {any} [body] */
  const http = async (method, url, body) => {
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 本文なし */ }
    return { status: r.status, json };
  };
  const deps = {
    root: ROOT, exec, http, log: (/** @type {string} */ l) => console.log(l),
    fs: {
      exists: existsSync, mkdir: (/** @type {string} */ p) => mkdirSync(p, { recursive: true }),
      write: (/** @type {string} */ p, /** @type {any} */ d) => writeFileSync(p, d), read: (/** @type {string} */ p, /** @type {any} */ enc) => readFileSync(p, enc),
      rm: (/** @type {string} */ p) => rmSync(p, { recursive: true, force: true }),
    },
    // painting.jpg は JPEG で置く（PNG なら変える。縮めはしない）
    toJpeg: async (/** @type {Uint8Array} */ b) => (b[0] === 0xff && b[1] === 0xd8 ? b : await sharp(b).jpeg({ quality: 95 }).toBuffer()),
  };
  console.log(`段取り：${planSteps(o).join(' → ')}`);
  const results = [];
  for (;;) {
    const r = await runPublish(o, deps, o.queued ? 'next' : o.ids[0]);
    if (r.none) { if (!results.length) console.log('queued の下書きはありません'); break; }
    results.push(r);
    console.log(r.ok ? `できた：${r.workId}（${Math.round(r.ms / 1000)} 秒）` : `止まった：${r.step}`);
    // dry-run は状態を変えないので、次も同じ下書きになる。1 件で止める
    if (!o.queued || !r.ok || o.dryRun) break;
  }
  const file = o.result || join(tmpdir(), 'meet-publish', `result-${Date.now()}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(o.queued ? results : results[0] ?? null, null, 2)}\n`);
  console.log(`結果：${file}`);
  const last = results[results.length - 1];
  if (last?.dirty?.length) console.log(`コミットしていない生成物の変更（作品の追加で変わったカタログなど）：\n${last.dirty.join('\n')}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
