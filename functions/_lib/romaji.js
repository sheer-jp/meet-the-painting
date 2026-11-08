// かな → ローマ字（ヘボン式。パスポートの書き方に近い簡単な表）。作品の id（URL）の案に使う（docs/REGISTER.md 13.3）
// 漢字は読めないので、読み（ひらがな・カタカナ）を渡す。長音は書かない（おう → o、ー は落とす）。ん は b・m・p の前で m
const BASE = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko', が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to', だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho', ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo', ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゎ: 'wa',
};
// 拗音（き + ゃ → kya）。し・ち・じ は sha・cha・ja
const YOON = { ゃ: 'a', ゅ: 'u', ょ: 'o' };
const YOON_HEAD = { し: 'sh', ち: 'ch', じ: 'j', ぢ: 'j' };
// 外来音（ふぁ → fa、てぃ → ti など）
const SMALL = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };
const EXTRA = { ふ: 'f', う: 'w', て: 't', で: 'd', ゔ: 'v', し: 'sh', じ: 'j', ち: 'ch', つ: 'ts' };

/** カタカナをひらがなに @param {string} s */
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** かなだけでできているか（長音・空白・中黒・英数字は許す） @param {any} s */
export const isKana = (s) => /^[ぁ-ゖァ-ヺー・ 　A-Za-z0-9\s-]+$/.test(String(s ?? '')) && /[ぁ-ゖァ-ヺ]/.test(String(s ?? ''));

/** かなをローマ字に（かな以外の英数字はそのまま、ほかは区切り） @param {any} text */
export function romanize(text) {
  const s = toHira(String(text ?? '').normalize('NFKC'));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (c === 'っ') {
      // 次の音の頭を重ねる（ち → tchi）
      const next = romanize(s.slice(i + 1, i + 3)).replace(/^-/, '');
      out += next.startsWith('ch') ? 't' : next[0] && /[a-z]/.test(next[0]) && !/[aiueon]/.test(next[0]) ? next[0] : '';
      continue;
    }
    if (c === 'ん') { const next = romanize(n ?? ''); out += /^[bmp]/.test(next) ? 'm' : 'n'; continue; }
    if (c === 'ー') continue;
    if (n && n in YOON && c in BASE && c !== 'ゃ' && c !== 'ゅ' && c !== 'ょ') {
      const head = /** @type {any} */ (YOON_HEAD)[c] ?? /** @type {any} */ (BASE)[c].slice(0, -1) + 'y';
      out += head + /** @type {any} */ (YOON)[n];
      i++;
      continue;
    }
    if (n && n in SMALL && c in EXTRA) { out += /** @type {any} */ (EXTRA)[c] + /** @type {any} */ (SMALL)[n]; i++; continue; }
    if (c in BASE) { out += /** @type {any} */ (BASE)[c]; continue; }
    if (c in YOON) { out += /** @type {any} */ ({ ゃ: 'ya', ゅ: 'yu', ょ: 'yo' })[c]; continue; }
    if (/[A-Za-z0-9]/.test(c)) { out += c.toLowerCase(); continue; }
    out += '-';
  }
  // 長音（おう・おお・うう）は書かない（とうきょう → tokyo）
  return out.replace(/ou/g, 'o').replace(/oo/g, 'o').replace(/uu/g, 'u').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
