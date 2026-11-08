// 登録の写真（docs/REGISTER.md 3、7 節）。種類を中身で確かめ、縦横の画素数を読み、位置情報など（EXIF）を消す
// 純関数。Uint8Array と DataView だけ（Pages Functions に nodejs_compat は無い）。画素は触らない（頭の部分だけを歩く）

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export const MIN_LONG_SIDE = 1600;   // ブラウザで長辺 2000px に縮めて送る。元が小さい写真は断る
export const MAX_LONG_SIDE = 2048;   // 縮め忘れの検出（2000px に余裕を見て）

/** 先頭の数バイトで種類を決める。JPEG と PNG だけを受け付ける（HEIC はブラウザで JPEG にしてから送る）
 * @param {Uint8Array} b @returns {'image/jpeg'|'image/png'|'image/heic'|null} */
export function sniffType(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  // ISO BMFF：4〜7 バイト目が ftyp、続く銘柄が heic / heix / mif1 など
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  return null;
}

// SOF の印（FFC0〜FFCF のうち DHT・JPG・DAC を除く）
const isSof = (/** @type {number} */ m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** JPEG の頭を歩いて、縦横を読み、APP1（EXIF・XMP）・APP13（IPTC）・COM を落とした写しを返す。壊れていれば null
 * APP0（JFIF）・APP2（色の情報 ICC）・APP14（Adobe）は残す（色が変わらないように）
 * @param {Uint8Array} b @returns {{ width: number, height: number, bytes: Uint8Array, removed: number } | null} */
export function cleanJpeg(b) {
  if (sniffType(b) !== 'image/jpeg') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  /** @type {Uint8Array[]} */
  const keep = [b.subarray(0, 2)];
  let i = 2, width = 0, height = 0, removed = 0;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    // 詰め物の FF を飛ばす
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return null;
    const marker = b[i];
    const start = i - 1;
    i++;
    // 長さの無い印（RST、TEM）
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { keep.push(b.subarray(start, i)); continue; }
    if (marker === 0xd9) { keep.push(b.subarray(start, i)); break; }
    if (i + 2 > b.length) return null;
    const len = dv.getUint16(i);
    if (len < 2 || i + len > b.length) return null;
    const end = i + len;
    if (isSof(marker)) {
      if (len < 7) return null;
      height = dv.getUint16(i + 3);
      width = dv.getUint16(i + 5);
    }
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe) removed++;
    else keep.push(b.subarray(start, end));
    i = end;
    // SOS のあとは画素のデータ。終わりまでそのまま写す
    if (marker === 0xda) { keep.push(b.subarray(i)); break; }
  }
  if (!width || !height) return null;
  const total = keep.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of keep) { out.set(p, o); o += p.length; }
  return { width, height, bytes: out, removed };
}

// PNG で落とすチャンク（EXIF と文字の情報）
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/** PNG の縦横を読み、EXIF と文字のチャンクを落とした写しを返す。壊れていれば null
 * @param {Uint8Array} b @returns {{ width: number, height: number, bytes: Uint8Array, removed: number } | null} */
export function cleanPng(b) {
  if (sniffType(b) !== 'image/png') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  /** @type {Uint8Array[]} */
  const keep = [b.subarray(0, 8)];
  let i = 8, width = 0, height = 0, removed = 0, ended = false;
  while (i + 12 <= b.length) {
    const len = dv.getUint32(i);
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (type === 'IHDR') { width = dv.getUint32(i + 8); height = dv.getUint32(i + 12); }
    if (PNG_DROP.has(type)) removed++;
    else keep.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || !width || !height) return null;
  const total = keep.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of keep) { out.set(p, o); o += p.length; }
  return { width, height, bytes: out, removed };
}

/**
 * 送られた写真を確かめる。{ ok: true, type, width, height, bytes } か { ok: false, error }
 * error：too_large（15MB 超）、type（JPEG・PNG 以外。HEIC は heic）、broken（読めない）、small（長辺 1600px 未満）、big（長辺 2048px 超。ブラウザで縮めていない）
 * @param {Uint8Array} b
 */
export function checkPhoto(b) {
  if (b.length > MAX_PHOTO_BYTES) return { ok: false, error: 'too_large' };
  const type = sniffType(b);
  if (type === 'image/heic') return { ok: false, error: 'heic' };
  if (type !== 'image/jpeg' && type !== 'image/png') return { ok: false, error: 'type' };
  const r = type === 'image/jpeg' ? cleanJpeg(b) : cleanPng(b);
  if (!r) return { ok: false, error: 'broken' };
  const long = Math.max(r.width, r.height);
  if (long < MIN_LONG_SIDE) return { ok: false, error: 'small' };
  if (long > MAX_LONG_SIDE) return { ok: false, error: 'big' };
  return { ok: true, type, width: r.width, height: r.height, bytes: r.bytes, removed: r.removed };
}
