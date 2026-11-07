// 生成時だけ Claude API を使う：不足している訳を埋める、小さな物語を下書きする。実行時には呼ばない
import Anthropic from '@anthropic-ai/sdk';

// 既定は Sonnet 5.5（作家の方針：開発中はリーズナブルなモデルから。翻訳 1 作品で数円）。質を上げたければ CLAUDE_MODEL=claude-opus-5-5
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const LANG_NAMES = { ja: '日本語', en: 'English', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', it: 'Italiano', pt: 'Português' };

function client(apiKey) { return new Anthropic({ apiKey }); }

// JSON だけを返すよう頼み、前後の文を落として parse する
function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('JSON が見つからない: ' + text.slice(0, 200));
  return JSON.parse(m[0]);
}

async function ask(apiKey, system, user) {
  const c = client(apiKey);
  // 安全分類による拒否のときはサーバー側で別モデルに引き継ぐ（既定の fallbacks）
  const res = await c.beta.messages.create({
    model: MODEL, max_tokens: 16000, system,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new Error('翻訳が拒否された: ' + (res.stop_details?.explanation || ''));
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// missing: [{ k, lang, ja, en? }] → [{ k, lang, text }]
export async function translateWithClaude(missing, apiKey) {
  // 原文ごとにまとめて、必要な言語を一度に訳す
  const byKey = new Map();
  for (const m of missing) { if (!byKey.has(m.k)) byKey.set(m.k, { ja: m.ja, en: m.en, langs: [] }); byKey.get(m.k).langs.push(m.lang); }
  const out = [];
  const system = `あなたは抽象画の作家の言葉を訳す翻訳者です。作家が日本語で書いた短い文（絵の中に浮かぶメッセージ、または小さな物語）を、指定の言語に訳します。
- 説明文ではなく、作家の語りとして。直訳ではなく、その言語で自然に心に入る文に。詩的な余白を保つ。
- 文の長さは原文と同じ程度。固有名詞（作品名）はそのまま。
- 英語の参考訳があれば、意味の解釈はそれに合わせる。
- 出力は JSON オブジェクトだけ。キーは言語コード、値は訳文。他の文は書かない。`;
  for (const [k, e] of byKey) {
    const langs = e.langs.filter((l) => l !== 'ja');
    if (!langs.length) continue;
    const user = `原文（日本語）：\n${e.ja}\n${e.en ? `\n英語の参考訳（作家が確認済み）：\n${e.en}\n` : ''}\n訳す言語：${langs.map((l) => `${l}（${LANG_NAMES[l]}）`).join('、')}\n\nJSON で返してください。例：{"en":"...","fr":"..."}`;
    const json = parseJson(await ask(apiKey, system, user));
    for (const l of langs) if (typeof json[l] === 'string' && json[l].trim()) out.push({ k, lang: l, text: json[l].trim() });
    console.log(`  翻訳：${e.ja.slice(0, 18)}… → ${langs.join(', ')}`);
  }
  return out;
}

// 小さな物語の下書き（1 作品 1 本、日本語、3〜5 文）。作家が直す前提。下書きの印が残っている間は公開されない（story.js）
export async function draftStory({ title, messages, note }, apiKey) {
  const system = `あなたは抽象画の作家の代わりに「小さな物語」の下書きを書きます。その絵が誰かの日々の中にあるとき、暮らしにどんな彩りをもたらすかを、小説のような語りで 3〜5 文、日本語で書きます。
- 説明や宣伝ではなく、情景。朝・夜・帰宅・季節など、生活の一瞬を 1 つ選ぶ。
- 作家のメッセージの言葉やイメージを引き継ぐ。絵の色や動きは具体的に。
- 実在の人物・場所・出来事と誤認される固有名詞は使わない。
- 1 文 40 文字以内。文ごとに改行。
- 出力は JSON オブジェクトだけ：{"ja":"文1\\n文2\\n文3"}`;
  const user = `作品：${title}\n作家のメッセージ：\n${messages.join('\n')}\n${note ? `\n作家のメモ：\n${note}\n` : ''}`;
  const json = parseJson(await ask(apiKey, system, user));
  if (typeof json.ja !== 'string') throw new Error('物語の下書きが返らない');
  return json.ja.trim() + '\n（下書き。作家が自分の言葉に直す）';
}

// 気分の言葉の下書き（1 作品 3〜5 語、日本語）。「気分から絵をすすめる」のカタログに載る。作家が work.json の moods に移して直す
export async function draftMoods({ title, messages, palette }, apiKey) {
  const system = `あなたは抽象画の作家の代わりに、作品に添える「気分の言葉」の下書きを書きます。その絵をどんな気分のときに見たくなるか、どんな時間に合うかを、短い言葉で 3〜5 個、日本語で書きます。
- 1 つは 12 文字以内の名詞句か短い句。説明や宣伝ではなく、情景や心の動き（例：「朝の光」「ぶつかって、ほどける」「にぎやかな静けさ」）。
- 作家のメッセージの言葉やイメージ、絵の色を手がかりにする。
- 実在の人物・場所・出来事と誤認される固有名詞は使わない。
- 出力は JSON オブジェクトだけ：{"ja":["言葉1","言葉2","言葉3"]}`;
  const user = `作品：${title}\n主要色：${palette.join(' ')}\n作家のメッセージ：\n${messages.join('\n')}\n`;
  const json = parseJson(await ask(apiKey, system, user));
  const ja = Array.isArray(json.ja) ? json.ja.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 5) : [];
  if (ja.length < 3) throw new Error('気分の言葉の下書きが 3 つに満たない');
  return { ja };
}
