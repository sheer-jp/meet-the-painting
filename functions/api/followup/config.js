// 感想カードを出してよいか（できないことをボタンにしない）。保存先の表が無ければ出さない。ai：Claude に聞けるか
import { dbReady } from '../../_lib/events.js';

export async function onRequestGet({ env }) {
  const enabled = await dbReady(env);
  return new Response(JSON.stringify({ enabled, ai: enabled && !!env.ANTHROPIC_API_KEY && !env.PASSPHRASE }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
}
