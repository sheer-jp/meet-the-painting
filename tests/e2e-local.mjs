// 管理の e2e を、毎回まっさらなローカルの D1・R2 で流す（docs/ADMIN.md 7 節）。回すたびに前の回の行が残って結果が揺れないように
// 使い方（npm run generate と npm run build のあと。.dev.vars が無ければ作る）：
//   NODE_PATH=<playwright の場所> node tests/e2e-local.mjs [--port 8788] [--shots <dir>] [tests/admin-e2e.mjs tests/register-e2e.mjs ...]
// 1. .wrangler/e2e-state を消す → 2. migrations をすべて流す → 3. wrangler pages dev を起こす → 4. e2e を順に → 5. 止める
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args.splice(args.indexOf(name), 2)[1] : def);
const PORT = Number(opt('--port', '8788'));
const shots = opt('--shots', null);
const files = args.length ? args : ['tests/admin-e2e.mjs', 'tests/register-e2e.mjs'];
const STATE = '.wrangler/e2e-state';
const BASE = `http://localhost:${PORT}`;

if (!existsSync('dist/index.html')) { console.error('dist が無い。npm run generate と npm run build を先に'); process.exit(2); }
if (!existsSync('.dev.vars')) {
  const r = spawnSync('node', ['tests/make-dev-vars.mjs'], { encoding: 'utf8' });
  writeFileSync('.dev.vars', r.stdout);
}
rmSync(STATE, { recursive: true, force: true });
const mig = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'meet-the-painting', '--local', '--config', 'tests/wrangler.local.toml', '--persist-to', STATE], { encoding: 'utf8', input: 'y\n' });
if (mig.status !== 0) { console.error(mig.stdout, mig.stderr); process.exit(1); }
console.log('まっさらな D1 に migrations を流した');

const server = spawn('npx', ['wrangler', 'pages', 'dev', 'dist', '--d1', 'DB=local-meet-the-painting', '--r2', 'WORK_UPLOADS=local-work-uploads', '--persist-to', STATE, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let log = '';
server.stdout.on('data', (b) => { log += b; });
server.stderr.on('data', (b) => { log += b; });
const stop = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* もう止まっている */ } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

const t0 = Date.now();
for (;;) {
  try { if ((await fetch(`${BASE}/api/admin/config`)).ok) break; } catch { /* まだ */ }
  if (Date.now() - t0 > 60_000) { console.error('pages dev が起きない\n', log.slice(-2000)); stop(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}

let failed = 0;
for (const f of files) {
  console.log(`\n── ${f}`);
  const r = spawnSync('node', [f, ...(shots ? ['--shots', shots] : [])], { stdio: 'inherit', env: { ...process.env, BASE } });
  if (r.status !== 0) failed++;
}
stop();
console.log(failed ? `\n${failed} 本が NG` : '\nどれも通った');
process.exit(failed ? 1 : 0);
