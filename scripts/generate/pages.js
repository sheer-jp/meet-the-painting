import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { LANGS } from './translate.js';
import { doorStyle, doorBody } from './door.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = (obj, lang) => (obj && (obj[lang] || obj.ja || obj.en)) || '';

export const UI_JA = {
  enter: '絵の世界をのぞく', enter_vr: 'VR でのぞく', enter_note: '色が動き出し、作家の言葉が流れます（約 1 分）', rooms: '部屋で見る', contact: '作家に連絡', share: '共有', others: '他の作品', buy: 'この絵を購入する', buy_tax: '税込', buy_note: '一点ものの原画です。東京から配送します。', buy_ship_jp: '国内：送料は着払いです。発送のときにメールでお知らせします。', buy_ship_intl: '海外：送料が確定したら、Stripe の請求をメールでお送りします。関税や輸入税はお客さまのご負担です。', cg_all: 'ギャラリー全体を見る',   // 11-07 作家「他の作品の下に、ギャラリー全体を見るボタン」
  size: '寸法', medium: '技法', available: '販売中', sold: '売約済み', not_for_sale: '非売',
  room_cat_studio: '一人暮らしの部屋', room_cat_house: '広い家',   // 11-07 FIX-A：玄関・靴箱の部屋にも付くので「リビング」を外す（ui.json は別途）
  rooms_note: '部屋は AI 生成のイメージ。絵は実物の写真。寸法は目安', story_note: '小さな物語', language: '言語', tap_for_size: '画像をタップすると、寸法と詳しい説明。絵をドラッグして、好きな場所に置けます',
  gallery_title: 'ギャラリー', privacy: '© SHEER',   // 11-07 P-17：フッターは「© SHEER」だけ（計測の断りは public/stats.html と README）
  statement: '小さな絵の、奥へ。', statement_en: 'Into the depth of a small painting.',
};
// Google Fonts（AUDIT-1 P1-3）：Noto Sans JP は 300 / 400 だけ（500 は CSS で使っていない）。Shippori Mincho の 600 は絵の中の文字（.float-text）。
// 描画を止めないよう preload → onload で stylesheet に（JS が無ければ noscript の link）。落ちてもシステムの明朝・ゴシックで読める
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;600&amp;family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300&amp;family=Noto+Sans+JP:wght@300;400&amp;display=swap';
export const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="style" href="${FONTS_CSS}" onload="this.onload=null;this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="${FONTS_CSS}"></noscript>`;

// 10 言語ぶんの data-lang の span（ja だけ最初から見せる。page.ts の applyLang が端末の言語で出し分け、無い言語は en → ja に落ちる）
const multi = (m) => m ? LANGS.filter((l) => m[l]).map((l) => `<span lang="${l}" data-lang="${l}"${l === 'ja' ? '' : ' hidden'}>${esc(m[l])}</span>`).join('') : '';
// size_label・medium は文字列のこともある（古い形）。そのときは ja として出す
const asMulti = (v) => typeof v === 'string' ? { ja: v } : v;

// 二言語併記（美術館の作法）：言語設定に関わらず日本語と英語を並べる
const brand = (prefix) => `<a class="brand" href="${prefix}"><b>SHEER Gallery</b></a>`;   // 11-06 深夜：受付と同じギャラリー名に統一
// フッター（P-17）：「© SHEER」と「記録について」（何を残しているかの説明。docs/ADMIN.md 1 節）
const footer = (prefix) => `<footer><span data-i18n="privacy">${UI_JA.privacy}</span><a class="foot-data" href="${prefix}data-note.html" data-i18n="fu_data">記録について</a></footer>`;
const langSel = () => `<label class="lang"><span data-i18n="language">${UI_JA.language}</span> <select id="lang" aria-label="${UI_JA.language}" data-i18n-attr="aria-label:language"></select></label>`;

// ja と en が同じ（または en が無い）なら 1 回だけ。違えば「ja / en」（11-07 作家：「SHEER Gallery / SHEER Gallery」と同じ語を 2 回並べない）
export const jaEnTitle = (ja, en) => (en && en !== ja ? `${ja} / ${en}` : (ja || en || ''));
export const SITE_NAME = 'Meet the Painting';   // 11-08 作家「英語を正式名称に」。日本語の添え書きは「絵と出会う」
export const SITE_TAGLINE = '語りかけるオンラインギャラリー';   // SHEER Gallery は全体の名前として見出しに残す
// ファビコン・マニフェスト（E-16）。prefix は受付 ''、ギャラリー '../'、作品 '../../'（base: './' の相対で、置き場のパスに依存しない）
const headIcons = (prefix) => `<link rel="icon" href="${prefix}favicon.svg" type="image/svg+xml">
<link rel="icon" href="${prefix}favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="${prefix}apple-touch-icon.png">
<link rel="manifest" href="${prefix}site.webmanifest">
<meta name="theme-color" content="#ffffff">`;
// SNS カード（OGP 1200×630。画像は scripts/generate/og.js が合成）。URL は BASE_URL の絶対
const headOg = ({ type = 'website', title, description, image, url }) => `<meta property="og:type" content="${type}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${image}">`;
const RECEPTION_DESC = '話しながら、長く一緒に暮らせる一枚に出会えるオンラインギャラリー。';

// 属性の訳（AUDIT-1 P1-6）：page.ts の applyLang が data-i18n-attr の鍵で差し替える。vars は data-i18n-vars（JSON。多言語の値は閲覧者の言語を取る）
const i18nAttr = (spec, vars) => ` data-i18n-attr="${spec}"${vars ? ` data-i18n-vars="${esc(JSON.stringify(vars))}"` : ''}`;
// 部屋の画像の alt：「<題名>（<場所>）AI 生成の部屋のイメージ」。他の言語は applyLang が room_alt で組み直す（題名は訳さない）
export const roomAlt = (title, label) => `${title}（${label}）AI 生成の部屋のイメージ`;   // 11-07 FIX-B：ui.json の room_alt（ja）と同じ形。「〜てに置いた」の文の組み立てをやめ、場所の札をそのまま括弧に
// 小さく出す絵（「他の作品」の帯、ギャラリー）：480 と 1024 を出し分ける（AUDIT-1 P1-5）。作品ページの主役の絵は 1024 のまま
const smallSrcset = (dir) => `${dir}painting_480.jpg 480w, ${dir}painting_1024.jpg 1024w`;
// ギャラリーの絵の表示幅：スマホ（< 768px）は 1 列でほぼ全幅、PC は展示室の壁に実寸比（いちばん高い絵が画面の高さの 52%。page.css の --hang-h と同じ）
const gwSizes = (wcm, maxH) => `(max-width: 767.98px) calc(100vw - 40px), max(72px, calc(52vh * ${+(wcm / maxH).toFixed(3)}))`;
// 「他の作品」の帯：高さ 132px の正方形に object-fit: cover。横長の絵は 132 × 縦横比 の幅が要る（REVIEW-2 P2）
const otherSizes = (sizeCm) => `${Math.ceil(132 * Math.max(1, (sizeCm?.[0] || 1) / (sizeCm?.[1] || 1)))}px`;

// 作品ページ /w/<id>/index.html。絵は JS を待たずに出る。JS は「入る」のためだけ
export function workPage({ work, space, baseUrl, allWorks }) {
  const id = work.id;
  const title = t(space.title, 'ja');
  const titleEn = t(space.title, 'en');
  const url = `${baseUrl}/w/${id}/`;
  const img = `../../works/${id}/generated/painting_1024.jpg`;
  const blur = `../../works/${id}/generated/${space.painting_blur || 'painting_1024.jpg'}`;
  const ogImg = `${baseUrl}/works/${id}/generated/og.png`;
  const pageTitle = `${jaEnTitle(title, titleEn)} — ${SITE_NAME}`;
  const [w, h] = work.size_cm;
  const avail = work.availability ? `<span class="avail" data-i18n="${esc(work.availability)}">${esc(UI_JA[work.availability] || '')}</span>` : '';
  // 部屋で見る：帯は全景だけ。キャプションは「部屋の種類 ─ 場所」（母語。無ければ en → ja）。比較の一文と寸法は拡大表示（page.ts）
  const caption = multi;
  const rooms = (space.rooms || []).map((r, i) => `
      <figure class="room" data-room-index="${i}">
        <img src="../../works/${id}/generated/${esc(r.image)}" alt="${esc(roomAlt(title, t(r.label, 'ja')))}"${i18nAttr('alt:room_alt', { t: { ja: title, en: titleEn || title }, p: r.label || {} })} loading="lazy">
        <figcaption>${r.category ? `<span data-i18n="room_cat_${esc(r.category)}">${esc(UI_JA['room_cat_' + r.category] || '')}</span> ─ ` : ''}${caption(r.label)}</figcaption>
      </figure>`).join('');
  const story = space.story ? `
    <section class="story">
      <h2 class="eyebrow"><span>Story</span><span data-i18n="story_note">${UI_JA.story_note}</span></h2>
      ${LANGS.map((l) => space.story[l] ? `<p lang="${l}" data-lang="${l}" hidden>${esc(space.story[l])}</p>` : '').join('')}
    </section>` : '';
  const others = allWorks.filter((o) => o.id !== id).map((o) => `
      <a class="other" href="../${o.id}/" data-title-ja="${esc(t(o.title, 'ja'))}" data-title-en="${esc(t(o.title, 'en'))}"><img src="../../works/${o.id}/generated/painting_1024.jpg" srcset="${smallSrcset(`../../works/${o.id}/generated/`)}" sizes="${otherSizes(o.size_cm)}" alt="" loading="lazy"><b class="t-main">${esc(t(o.title, 'ja'))}</b>${o.size_cm[0]} × ${o.size_cm[1]} cm</a>`).join('');
  const contact = work.contact ? `<a class="btn ghost" id="contact" href="${esc(work.contact)}" target="_blank" rel="noopener" data-i18n="contact">${UI_JA.contact}</a>` : '';
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(title)}（${w} × ${h} cm）。作家の思いを聞きながら、この絵の世界に浸れます。">
${headOg({ type: 'article', title: pageTitle, description: `${w} × ${h} cm — 作家の思いを聞きながら、この絵の世界に浸る / Step into the world of this painting`, image: ogImg, url })}
<meta name="work" content="${id}">
${headIcons('../../')}
${FONTS}
<link rel="stylesheet" href="../../src/ui/page.css">
</head>
<body style="--blur-url:url('${blur}')">
<div class="atmosphere" aria-hidden="true"></div>
<main class="work">
  <div class="top">${brand('../../')}<div class="top-tools"><a class="top-gallery" href="../../gallery/" data-i18n="gallery_title">${UI_JA.gallery_title}</a>${langSel()}</div></div>
  <figure class="painting" style="aspect-ratio:${w}/${h}">
    <img src="${img}" alt="${esc(title)}" data-title-ja="${esc(title)}" data-title-en="${esc(titleEn)}" fetchpriority="high">
  </figure>
  <header class="titling">
    <h1 data-title-ja="${esc(title)}" data-title-en="${esc(titleEn)}"><span class="t-main">${esc(title)}</span>${titleEn && titleEn !== title ? `<span class="t-sub latin">${esc(titleEn)}</span>` : '<span class="t-sub" hidden></span>'}</h1>
    ${space.statement ? `<p class="statement">${multi(asMulti(space.statement))}</p>` : ''}
    <p class="meta">${work.year ? `<span>${esc(work.year)}</span>` : ''}<span>${fLabel(space.size_label || work.size_label) ? `${fLabel(space.size_label || work.size_label)} ・ ` : ''}${w} × ${h} cm</span>${(space.medium || work.medium) ? `<span>${multi(asMulti(space.medium || work.medium))}</span>` : ''}${avail}</p>
  </header>
  <div class="actions">
    <button class="btn primary" id="enter" data-i18n="enter"${space.audio?.voice ? ` data-voice="../../works/${id}/${esc(space.audio.voice)}"` : ''}>${UI_JA.enter}</button>
    <button class="btn" id="enter-vr" data-i18n="enter_vr" hidden style="display:none">${UI_JA.enter_vr}</button>
    ${contact}
    <p class="cg-enter-note" data-i18n="enter_note">${UI_JA.enter_note}</p>
    ${work.buy?.url ? `<div class="buy" data-title="${esc(title)}">
      <p class="buy-price">¥${Number(work.buy.price_jpy).toLocaleString('en-US')}<small>（<span data-i18n="buy_tax">${UI_JA.buy_tax}</span>）</small></p>
      <a class="btn" id="buy" href="${esc(work.buy.url)}" target="_blank" rel="noopener" data-i18n="buy">${UI_JA.buy}</a>
      <p class="buy-note" data-i18n="buy_note">${UI_JA.buy_note}</p>
      <p class="buy-note" data-i18n="buy_ship_jp">${UI_JA.buy_ship_jp}</p>
      <p class="buy-note" data-i18n="buy_ship_intl">${UI_JA.buy_ship_intl}</p>
    </div>` : ''}
  </div>
  ${rooms ? `<section class="rooms" id="rooms"><h2 class="eyebrow"><span>Rooms</span><span data-i18n="rooms">${UI_JA.rooms}</span></h2><div class="strip">${rooms}</div><p class="rooms-hint"><span class="rooms-hint-do" data-i18n="tap_for_size">${UI_JA.tap_for_size}</span><span class="rooms-hint-note" data-i18n="rooms_note">${UI_JA.rooms_note}</span></p></section>` : ''}
  ${story}
  ${others ? `<section class="others"><h2 class="eyebrow"><span>Works</span><a class="eyebrow-link" href="../../gallery/" data-i18n="others">${UI_JA.others}</a></h2><div class="strip">${others}</div><p class="others-all"><a class="btn ghost" href="../../gallery/" data-i18n="cg_all">${UI_JA['cg_all'] || 'ギャラリー全体を見る'}</a></p></section>` : ''}
  ${footer('../../')}
</main>
<div id="stage" hidden></div>
<script type="module" src="../../src/page.ts"></script>
</body>
</html>
`;
}

// 受付の設定（recommend/config.json）。読めなければ最小の既定値
const CONFIG_FALLBACK = {
  title: { ja: 'SHEER Gallery', en: 'SHEER Gallery' },
  greeting: { ja: ['ようこそ、SHEER のギャラリーへ。', '彩り美しい抽象画の世界を届けます。', '今日は、どんな絵を探してる？'], en: ['Welcome to SHEER\'s gallery.', 'A world of vivid abstract paintings awaits.', 'What kind of painting are you looking for today?'] },
  openers: { ja: ['頑張る活力がほしい', '寂しい夜によりそってほしい', '明るい気持ちになれる絵を'] },
  persona: { name: { ja: '', en: '' }, intro_line: { ja: '', en: '' } },
  present_line: { ja: 'これ、どうかな。', en: 'How about this one?' },
  ui_hint: { ja: '近いものがあれば、選んでください', en: 'Pick one if it fits' },
  ui_write: { ja: '自分のことばで書く', en: 'Write in my own words' },
};
function readConfig() {
  const fallback = CONFIG_FALLBACK;
  try { return { ...fallback, ...JSON.parse(readFileSync(new URL('../../recommend/config.json', import.meta.url), 'utf8')) }; } catch { return fallback; }
}

// ja と en を data-lang で持つ（en は最初は隠す。page.ts が端末の言語で出し分ける。他の言語は en に落ちる）
const jaEn = (ja, en) => `<span lang="ja" data-lang="ja">${esc(ja)}</span>${en ? `<span lang="en" data-lang="en" hidden>${esc(en)}</span>` : ''}`;

// キャラクターの表情 1 枚（<picture>）。どの画面も上半身（-bust）。全身（-full）はいまは使わない（11-06 作家：チャットの UI に人は小さめ）。ファイル名は固定：作家が差し替える（scripts/concierge-assets.mjs）
// 横向き（スマホの横、PC の幅 900px 以上）は全身（full）を縦いっぱいに、それ以外は上半身（bust）。選ぶのは media query（JS ではない）
// WebP を先に、PNG を fallback に。画像は public/concierge/artist/（女の子に確定。11-06 作家）
// src/concierge/index.ts の faceEl() と同じ形にする
export const FULL_MQ = '(orientation: landscape) and (max-height: 500px), (orientation: landscape) and (min-width: 900px)';
export function facePicture(face, prefix, { on = false, priority = false } = {}) {
  const b = `${prefix}concierge/artist/${face}`;
  const set = (v, ext) => `${b}-${v}.${ext} 1x, ${b}-${v}@2x.${ext} 2x`;
  return `<picture class="cg-face${on ? ' is-on' : ''}" data-face="${face}"><source type="image/webp" srcset="${set('bust', 'webp')}"><img src="${b}-bust.png" srcset="${set('bust', 'png')}" width="512" height="412" alt=""${priority ? ' fetchpriority="high"' : ' loading="lazy"'}></picture>`;
}

// 受付 /index.html（docs/ENTRANCE.md 3 節）。絵は出さない。見出し・キャラクター・最初の 2 文・選択肢・入力欄は JS の前に HTML で出す
export function galleryPage({ works, baseUrl }) {
  const cfg = readConfig();
  const title = cfg.title || {};
  const greet = cfg.greeting || {};
  const name = cfg.persona?.name || {};
  const intro = cfg.persona?.intro_line || {};
  const lines = [];
  if (intro.ja) lines.push([intro.ja, intro.en, null]);
  (greet.ja || []).slice(0, 3).forEach((ja, i) => lines.push([ja, greet.en?.[i], i]));   // 3 文まで（11-06 深夜：ようこそ／彩り／どんな絵）
  // 最初の文は 0.4 秒ずつ間を置いて現れる（CSS の animation-delay）。data-greet は catalog.json の greeting の何番目か（他の言語の差し替え用）
  const greeting = lines.map(([ja, en, gi], i) => `<p class="cg-line cg-ai cg-greet"${gi === null ? '' : ` data-greet="${gi}"`} style="--d:${(0.3 + i * 0.4).toFixed(1)}s">${jaEn(ja, en)}</p>`).join('\n        ');
  const hint = cfg.ui_hint?.ja ? cfg.ui_hint : CONFIG_FALLBACK.ui_hint;
  const write = cfg.ui_write?.ja ? cfg.ui_write : CONFIG_FALLBACK.ui_write;
  const openers = (cfg.openers?.ja || []).slice(0, 3).map((ja, i) =>
    `<button type="button" class="cg-opt" data-opener-index="${i}">${jaEn(ja, cfg.openers?.en?.[i])}</button>`).join('\n          ')
    // 4 つ目：自分のことばで書く（押すと入力欄が出る。11-06 作家「最初の画面はボタンだけ」）。data-opener-index="write" は、
    // JS を読み込む前に押されたとき page.ts が預かって読み込み後に押し直すため（選択肢と同じ扱い）
    + `\n          <button type="button" class="cg-opt cg-write" data-opener-index="write">${jaEn(write.ja, write.en)}</button>`;
  const host = name.ja ? `<figcaption class="cg-name">${jaEn(name.ja, name.en)}</figcaption>` : '';
  const present = cfg.present_line?.ja ? cfg.present_line : CONFIG_FALLBACK.present_line;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${esc(SITE_NAME)}｜${esc(SITE_TAGLINE)}</title>
<meta name="description" content="${esc(title.ja)}。話しながら、長く一緒に暮らせる一枚に出会えるオンラインギャラリー">
${headOg({ title: `${SITE_NAME}｜${SITE_TAGLINE}`, description: RECEPTION_DESC, image: `${baseUrl}/og/gallery.png`, url: `${baseUrl}/` })}
${headIcons('')}
<meta name="recommend-api" content="${esc(process.env.RECOMMEND_API ?? '/api/recommend')}">
${doorStyle()}
<!-- 受付の背景の壁（AUDIT-1 P1-4）。src/ui/page.css の .cg-host::before と同じ画像・同じ境目（640px）にそろえる -->
<link rel="preload" as="image" href="concierge/wall/wall-tall.webp" type="image/webp" media="(max-width: 639.98px)">
<link rel="preload" as="image" href="concierge/wall/wall-wide.webp" type="image/webp" media="(min-width: 640px)">
${FONTS}
<link rel="stylesheet" href="src/ui/page.css">
</head>
<body class="paper">
${doorBody()}
<main class="cg" id="concierge">
  <header class="cg-top">
    <h1 class="cg-title">${jaEn(title.ja, title.en)}<span class="cg-name">Meet the Painting</span></h1>
    <div class="cg-tools">${langSel()}</div>
  </header>
  <figure class="cg-host">
    <div class="cg-faces" role="img" aria-label="受付のキャラクター"${i18nAttr('aria-label:cg_host_label')}>${facePicture('smile', '', { on: true, priority: true })}</div>
    ${host}
  </figure>
  <section class="cg-talk" aria-label="受付の会話"${i18nAttr('aria-label:cg_talk_label')}>
    <div class="cg-thread" aria-live="polite">
        ${greeting}
        <div class="cg-openers cg-greet" style="--d:${(0.3 + lines.length * 0.4).toFixed(1)}s" role="group" aria-label="${esc(hint.ja)}">
          <span class="cg-openers-cap">${jaEn(hint.ja, hint.en)}</span>
          ${openers}
        </div>
    </div>
    <div class="cg-foot" style="--d:${(0.5 + lines.length * 0.4).toFixed(1)}s"><a class="cg-skip" href="gallery/" data-i18n="cg_skip">受付を飛ばして、ギャラリー全体を見る</a><a class="cg-data" href="data-note.html" data-i18n="fu_data">記録について</a></div>
  </section>
  <form class="cg-form" action="#concierge" hidden><input name="q" type="text" maxlength="600" autocomplete="off" enterkeyhint="send" placeholder="こんな気分のときに、こうしたい" aria-label="こんな気分のときに、こうしたい" data-i18n-ph="cg_placeholder"><button type="submit" data-i18n="rec_send">送る</button></form>
  <section class="cg2" tabindex="-1" aria-label="今日のあなたへの 1 点"${i18nAttr('aria-label:cg_card_head')} hidden>
    <div class="cg2-in">
      <div class="cg2-host" aria-hidden="true"></div>
      <p class="cg2-line" aria-live="polite">${jaEn(present.ja, present.en)}</p>
    </div>
  </section>
</main>
<script type="module" src="src/page.ts"></script>
</body>
</html>
`;
}

// ギャラリー /gallery/index.html（docs/ENTRANCE.md 4 節）。白い壁に実寸比で並べる。おすすめ（?from=<id>）は page.ts が先頭に出す
// G-1：大きさの区分（長辺 cm）。小 = 30 未満（F0〜F4）、中 = 30〜60（F6〜F12）、大 = 60 以上（F15〜）
export const longSide = (sizeCm) => Math.max(...(sizeCm || [0]));
// 小 = F0〜F4（長辺 33.3 まで）、中 = F6〜F12（60.6 まで）、大 = F15〜（65.2 から）。11-07 作家の区分に合わせる
export function sizeClass(longCm) { return longCm < 35 ? 's' : longCm < 61 ? 'm' : 'l'; }
// 号数の表示（「F15 号」→「F15」。言語によらず同じ）
export const fLabel = (label) => { const s = typeof label === 'string' ? label : label?.ja || label?.en || ''; return /F\s*\d+/.exec(s)?.[0].replace(/\s/g, '') || ''; };
const SIZE_CHIPS = [['all', 'すべて', 'gw_size_all'], ['s', '小', 'gw_size_s'], ['m', '中', 'gw_size_m'], ['l', '大', 'gw_size_l']];

export function galleryWallPage({ works: input, baseUrl }) {
  // G-1：並びは左から小 → 大（長辺の昇順。同じなら元の順）。?from= のおすすめを先頭に出すのは page.ts
  const works = [...input].sort((a, b) => longSide(a.size_cm) - longSide(b.size_cm));
  const counts = { all: works.length, s: 0, m: 0, l: 0 };
  works.forEach((w) => counts[sizeClass(longSide(w.size_cm))]++);
  const chips = SIZE_CHIPS.map(([k, ja, key]) => `<button type="button" class="gw-chip" data-size="${k}" data-i18n="${key}" aria-pressed="${k === 'all'}"${counts[k] ? '' : ' disabled'}>${ja}</button>`).join('');
  const maxH = Math.max(...works.map((w) => w.size_cm[1]), 1);
  const items = works.map((w, i) => {
    const [cw, ch] = w.size_cm;
    const title = t(w.title, 'ja');
    const titleEn = t(w.title, 'en');
    return `
    <a class="gw-item" data-id="${esc(w.id)}" data-size="${sizeClass(longSide(w.size_cm))}" data-long="${longSide(w.size_cm)}" href="../w/${esc(w.id)}/?via=gallery" style="--wcm:${cw};--hcm:${ch}">
      <span class="gw-foryou" data-i18n="gw_for_you" hidden>あなたへの 1 点</span>
      <img src="../works/${esc(w.id)}/generated/painting_1024.jpg" srcset="${smallSrcset(`../works/${esc(w.id)}/generated/`)}" sizes="${gwSizes(cw, maxH)}" alt="" ${i < 3 ? 'fetchpriority="high"' : 'loading="lazy"'} width="${Math.round(cw * 10)}" height="${Math.round(ch * 10)}" style="aspect-ratio:${cw}/${ch}">
      <span class="gw-cap" data-title-ja="${esc(title)}" data-title-en="${esc(titleEn)}"><b class="t-main">${esc(title)}</b>${titleEn && titleEn !== title ? `<i class="t-sub latin">${esc(titleEn)}</i>` : '<i class="t-sub" hidden></i>'}<span>${fLabel(w.size_label) ? `${fLabel(w.size_label)} ・ ` : ''}${cw} × ${ch} cm</span></span>
    </a>`;
  }).join('') + ``;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ギャラリー / Gallery — ${SITE_NAME}</title>
<meta name="description" content="白い壁に、絵を実物の寸法の比で並べたギャラリー">
${headOg({ title: `ギャラリー — ${SITE_NAME}`, description: '白い壁に、絵を実物の寸法の比で並べたギャラリー', image: `${baseUrl}/og/gallery.png`, url: `${baseUrl}/gallery/` })}
${headIcons('../')}
${FONTS}
<link rel="stylesheet" href="../src/ui/page.css">
</head>
<body class="paper">
<main class="gw">
  <div class="gw-top">
    <a class="gw-back" href="../" data-i18n="gw_back">受付に戻る</a>
    <h1 class="gw-title" aria-label="ギャラリー"${i18nAttr('aria-label:gallery_title')}><span>ギャラリー</span><span class="latin">Gallery</span></h1>
    ${langSel()}
  </div>
  <div class="gw-filter" role="group" aria-label="大きさで絞り込む"${i18nAttr('aria-label:gw_filter_label')}>${chips}</div>
  <div class="gw-wall" style="--maxh:${maxH}" tabindex="0" aria-label="作品"${i18nAttr('aria-label:gw_works_label')}>
    <div class="gw-intro" aria-hidden="true"><b class="latin">SHEER Gallery</b><span>語りかけるオンラインギャラリー</span><i class="latin">Meet the Painting</i></div>${items}
  </div>
  <span class="gw-more" aria-hidden="true">→</span>
  <p class="gw-scroll" data-i18n="gw_scroll">横にスクロール</p>
  ${footer('../')}
</main>
<script type="module" src="../src/page.ts"></script>
</body>
</html>
`;
}

// 作品カード（名刺大 91 × 55 mm、裏面）。QR は 22mm
export function cardSvg({ work, space, qrSvgInner, url }) {
  const title = t(space.title, 'ja');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="91mm" height="55mm" viewBox="0 0 91 55" font-family="sans-serif">
  <rect width="91" height="55" fill="#fff"/>
  <g transform="translate(6 6) scale(${(22 / 100).toFixed(4)})">${qrSvgInner}</g>
  <text x="33" y="12" font-size="4.2" font-weight="bold">${esc(title)}</text>
  <text x="33" y="18" font-size="2.8" fill="#444">${work.size_cm[0]} × ${work.size_cm[1]} cm</text>
  <text x="33" y="27" font-size="3" fill="#222">この絵の世界をのぞけます</text>
  <text x="33" y="31.5" font-size="2.6" fill="#666">Step into the painting's world</text>
  <text x="33" y="40" font-size="2.2" fill="#888">${esc(url)}</text>
  <text x="6" y="51" font-size="2" fill="#999">QR を読むか、URL を開いてください。音が出ます（消音でも文字で楽しめます）</text>
</svg>
`;
}

// ───── 会場に掛けるキャプション /exhibit/index.html（docs/EXPERIENCE.md 1 節、DECISIONS 76） ─────
// A4 縦に 95 × 65 mm のキャプションを 2 列 × 3 段（6 点で 1 枚）。点線が切り取り線。QR は作品ページ + ?from=qr（会場の入口）
// 公開サイトのナビからはリンクしない（noindex）。管理ページの「展示用のキャプションを印刷」から開く

// 印刷の文字の改行（docs/DESIGN.md「改行の決まり」）：文節ごとに inline-block の span にして、文節の間だけで折り返す。
// 考え方は src/text/phrases.ts と同じ（助詞・句読点を前の語へ）。生成は Node（Actions は Node 22）で動くので JS で小さく持つ。
// 加えて、カタカナの語が細切れに出る（「シナ|ベニヤ」「ミク|スト」「スマ|ホ」）ので、続くカタカナは 1 つにまとめる
const JA_RE = /[぀-ヿ一-鿿々]/;
const KATA_RE = /^[゠-ヿー]+$/;
const ATTACH_JA = new Set(['って', 'いる', 'ない', 'よう', 'する', 'じゃ', 'れる', 'られる', 'ます', 'です', 'でした', 'ました', 'ている', 'なら', 'けど', 'から', 'まで', 'だけ', 'など', 'たち', 'ごと']);
let segJa;
export function phraseSplit(text) {
  const s = String(text ?? '');
  if (!s) return [];
  segJa ??= typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
  if (!segJa || !JA_RE.test(s)) return [s];
  const out = [];
  let afterPunct = true;   // 文頭と句読点のあとは新しい文節
  let pendingOpen = '';    // 開き括弧は次の語につける
  for (const { segment: t, isWordLike } of segJa.segment(s)) {
    const last = out.length ? out[out.length - 1] : '';
    if (!isWordLike) {
      if (/^[（「『【〈《〔[(“‘]/.test(t)) { pendingOpen += t; continue; }
      if (out.length) out[out.length - 1] += t; else out.push(t);
      afterPunct = /[、。，．！？!?…]/.test(t);
      continue;
    }
    const hira = /^[぀-ゟー]+$/.test(t) && (t.length <= 2 || ATTACH_JA.has(t));
    const kata = KATA_RE.test(t) && /[゠-ヿー]$/.test(last);
    const latin = out.length > 0 && !JA_RE.test(last);   // 英数字だけの語（「QR」「A4」「95 ×」）は次の語と離さない
    if (!afterPunct && !pendingOpen && out.length && (hira || kata || latin)) out[out.length - 1] += t;
    else out.push(pendingOpen + t);
    pendingOpen = '';
    afterPunct = false;
  }
  if (pendingOpen) out.push(pendingOpen);
  return out;
}
// 文節の span（日本語を含むときだけ。ラテン文字だけの文は空白で折り返すのでそのまま）。文節の端の空白は span の外に出す（inline-block の中だと消える）
// 句読点までの「句」も inline-block でまとめ、改行はまず句の間で（「この絵の／中に」より「読み取ると、／この絵の中に」）。句が幅に入らなければ句の中の文節の間で折り返す
export const phraseHtml = (text) => {
  const parts = phraseSplit(text);
  if (parts.length < 2) return esc(text);
  const span = (p) => {
    const m = /^(\s*)(.*?)(\s*)$/s.exec(p);
    return `${m[1] ? ' ' : ''}<span class="ph">${esc(m[2])}</span>${m[3] ? ' ' : ''}`;
  };
  const clauses = [[]];
  for (const p of parts) { clauses[clauses.length - 1].push(p); if (/[、。，．！？!?]\s*$/.test(p)) clauses.push([]); }
  const used = clauses.filter((c) => c.length);
  if (used.length < 2) return parts.map(span).join('');
  return used.map((c) => `<span class="cl">${c.map(span).join('')}</span>`).join('');
};

export const EXHIBIT_TEXT = {
  title: '展示用のキャプション',
  lead: '絵の横に貼ってください。QR を読み取ると、その絵の作品ページが開き、絵の中に入れます。',
  how: 'A4 縦、倍率 100%（実際のサイズ）で印刷し、点線で切り取ります。1 枚の大きさは 95 × 65 mm です。',
  print: '印刷する',
  scan: 'スマホで読み取ると、この絵の中に入れます',
  sound: '音が出ます。消音でも文字で楽しめます',
};
export const EXHIBIT_PER_SHEET = 6;
export const exhibitUrl = (baseUrl, id) => `${baseUrl}/w/${id}/?from=qr`;
// QR の SVG（generated/qr.svg と展示用のキャプションで同じ作り方にする）
export const QR_SVG_OPTS = { type: 'svg', margin: 1, errorCorrectionLevel: 'M' };
export const qrSvg = (url) => QRCode.toString(url, QR_SVG_OPTS);

// QR の SVG（qrcode の出力）を、キャプションの中に埋め込む形にする（XML 宣言を外し、大きさは CSS の mm で決める）
const inlineQr = (svg, label) => String(svg || '').replace(/<\?xml[^>]*>\s*/, '').trim()
  .replace(/^<svg\b([^>]*)>/, (_, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} class="ex-qr-svg" role="img" aria-label="${esc(label)}">`);

// 1 点のキャプション。出すのは work.json にある項目だけ（無い項目は行ごと出さない）
function exhibitCard(work, baseUrl, qrSvg) {
  const id = work.id;
  const ja = work.title?.ja || '';
  const en = work.title?.en || '';
  const main = ja || en || id;
  const sub = ja && en && en !== ja ? en : '';
  const medium = asMulti(work.medium);
  const mediumJa = medium?.ja || medium?.en || '';
  const f = fLabel(work.size_label);
  const cm = Array.isArray(work.size_cm) && work.size_cm.length >= 2 ? `${work.size_cm[0]} × ${work.size_cm[1]} cm` : '';
  const size = [f, cm].filter(Boolean).join(' ・ ');
  const meta = [
    work.year != null && work.year !== '' ? `<span class="ex-year" data-field="year">${esc(work.year)}</span>` : '',
    mediumJa ? `<span class="ex-medium" data-field="medium">${phraseHtml(mediumJa)}</span>` : '',
    size ? `<span class="ex-size" data-field="size">${esc(size)}</span>` : '',
  ].filter(Boolean).join('');
  const url = exhibitUrl(baseUrl, id);
  return `
    <article class="ex-card" data-id="${esc(id)}" data-url="${esc(url)}">
      <div class="ex-text">
        <h2 class="ex-title">${phraseHtml(main)}</h2>
        ${sub ? `<p class="ex-title-en" lang="en">${esc(sub)}</p>` : ''}
        ${meta ? `<p class="ex-meta">${meta}</p>` : ''}
      </div>
      <div class="ex-qr" data-url="${esc(url)}">${inlineQr(qrSvg, `${main} の作品ページを開く QR コード`)}</div>
      <p class="ex-guide"><span class="ex-scan">${phraseHtml(EXHIBIT_TEXT.scan)}</span><span class="ex-sound">${phraseHtml(EXHIBIT_TEXT.sound)}</span></p>
      <p class="ex-brand" lang="en">${SITE_NAME}</p>
    </article>`;
}

// works：work.json の配列。qrSvgOf(id, url)：その作品の QR の SVG（generated/qr.svg の中身）
export function exhibitPage({ works: input, baseUrl, qrSvgOf }) {
  // 並びはギャラリーと同じ（長辺の昇順。同じなら元の順）
  const works = [...input].sort((a, b) => longSide(a.size_cm) - longSide(b.size_cm));
  const sheets = [];
  for (let i = 0; i < works.length; i += EXHIBIT_PER_SHEET) sheets.push(works.slice(i, i + EXHIBIT_PER_SHEET));
  const body = sheets.map((list) => `
  <section class="ex-sheet">${list.map((w) => exhibitCard(w, baseUrl, qrSvgOf(w.id, exhibitUrl(baseUrl, w.id)))).join('')}
  </section>`).join('');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${EXHIBIT_TEXT.title} — ${SITE_NAME}</title>
${headIcons('../')}
${FONTS}
<style>
/* 白地・墨・明朝・細い線（docs/DESIGN.md）。印刷の寸法は mm で決める */
:root { --ink: #141210; --ink-2: #625d56; --line: rgba(20, 18, 16, .22); --bg-2: #f1efea; --cut: rgba(20, 18, 16, .45);
  --serif: "Shippori Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif; --latin: "Cormorant Garamond", "Times New Roman", serif;
  --sans: "Noto Sans JP", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif; }
@page { size: A4; margin: 10mm; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; color: var(--ink); background: #fff; font: 400 14px/1.8 var(--sans); word-break: keep-all; overflow-wrap: anywhere; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.ph, .cl { display: inline-block; }
.cl { max-width: 100%; }
.ex-tools { max-width: 190mm; margin: 0 auto; padding: 32px 0 28px; }
.ex-tools h1 { margin: 0 0 10px; font: 400 22px/1.5 var(--serif); letter-spacing: .08em; }
.ex-lead { margin: 0; font-size: 15px; }
.ex-how { margin: 4px 0 20px; color: var(--ink-2); font-size: 12px; }
.ex-print { min-height: 52px; min-width: 200px; padding: 0 28px; border: 0; border-radius: 26px; background: var(--ink); color: #fff; font: 400 14px/1 var(--sans); letter-spacing: .14em; cursor: pointer; }
.ex-print:hover { opacity: .92; }
.ex-print:active { transform: translateY(1px); }
.ex-print:focus-visible { outline: 1px solid var(--ink); outline-offset: 3px; }
/* 1 枚の紙：2 列 × 3 段。外側の上と左、各キャプションの右と下に点線（隣どうしの線は 1 本） */
.ex-sheet { display: grid; grid-template-columns: repeat(2, 95mm); grid-auto-rows: 65mm; width: 190mm; border-top: .25mm dashed var(--cut); border-left: .25mm dashed var(--cut); break-after: page; }
.ex-sheet:last-child { break-after: auto; }
.ex-card { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 32mm; grid-template-rows: minmax(0, 1fr) auto; column-gap: 5mm; width: 95mm; height: 65mm; padding: 6mm 6mm 5mm 7mm; border-right: .25mm dashed var(--cut); border-bottom: .25mm dashed var(--cut); overflow: hidden; break-inside: avoid; }
.ex-text { grid-column: 1; grid-row: 1; min-width: 0; }
.ex-title { margin: 0; font: 400 13pt/1.45 var(--serif); letter-spacing: .06em; }
.ex-title-en { margin: .6mm 0 0; font: italic 300 10pt/1.3 var(--latin); letter-spacing: .02em; }
.ex-meta { margin: 2.6mm 0 0; color: var(--ink-2); font-size: 7.5pt; line-height: 1.6; font-variant-numeric: tabular-nums; }
.ex-meta > span { display: block; }
.ex-qr { grid-column: 2; grid-row: 1 / span 2; align-self: start; width: 32mm; height: 32mm; }
.ex-qr-svg { display: block; width: 32mm; height: 32mm; }
.ex-guide { grid-column: 1; grid-row: 2; align-self: end; margin: 0; }
.ex-scan { display: block; font-size: 8pt; line-height: 1.55; letter-spacing: .02em; }
.ex-sound { display: block; margin-top: .8mm; color: var(--ink-2); font-size: 6.5pt; line-height: 1.5; }
.ex-brand { position: absolute; right: 6mm; bottom: 4.6mm; margin: 0; color: var(--ink-2); font: 400 7.5pt/1 var(--latin); letter-spacing: .08em; }
@media screen {
  body { background: var(--bg-2); padding: 0 16px 48px; }
  .ex-paper { width: 210mm; min-height: 297mm; margin: 0 auto 24px; padding: 10mm; background: #fff; box-shadow: 0 0 0 1px var(--line); }
  .ex-wrap { overflow-x: auto; }
}
@media print {
  .no-print { display: none !important; }
  body { background: #fff; }
  .ex-paper { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
}
</style>
</head>
<body>
<header class="ex-tools no-print">
  <h1>${EXHIBIT_TEXT.title}</h1>
  <p class="ex-lead">${phraseHtml(EXHIBIT_TEXT.lead)}</p>
  <p class="ex-how">${phraseHtml(EXHIBIT_TEXT.how)}</p>
  <button type="button" class="ex-print" onclick="window.print()">${EXHIBIT_TEXT.print}</button>
</header>
<div class="ex-wrap"><main class="ex-paper">${body}
</main></div>
</body>
</html>
`;
}
