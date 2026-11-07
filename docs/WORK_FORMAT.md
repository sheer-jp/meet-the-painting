# 作品定義ファイル V2（`works/<id>/work.json`）

作家が触るのはこのファイルと画像・音声だけ。他はすべて `npm run generate -- <id>` が作る。

## 置くもの

```
works/<id>/
├─ painting.jpg   必須。原画の撮影画像。長辺 2000px 程度、正対して撮る
├─ work.json      必須。下記
└─ voice.mp3      任意。作家のナレーション（1〜3 分、日本語）
```

`<id>` は URL と QR に使う。英小文字・数字・ハイフンのみ（例：`blue-tide-2025`）。

## work.json

```jsonc
{
  "id": "blue-tide-2025",
  "title": { "ja": "青い潮", "en": "Blue Tide" },   // en は任意。無ければ翻訳で補う
  "year": 2025,
  "size_cm": [18, 14],                    // 実物の寸法（幅, 高さ）。入口と壁の絵の大きさに使う
  "medium": { "ja": "キャンバスに油彩", "en": "Oil on canvas" },

  // 奥から浮いてくるメッセージ。日本語で 1 文ずつ。1 文 40 文字以内、3〜10 文
  // 声（voice.mp3）があるなら、声で語る文と同じにする
  "messages": [
    "海辺の町で描いた。",
    "朝の光が水面で割れるとき、青が緑に変わる一瞬があった。",
    "その一瞬を、手のひらに収まる大きさに閉じ込めたかった。"
  ],

  // 英語だけは作家が目を通す。書けば翻訳の代わりに使う。他の言語は自動
  "messages_en": [
    "I painted this in a town by the sea.",
    "When the morning light broke on the water, there was a moment the blue turned green.",
    "I wanted to keep that moment at a size that fits in the palm of a hand."
  ],

  // 作品ページ
  "availability": "available",          // available | sold | not_for_sale。任意。無ければ表示しない
  "contact": "https://forms.example/...", // 作家への連絡（フォームの URL を推奨。mailto は public に書かない）。無ければ site.json の既定値
  "rooms": ["living-apartment", "hotel-lobby", "cafe"],  // 部屋で見るに使う部屋。省略時は rooms/ の全部

  // 気分の言葉（気分から絵をすすめる、docs/RECOMMEND.md 8.3）。任意。3〜5 語、1 語 12 文字程度
  // ja が正。en は任意（作家の訳）。他の言語は自動で訳して generated/translations.json に残す
  // 無ければ、ANTHROPIC_API_KEY があるときだけ Claude が generated/moods.json に下書きする（作家がここに移して直す）
  // fit：向く人・時間・場所を 1 行（ja / en）。任意。訳さない（ja / en のまま catalog.json の fit に出る）。受付の AI がおすすめの手がかりにする
  "moods": {
    "ja": ["朝の光", "ぶつかって、ほどける", "にぎやかな静けさ"],
    "en": ["Morning light", "Collide, then come undone", "A lively quiet"],
    "fit": { "ja": "新しいことを始める朝の机に", "en": "For your desk on a morning when you start something new" }
  },

  // 音
  "audio": {
    "voice": "voice.mp3",                 // 無ければ文字のみ
    "voice_at": [0, 7.5, 16.0],           // 各文の開始秒。省略時は等間隔。あとで手で直す
    "ambient": "water"                    // calm | wind | water | drone | none。省略時は自動
  },

  // 自動生成の上書き。すべて任意。無ければ自動値
  "overrides": {
    "flow_strength": 0.6,                 // 0〜1。筆致に沿う初期の流れの強さ
    "vorticity": 0.5,                     // 0〜1。渦の強さ
    "speed": 0.4,                         // 0〜1。流体全体の速さ
    "tempo": 0.6,                         // 0〜1。速さのむら（場所と時間）の振幅。0 で均一。既定 0.6（docs/EXPERIENCE.md 8.1）
    "restore": 0.014,                     // 0.005〜0.03。原画への戻る力。小さいと長く崩れる（docs/FLUID_PER_WORK.md）
    "drive": 0.3,                         // 0.1〜0.6。常時の駆動（止まらずに流れ続ける力）
    "drive_dir": [0, 1],                  // [x, y]。常時の駆動に足す一定の向き（v は下 → 上。正規化し重み 0.3）。省略時は向きなし
    "arc": { "peak_s": 60, "calm_s": 150 }, // 時間の弧。全力で流れ始めてから peak_s 秒は全力、calm_s までに速さ ×0.45・駆動 ×0.4・戻る力 ×2.5 へ落ち着く（docs/FLUID_PER_WORK.md 5 節）。省略時は一定
    "flow_sigma": 6,                      // 3〜10。流れ場の平滑化（生成時）。小さいと筆致の細部まで流れる
    "look": {                             // 質感（docs/FLUID_LOOK.md 2 節）。省略した鍵は既定
      "relief": 0.5, "gloss": 0.18, "sharpness": 96, "bloom": 0.04, "grain": 0.02, "vivid": 0.45,
      "swell": 0,                         // 0〜1。波打ち：低周波の面の起伏で光沢が波のように走る（表示側だけ）
      "dots": 0,                          // 0〜1。粒立ち：厚みの山を丸く持ち上げる（表示側だけ）
      "bleed": 0                          // 0〜1。にじみ：sharpness を下げ bloom を上げる組み合わせ（色は拡散させない）
    },
    "radius_m": 2.5,                      // 包まれる球面の半径
    "melt_distance_m": 1.0,               // 溶け始める距離
    "text_color": "#e8f0ff",              // 文字色。省略時は主要色の最も明るい色
    "back_color": "#0b1a2a",              // 球面の裏側の基調色。省略時は面積最大の色
    "quality": "high"                     // high | medium | low。流体の解像度段階
  }
}
```

**物語の公開**：`generated/stories.json` の物語は、作家が確認して `"story_approved": true` を `work.json` に書くまで公開されない（ページ、`space.json`、カタログ、案内役のどれにも出ない）。下書きの印「（下書き。作家が自分の言葉に直す）」を消すこと（残っていると印があっても出ない。DECISIONS 73）。

## 生成されるもの（`works/<id>/generated/`）

| ファイル | 内容 |
| --- | --- |
| `painting_1024.jpg` | 作品ページの表示と流体の色場の絵の部分（1 サイズ） |
| `flow.png` | 筆致の流れ場（R=cos θ、G=sin θ、B=強さ） |
| `rooms/<name>.jpg` | 部屋のイメージに絵を寸法の目安で合成したもの（部屋ごと） |
| `moods.json` | 気分の言葉の下書き（`work.json` に `moods` が無く、`ANTHROPIC_API_KEY` があるときだけ。作家が `work.json` の `moods` に移す。再生成で上書きしない） |
| `stories.json` | 小さな物語（1 作品 1 本。日本語の下書き。作家が直す。再生成で上書きしない） |
| `translations.json` | メッセージ・物語・タイトルの 10 言語分。鍵は原文（ja）のハッシュ。原文を直せば再翻訳、直さなければ手直しを保持。英語は `messages_en` があればそれが正で、ここには生成しない |
| `space.json` | 実行時に読む唯一の定義 |
| `qr.svg` / `qr.png` | `BASE_URL/w/<id>/` の QR |
| `card.svg` | 作品カード印刷用（タイトル、寸法、QR） |

ビルド時にはさらに `dist/w/<id>/index.html`（作品ページ、OGP 付き）が作られる。

### space.json（実行時が読む）

```jsonc
{
  "id": "blue-tide-2025",
  "title": { "ja": "青い潮", "en": "Blue Tide", "fr": "Marée bleue", "...": "..." },
  "size_cm": [18, 14],
  "size_label": { "ja": "F0号", "en": "F0", "ko": "F0호", "...": "..." },   // 号数・技法・部屋の場所の名前（rooms[].label）は work.json / rooms/*.json の ja / en を翻訳キャッシュに通した 10 言語（E-15）
  "medium": { "ja": "キャンバスに油彩", "en": "Oil on canvas", "fr": "Huile sur toile", "...": "..." },
  "painting": "painting_1024.jpg",
  "palette": ["#0b1a2a", "#1f5f7a", "#5fa8b8", "#e8f0ff", "#c9a86a", "#2f3d2a"],
  "text_color": "#e8f0ff",
  "back_color": "#0b1a2a",
  "flow": { "texture": "flow.png", "strength": 0.6 },
  "fluid": { "vorticity": 0.5, "speed": 0.4, "quality": "high" },
  "space": { "radius_m": 2.5, "melt_distance_m": 1.0 },
  "audio": { "voice": "voice.mp3", "ambient": "water" },
  "availability": "available",
  "contact": "https://forms.example/...",
  "story": { "ja": "朝、コーヒーを淹れながらこの絵の前を通る。…", "en": "...", "...": "..." },
  "rooms": [
    { "name": "living-apartment", "image": "rooms/living-apartment.jpg", "wall_width_cm": 320, "label": { "ja": "マンションのリビング", "en": "Apartment living room", "...": "..." } }
  ],
  "messages": [
    { "at": 0,    "ja": "海辺の町で描いた。", "en": "I painted this in a town by the sea.", "fr": "...", "...": "..." },
    { "at": 7.5,  "ja": "朝の光が水面で割れるとき、…", "en": "...", "...": "..." }
  ]
}
```

全作品の `space.json` と `work.json` の `moods`（`moods.fit` はカタログの各作品の `fit` になる）、`recommend/config.json` から、`npm run generate` が `public/catalog.json`（気分から絵をすすめるのカタログ。主要色から計算した軸 `warmth` `brightness` `energy` を含む）を作る。形は `docs/RECOMMEND.md` 8.3。

言語コードは `ja, en, zh-Hans, zh-Hant, ko, fr, de, es, it, pt` の 10 個。無い言語は `en` に落ちる。

## 部屋のイメージ（`rooms/`、全作品で共用）

```
rooms/
├─ README.md             生成に使ったツールとプロンプト
├─ living-apartment.jpg      AI 生成の部屋。空いた壁がある。人や家具で大きさがわかる
└─ living-apartment.json     下記
```

```jsonc
{
  "name": "living-apartment",
  "image_width_px": 1586, "image_height_px": 992,
  "label": { "ja": "マンションのリビング", "en": "Apartment living room" },
  "scene": "東京のマンションのリビング。朝の光。ソファの向かいの白い壁。",   // 物語の下書きに使う
  "scale": {                                     // 縮尺。計算式と仮説は docs/SCALE.md
    "px_per_cm": 3.63,                           // 基準物の px ÷ 実寸 cm
    "basis": { "ja": "室内ドアの高さ 725px = 200cm" },
    "cross_check": { "ja": "天井〜床 845px = 240cm → 3.52" },   // 別の基準物で 15% 以内に一致するか
    "confidence": "high"                         // high | mid | low
  },
  "wall": { "corners_px": [[215, 0], [1385, 0], [1385, 845], [215, 845]] },   // 正面の壁の範囲（絵が収まるかの確認用）
  "hang": { "x_px": 800, "floor_y_px": 845, "center_from_floor_cm": 150 },     // 絵の中心 x、床の y（画面外でもよい）、掛ける高さ
  "suits_cm": [30, 120]                          // 向いている作品の長辺（cm）
}
```

生成すると `rooms/check/<name>_<id>.jpg`（基準線と計算値を描き込んだ確認画像）と `room_<name>_close.jpg`（絵のまわりに寄った画像）も出る。

絵の画像は AI に入れない。合成は `generate` がホモグラフィの逆写像で行い、「部屋は AI 生成のイメージ。絵は実物の写真。寸法は目安（壁幅 約 3m として合成）」と作品ページに出る。`rooms/README.md` に生成ツールと商用利用の可否を書く。

## 追加の手順

```bash
mkdir works/<id>
# painting.jpg, work.json, voice.mp3 を置く
npm run generate -- <id>     # 流れ場・部屋の合成・物語の下書き・翻訳・QR を生成（翻訳と物語には ANTHROPIC_API_KEY が要る。無ければ ja / en のみ、物語は空）
npm run dev -- --host        # https://<PCのIP>:5173/w/<id>/ で確認
```

翻訳が気に入らなければ `generated/translations.json` を、物語は `generated/stories.json` を直接直す。再生成しても手で直したものは上書きしない。
