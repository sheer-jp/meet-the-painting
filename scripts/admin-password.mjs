#!/usr/bin/env node
// 管理ページのパスワードのハッシュを作る（docs/ADMIN.md 6 節）。パスワードは作家が自分で決め、ここに打つだけで、どこにも残らない
//   node scripts/admin-password.mjs | npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name enter-the-painting
// 標準出力に出すのはハッシュの 1 行だけ。案内は標準エラーに出す（パイプに混ざらない）。打った文字は画面に出さない
import { hashPassword, MIN_PASSWORD, PBKDF2_ITERATIONS } from '../functions/_lib/admin-auth.js';

// --iterations <回数>：本番のログインが CPU の上限に掛かるときだけ下げる（10,000〜100,000）
const iterArg = process.argv.indexOf('--iterations');
const iterations = iterArg > 0 ? Number(process.argv[iterArg + 1]) : PBKDF2_ITERATIONS;
const say = (s) => process.stderr.write(s);
if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > PBKDF2_ITERATIONS) {
  say('--iterations は 10000 から 100000 の整数にしてください。\n');
  process.exit(1);
}
const stdin = process.stdin;

if (!stdin.isTTY) {
  say('端末から直接実行してください（パスワードをパイプやファイルから受け取りません）。\n');
  process.exit(1);
}

// 1 行読む。エコーを切る（raw モード）。Enter で終わり、Backspace で 1 文字消す、Ctrl-C と Ctrl-D でやめる
function readHidden(prompt) {
  return new Promise((resolve) => {
    say(prompt);
    let chars = [];
    const done = (value) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      say('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003' || ch === '\u0004') { say('\nやめました。\n'); stdin.setRawMode(false); process.exit(130); }
        if (ch === '\r' || ch === '\n') { done(chars.join('')); return; }
        if (ch === '\u007f' || ch === '\b') { chars.pop(); continue; }
        if (ch < ' ') continue;   // 矢印キーなどの制御文字は入れない
        chars.push(ch);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

for (let tries = 0; tries < 3; tries++) {
  const first = await readHidden(`パスワードを入力してください（${MIN_PASSWORD} 文字以上。画面には出ません）：`);
  if ([...first].length < MIN_PASSWORD) { say(`${MIN_PASSWORD} 文字以上にしてください。\n`); continue; }
  const second = await readHidden('確認のため、もう一度入力してください：');
  if (first !== second) { say('2 回の入力が違います。\n'); continue; }
  process.stdout.write(`${await hashPassword(first, { iterations })}\n`);
  say('ハッシュを作りました。\n');
  process.exit(0);
}
say('3 回とも使えなかったので、やめました。\n');
process.exit(1);
