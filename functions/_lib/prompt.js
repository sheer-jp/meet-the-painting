// 気分から絵をすすめる：Claude API に渡す system と本文を組み立てる（docs/RECOMMEND.md 8.5）
// 純関数だけ。Pages Functions のグローバルに触れない（vitest から import してテストする）

export const LANG_NAMES = {
  ja: '日本語', en: '英語（English）', 'zh-Hans': '簡体字中国語（简体中文）', 'zh-Hant': '繁体字中国語（繁體中文）', ko: '韓国語（한국어）',
  fr: 'フランス語（Français）', de: 'ドイツ語（Deutsch）', es: 'スペイン語（Español）', it: 'イタリア語（Italiano）', pt: 'ポルトガル語（Português）',
};

// 思考（effort low でも消せない）が max_tokens に数えられるので、文 2〜3 文 + ツール呼び出しのために余裕を持たせる（レビューで 600 → 1500）
export const MAX_TOKENS = 1500;
// おすすめを受け取るツールの名前（buildTool）
export const TOOL_NAME = 'recommend_work';
// 安全分類で拒否されたとき、サーバー側で推奨のモデルに引き継ぐ（fallbacks: "default"）。対応するモデルだけに付ける
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];
export const supportsFallbacks = (/** @type {string} */ model) => FALLBACK_MODELS.includes(model);

/** @param {any} obj @param {string} lang */
const pick = (obj, lang) => (obj && (obj[lang] || obj.en || obj.ja)) || '';
/** @param {any} catalog */
const turnsOf = (catalog) => (Array.isArray(catalog?.turns) && catalog.turns.length === 2 ? catalog.turns : [2, 4]);

/** @param {any} a @param {any} b */
const differs = (a, b) => !!a && JSON.stringify(a) !== JSON.stringify(b);

const AVAIL = { available: '販売中', sold: '売約済み', reserved: '商談中', not_for_sale: '非売品' };

// カタログを system 用の文にする（言語によらず同じ文。キャッシュが言語をまたいで効くように）
/** @param {any} catalog */
export function catalogText(catalog) {
  const works = catalog?.works || [];
  const lines = [`# 作品カタログ（${works.length} 点）`];
  for (const w of works) {
    const size = Array.isArray(w.size_cm) ? `${w.size_cm[0]} × ${w.size_cm[1]} cm` : '不明';
    const label = typeof w.size_label === 'string' ? w.size_label : w.size_label?.ja || '';
    const ax = w.axes || {};
    lines.push(
      '',
      `## id: ${w.id}`,
      `- 題名：${w.title?.ja || w.id}${differs(w.title?.en, w.title?.ja) ? ` / ${w.title.en}` : ''}`,
      `- 寸法：${size}${label ? `（${label}）` : ''}${w.year ? `、${w.year} 年` : ''}`,
      `- 販売：${(w.availability && AVAIL[w.availability]) || w.availability || '不明'}`,
      `- 軸（0〜1）：あたたかさ ${ax.warmth ?? '?'}、明るさ ${ax.brightness ?? '?'}、にぎやかさ ${ax.energy ?? '?'}`,
      `- 気分の言葉：${(w.moods?.ja || []).join('、') || '（なし）'}${differs(w.moods?.en, w.moods?.ja) ? ` / ${w.moods.en.join(', ')}` : ''}`,
    );
    if (w.fit?.ja) lines.push(`- 向く人・時間：${w.fit.ja}${w.fit.en && w.fit.en !== w.fit.ja ? ` / ${w.fit.en}` : ''}`);
    if (w.voice?.ja) lines.push(`- 作家の語り：${w.voice.ja}`);
    if (w.scene?.ja) lines.push(`- この絵のある暮らし：${w.scene.ja}`);
    if (Array.isArray(w.fits?.ja) && w.fits.ja.length) lines.push(`- こんな人・こんなときに：${w.fits.ja.join('。')}。`);
    lines.push(`- 作家のメッセージ（ja）：${(w.messages?.ja || []).join(' ')}`);
    if (differs(w.messages?.en, w.messages?.ja)) lines.push(`- 作家のメッセージ（en）：${w.messages.en.join(' ')}`);
    if (w.story?.en) lines.push(`- 小さな物語（en、作家が確認したもの）：${w.story.en.replace(/\n+/g, ' ')}`);
  }
  return lines.join('\n');
}

/**
 * 会話ごとに違う問いを 4 つ選ぶ（11-07 作家「毎回こっちから投げる質問が変わると面白い」）。seed は会話の間は同じ。kind が偏らないよう、種類ごとに 1 つずつ
 * 選んだ問いは seed で変わるので、system ではキャッシュの区切り（カタログ）より後ろの rules に置く（REVIEW-1 P1-1）
 * @param {any} catalog
 * @param {string} [seed]
 * @param {number} [n]
 * @returns {string[]}
 */
export function pickQuestions(catalog, seed, n = 4) {
  const qs = Array.isArray(catalog?.questions) ? catalog.questions.filter((/** @type {any} */ q) => q && typeof q.ja === 'string') : [];
  if (!qs.length) return [];
  let s = 2166136261;
  for (const ch of String(seed ?? '')) { s ^= ch.charCodeAt(0); s = Math.imul(s, 16777619) >>> 0; }
  const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const byKind = new Map();
  for (const q of qs) { const k = q.kind || ''; if (!byKind.has(k)) byKind.set(k, []); byKind.get(k).push(q); }
  const kinds = [...byKind.keys()].sort(() => rand() - 0.5);
  const out = [];
  for (let i = 0; out.length < Math.min(n, qs.length) && i < kinds.length * 3; i++) {
    const list = byKind.get(kinds[i % kinds.length]);
    const q = list[Math.floor(rand() * list.length)];
    if (!out.includes(q.ja)) out.push(q.ja);
  }
  return out;
}

/**
 * system の配列（docs/RECOMMEND.md 8.5 の 1〜5）。並びは「固定の head → カタログ（cache_control）→ rules」
 * head とカタログはどの訪問者・言語・往復でも同じ（キャッシュの前置部を全員で共有する）。
 * 言語・往復数・会話ごとの問いの候補（seed）は変わるので、キャッシュの区切りより後ろの rules に置く
 * @param {any} catalog
 * @param {string} lang
 * @param {number} [userTurns] いまの user の件数（buildBody が数える）
 * @param {string} [seed] 会話ごとの問いの種
 * @returns {Array<{ type: 'text', text: string, cache_control?: { type: 'ephemeral' } }>}
 */
export function buildSystem(catalog, lang, userTurns, seed) {
  const [minT, maxT] = turnsOf(catalog);
  const ids = (catalog?.works || []).map((/** @type {any} */ w) => w.id);
  const intro = catalog?.artist?.intro?.ja || '';
  // 進め方の問いと選び方の決まりは 11-07 の会話の評価（docs/RECOMMEND.md 9）から。「落ち込んでいる」の例は 11-07 のカタログ（背中を押す絵＝頂、道を決める絵＝Golden Path）に合わせた言い方なので、作品が変わったら見直す
  const head = `あなたは、抽象画の作家のオンラインギャラリーの入口で、訪れた人の気分を聞き、作家の作品から 1 点をすすめる案内役です。

# 作家の紹介
${intro}

# 話し方
- 口調はカジュアル（11-06 作家の指示）。友だちに話すように、やわらかく、ていねいすぎない。「〜です・〜ます」で固めず、「〜だね」「〜かな」「〜してみて」のように話す。ただし軽すぎず、相手を急かさない。名乗らない（名前は出さない）。
- **寄り添う**（11-07 作家）：まず相手の言葉を受け止めて共感し（「それは疲れるよね」「いい朝になりそう」）、そのあとで聞く・提案する。評価したり、正したりしない。相手の気持ちの側に立つ。
- 短く話す。1 回の応答は 2〜3 文まで。**文ごとに改行する**（「。」「？」「！」のあとは必ず改行。1 行に 2 文を並べない）。
- 聞くことは 1 回に 1 つだけ。問いの文（「？」で終わる文）は 1 つの応答に 1 つまで。二択はよいが、問いを 2 つ重ねない。
- 説明や売り込みはしない。絵の技法や価値を語らず、その人の暮らしの情景で話す（朝の光、帰り道、部屋の空気など）。
- 名前・連絡先・住所・年齢などの個人情報は聞かない。相手が書いても、覚えたり使ったりしない。
- 金額は言わない（間違えないため）。価格や買い方を聞かれたら「作品のページに価格と購入の案内があるよ」と伝える。買うことを急かさない。
- カタログに無い作品や、作家について書かれていないことは作らない。

# 進め方
- 往復 ${minT} 回以上、${maxT} 回以下で、必ずおすすめに至る。
- いまが何往復目かは、user の発言の数で数える。${maxT} 往復目の応答では、必ずおすすめを出す。
- 最初は、相手の最初の言葉を受け止めてから、問いを 1 つだけ聞く（いつも同じ「朝？夜？」「どこに置く？」から入らない）。後ろの「今回の問いの候補」があれば、そこから流れに合うものを選ぶ。
- 問いは、相手がいま話したことから自然につながるものにする（話をいきなり天気や季節に飛ばさない）。「朝と夜、どっち？」のような時間帯の二択は、候補に無ければ使わない（どの会話でも同じ問いになりやすいので）。
- 相手の答えが短い・話がそれたときは、それも受け止めて（「散歩、いいね」）、そこから次の問いへつなぐ。急いで決めず、${maxT} 往復目まで聞いてよい。
- 作品を選ぶときは、最初に思いついた 1 点で決めず、${ids.length} 点すべての「作家の語り」「こんな人・こんなときに」と、その人の言葉を照らし合わせる。たとえば「落ち込んでいる」でも、その人が「明日また頑張る」「次どうするか」と言っていれば、そっと寄り添う絵だけでなく、背中を押す絵や道を決める絵も比べる。`;

  const qs = pickQuestions(catalog, seed);
  // 会話ごとに変わる問いの候補（seed）。キャッシュの区切りより後ろ（REVIEW-1 P1-1）
  const questionsText = qs.length ? `# 今回の問いの候補
- 問いは毎回違うものに。流れに合うものを 1 往復に 1 つ。言い換えてよい。相手の最初の言葉に直接つながる問いがあればそちらを優先：
${qs.map((q) => `  - ${q}`).join('\n')}

` : '';

  const rules = `${questionsText}# 出力の決まり
- おすすめを出すときは、**先に文を 2〜3 文書き**、そのあとに必ずツール ${TOOL_NAME} を 1 回呼ぶ。文を書かずにツールだけを呼ばない（画面では文が先に出て、そのあと絵のカードが出る）。文の中に JSON や id を書かない。
- recommend と alt はカタログの id（${ids.join(', ') || 'なし'}）から選ぶ。作品が 2 点以上あるときは alt に 2 番目の候補、1 点だけのときは alt を null にして、文で正直に「いまはこの 1 点です」と伝える。
- 文はその人に向けた言葉で書く。順番は、まず**その人が話したこと**を 1 つ拾って自分の言葉で返し（「朝の机に向かう前、って言ってたよね」）、そのあとに**この絵の何がそれに応えるか**を「作家の語り」か「この絵のある暮らし」から 1 つだけ、話し言葉で。ことばを並べない。「〜だから。」で終わる説明の型にしない。
- ツールの reason（ja / en）は、その 2 つを 1〜2 文にしたもの。カジュアルな話し言葉で、相手に向けて。「気分の言葉」をそのまま貼り付けなくてよい（自然に混ざるなら使う）。reason.ja は日本語だけ、reason.en は英語だけで書く（相手の言語の語を混ぜない。会話が日本語・英語以外でも訳して書く）。
- ツールの matched_moods には、選んだ作品の「気分の言葉」から、この人に合う 1〜3 語をカタログの語のまま入れる。
- おすすめを出さないときは、文だけを書く（ツールを呼ばない）。

# 応答の言語
- 応答の文は${LANG_NAMES[/** @type {keyof typeof LANG_NAMES} */ (lang)] || LANG_NAMES.en}で書く（カタログが日本語でも、訳して話す）。${
    typeof userTurns === 'number' ? `\n\n# いまの往復\n- いまは ${userTurns} 往復目（最大 ${maxT}）。${userTurns >= maxT ? 'この応答で必ずおすすめを出す（文を書いてからツール）。' : userTurns >= minT ? 'おすすめを出してよい（出すなら文を書いてからツール）。まだその人の気持ちがつかめていなければ、もう 1 つだけ聞いてもよい。' : 'まだおすすめは出さず、まず受け止めて、1 つだけ聞く。'}` : ''
  }`;

  return [
    { type: 'text', text: head },
    { type: 'text', text: catalogText(catalog), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: rules },
  ];
}

/**
 * おすすめを受け取るツール（strict: true で入力の型を保証する。docs/ENTRANCE.md 5.1）
 * カタログに作品が無いときは enum が空になり不正なスキーマになるので null を返す（ツールを付けない）
 * @param {any} catalog
 */
export function buildTool(catalog) {
  const ids = (catalog?.works || []).map((/** @type {any} */ w) => String(w.id));
  if (!ids.length) return null;
  return {
    name: TOOL_NAME,
    description: '訪れた人に作品を 1 点すすめる。おすすめの文を書いたあとに 1 回だけ呼ぶ。recommend は最もすすめたい作品の id、alt は 2 番目の候補の id（作品が 1 点だけなら null）、reason はすすめる理由を日本語と英語で 1 文ずつ、matched_moods は選んだ作品のカタログの moods の語をそのまま 1〜3 語。',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        recommend: { type: 'string', enum: ids, description: '最もすすめたい作品の id' },
        alt: { anyOf: [{ type: 'string', enum: ids }, { type: 'null' }], description: '2 番目の候補の id。無ければ null' },
        reason: {
          type: 'object',
          properties: {
            ja: { type: 'string', description: 'すすめる理由（日本語で 1 文）' },
            en: { type: 'string', description: 'すすめる理由（英語で 1 文）' },
          },
          required: ['ja', 'en'],
          additionalProperties: false,
        },
        matched_moods: {
          type: 'array',
          items: { type: 'string' },
          // strict のスキーマは minItems / maxItems を受け付けない（本番で 400）。個数は description と relay の normalizeRecommend で抑える
          description: '選んだ作品の気分の言葉から、この人に合う 1〜3 語（カタログの moods の語をそのまま）。1 語以上 3 語まで',
        },
      },
      required: ['recommend', 'alt', 'reason', 'matched_moods'],
      additionalProperties: false,
    },
  };
}

/**
 * 会話を Messages API の形にそろえる（role と content だけ。content は文字列）
 * @param {any} messages
 * @returns {Array<{ role: 'user' | 'assistant', content: string }>}
 */
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content ?? '') }));
}

/**
 * Messages API の本文（stream: true）
 * @param {any} catalog
 * @param {string} lang
 * @param {any} messages
 * @param {string} model
  * @param {string} [seed] 会話ごとの問いの種（空文字は未指定と同じ）
 */
export function buildBody(catalog, lang, messages, model, seed) {
  const msgs = sanitizeMessages(messages);
  const userTurns = msgs.filter((m) => m.role === 'user').length;
  /** @type {Record<string, any>} */
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    stream: true,
    // 短い接客の会話なので考える量は少なく（max_tokens を思考で使い切らないように）
    output_config: { effort: 'low' },
    system: buildSystem(catalog, lang, userTurns, seed),
    messages: msgs,
  };
  const tool = buildTool(catalog);
  if (tool) {
    body.tools = [tool];
    // Sonnet 5.5 / Opus 5.5 は any / tool を受け付けない（400）。auto のまま system で呼ぶよう指示する
    body.tool_choice = { type: 'auto' };
  }
  if (supportsFallbacks(model)) body.fallbacks = 'default';
  return body;
}

// user は 600 文字まで。assistant はブラウザが AI の文をそのまま返すので、長めに（2000）
export const LIMITS = { messages: 10, chars: 600, assistantChars: 2000 };

/**
 * 要求の本文を確かめる（docs/RECOMMEND.md 8.4 の制限）。問題があれば理由の文字列、無ければ null
 * @param {any} body
 * @param {[number, number]} [turns]
 * @returns {string | null}
 */
export function validateRequest(body, turns = [2, 4]) {
  if (!body || typeof body !== 'object') return 'body';
  if (typeof body.lang !== 'string' || !Object.prototype.hasOwnProperty.call(LANG_NAMES, body.lang)) return 'lang';
  if (body.seed != null && body.seed !== '' && !(typeof body.seed === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(body.seed))) return 'seed';   // 会話ごとの問いの選び方の種
  const ms = body.messages;
  if (!Array.isArray(ms) || ms.length === 0 || ms.length > LIMITS.messages) return 'messages';
  for (const m of ms) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'role';
    if (typeof m.content !== 'string' || !m.content.trim() || m.content.length > (m.role === 'assistant' ? LIMITS.assistantChars : LIMITS.chars)) return 'content';
  }
  // 最初と最後は user（最後が assistant だと先読み扱いで API が 400 を返す）
  if (ms[0].role !== 'user' || ms[ms.length - 1].role !== 'user') return 'order';
  if (ms.filter((m) => m.role === 'user').length > turns[1] + 1) return 'turns';
  return null;
}
