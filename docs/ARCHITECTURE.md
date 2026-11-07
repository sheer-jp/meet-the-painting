# アーキテクチャ V2

体験は `docs/EXPERIENCE.md`、要件は `docs/REQUIREMENTS.md`。VR は空間モード（S1〜S5）、PC・スマホは物語モード（T0〜T5）。流体・文字・声は共通。

## 1. 技術選定

| 領域 | 選定 | 理由 |
| --- | --- | --- |
| 表示 | three.js（WebXR 対応、`renderer.xr`） | WebXR・VR コントローラ・PositionalAudio が標準で揃う。カスタムシェーダと RenderTarget で流体シムが書ける |
| 流体 | 自前の GPU 流体シミュレーション（GLSL、ping-pong RenderTarget） | 絵の具が流れ渦を巻く見た目は、粒子より 2D 流体シム（移流・渦度・圧力）が近い。既存実装（WebGL-Fluid-Simulation 系）の手法を three.js 上で再実装する |
| 文字 | `troika-three-text`（SDF テキスト） | VR 内で遠近を持って浮く文字をにじみなく描ける。日本語・中国語・韓国語のフォントも読める |
| ビルド | Vite + TypeScript | 立ち上げが速く、静的出力。作品ページ `/w/<id>/` はビルド時に生成 |
| 生成パイプライン | Node スクリプト（`sharp` + 自前の k-means / Sobel） | ブラウザ側を軽くするため、重い解析はビルド時に済ませる |
| 翻訳・物語の下書き | Claude API（生成時のみ） | 日本語原文 + 英語を渡して 8 言語に訳す。部屋ごとの小さな物語を作家のメッセージから下書きする。実行時には呼ばない |
| 部屋の合成 | 自前の射影変換（ホモグラフィの逆写像 + バイリニア、Node で `sharp` の raw バッファに対して） | `sharp.affine()` はアフィンのみで台形の壁に貼れない。逆写像は数十行。逃げ道は CSS `matrix3d` で実行時に貼る |
| 部屋の画像 | 画像生成モデルは問わない（作家の好きなツールで可） | 一度だけ 6〜10 枚作り `rooms/` にコミット。全作品で使い回す |
| QR | `qrcode` npm パッケージ | PNG / SVG を出せる。印刷用に SVG |
| 音 | three.js `Audio` / `PositionalAudio`（Web Audio） | ナレーションは非位置、環境音は位置付き |
| ホスティング | 静的（GitHub Pages + 作家所有の独自ドメイン） | HTTPS が必須。サーバーは不要。独自ドメインは印刷 QR の永続性のため（N-14）。Vite の `base` は `/` に固定（11-06 に変更：**Cloudflare Pages**（サイト + Pages Functions）。いまは `https://enter-the-painting.pages.dev/`。独自ドメインはサブドメインか `/gallery/` かを QR を刷る前に決める。GitHub Pages は使わない。`base` は `./`（決定 27）。決定 55） |

フレームワーク（React など）は使わない。画面は「ギャラリー」「作品ページ」「空間（VR）」「物語（PC・スマホ）」の 4 つ（11-06：入口に「受付」が加わり 5 つ）。

## 2. ディレクトリ構成（予定）

```
enter-the-painting/
├─ docs/                  計画・仕様
├─ works/                 作品定義（作家が触るのはここだけ）
│  └─ <id>/
│     ├─ painting.jpg     原画の撮影画像（長辺 2000px 程度）
│     ├─ work.json        タイトル、メッセージ（日本語）、上書きパラメータ
│     ├─ voice.mp3        作家ナレーション（任意）
│     └─ generated/       npm run generate の出力（flow.png、space.json、訳文、部屋の合成、物語、qr.svg）
├─ rooms/                 部屋のイメージ（AI 生成、全作品で共用）
│  ├─ living-apartment.jpg    空いた壁のある場面
│  └─ living-apartment.json   壁の 4 隅（px）と壁の実寸（cm）、場面の説明（物語の下書き用）
├─ scripts/
│  └─ generate/           画像 → 流れ場・主要色、翻訳、部屋の合成、物語の下書き、QR、作品ページの生成
├─ src/
│  ├─ main.ts             起動。URL から作品 id と言語を決め、space.json をロード。VR 可否でモードを決める
│  ├─ fluid/              GPU 流体シム（移流・渦度・圧力・色、泡の splat）。RenderTarget に描く。両モード共通
│  ├─ text/               文字の浮上（troika）。空間内 / 画面の奥、の 2 つの置き方
│  ├─ space/              VR 空間モード：壁の絵、接近、平面 → 球面の変形、S1〜S5 の進行
│  │  ├─ Particles.ts     手前の粒の層（InstancedMesh 1 つ、docs/VR_DEPTH.md V-1）
│  │  ├─ Surround.ts      床と奥の光（V-3）
│  │  └─ depth.ts         立体感の純関数（粒の配置、場面ごとの見え方、白飛び率）
│  ├─ story/              物語モード：画面への流体描画、拡大、T0〜T5 の進行
│  ├─ audio/              ナレーション・環境音・泡・ドローン
│  ├─ i18n/               言語判定、UI 文言（10 言語）
│  └─ ui/                 ギャラリー、作品ページ、部屋で見る、「入る」「閉じる」、言語切替
├─ public/fonts/          Noto Sans（サブセット済み）
├─ index.html             ギャラリー
└─ w/<id>/index.html      作品ページ（ビルド時に生成。OGP 付き）
```

追記（11-06、入口の作り直し。`docs/ENTRANCE.md`）：

```
enter-the-painting/
├─ functions/             Cloudflare Pages Functions（同じ origin の API。旧 worker/ の置き換え）
│  ├─ api/recommend.js    /api/recommend（Claude API の中継、ツール recommend_work）
│  ├─ api/recommend/config.js  /api/recommend/config（合言葉の要否。E-5）
│  └─ _lib/               prompt.js（system と本文）、relay.js（SSE の中継）
├─ src/concierge/         受付の画面（E-1。src/recommend/ を土台に作り直し）
├─ src/gallery.ts         ギャラリー空間の小さなスクリプト（E-2）
├─ public/concierge/      キャラクターの画像（listening / smile / present の 1x・2x）
├─ index.html             受付（11-06 から。いまのギャラリーは gallery/ へ）
├─ gallery/index.html     ギャラリー空間（generate が作る。pages.js）
└─ wrangler.toml          Pages の設定（pages_build_output_dir = "dist"、vars の CLAUDE_MODEL）
```

`worker/` は E-3 で `functions/` に移した（ディレクトリはまだ残っている。使わない）。

## 3. 画像 → 空間の生成パイプライン（`npm run generate -- <id>`）

入力：`works/<id>/painting.jpg` と `work.json`。出力：`works/<id>/generated/`。

1. **前処理**：絵を幅 1024px の JPEG に縮小（作品ページの表示と、流体の色場の中の絵の部分、の両方に使う。1 サイズだけ）
2. **主要色**：k-means で主要色 6 個。面積順に並べ、最も明るい色を文字色、面積最大の色を球面の裏側（絵が無かった方向）の基調色にする
3. **筆致の流れ場**：Sobel で勾配を取り、構造テンソルを平滑化して各画素の主方向を求める。方向と強さを `flow.png`（R=cos、G=sin、B=強さ）に書き出す。S1 のかすかな流れと、S2 で流体が流れ出す初期速度に使う
4. **動きのパラメータ**：画像のコントラスト・エッジ密度から、流体の渦度の強さ・流れの速さの初期値を決める。穏やかな絵はゆっくり、激しい絵は速く
5. **メッセージ**：`work.json` の `messages`（日本語、1 文ずつの配列）を取り、`voice.mp3` があれば各文の開始時刻を `voice_at` に合わせる（初期値は等間隔。手で直す）
6. **部屋の合成**：`rooms/*.json` の壁の 4 隅と実寸から、絵の寸法（`size_cm`）に合う矩形を壁の上に求め、絵の写真を射影変換で貼る。影を薄く落とす。各部屋 1 枚ずつ `rooms/<name>.jpg` を出す。絵の画像は生成モデルに入れない
7. **小さな物語の下書き**：部屋ごとの場面の説明と作家のメッセージを Claude API に渡し、3〜5 文の物語を日本語で下書きする。`stories.json` に出す。作家が直す。再生成で上書きしない
8. **翻訳**：`messages`、`stories`、タイトルを英語（作家が確認）と残り 8 言語に Claude API で訳す。既に訳がある文は再翻訳しない（`translations.json` にキャッシュ）。API キーが無ければ日本語と英語（手書きがあれば）のみ
9. **space.json**：主要色、流れ場、動き、音、10 言語のメッセージ、部屋のイメージと物語をまとめる。実行時はこれだけ読む
10. **作品ページと QR**：`w/<id>/index.html`（タイトル・絵・寸法・部屋で見る・連絡・OGP）を生成。絵と部屋の画像は HTML に直接書き、JS を待たずに出す。`BASE_URL/w/<id>/` の QR を `qr.svg` / `qr.png` に。作品カード印刷用 `card.svg` も出す

自動はたたき台。`work.json` の `overrides` で流体の速さ・渦・半径などを手で詰められるようにする。

## 4. 流体、変形、物語モード（実行時）

- **シムの領域**：2:1 の等距離円筒（equirect）。品質 high = 色 2048×1024 / 速度 512×256、medium = 1024×512 / 256×128、low = 512×256 / 128×64。絵は領域の前方のサブ矩形（幅の約半分、絵の比率を保つ）に置き、残りは `back_color` のグラデーションで初期化する。S3 で球面に貼るとそのまま全方向に色があり、「流れ込む」先がある。物語モードは同じ領域の絵の部分を切り出して画面に描く
- **流体シム**：速度場と色（染料）の 2 枚の RenderTarget を ping-pong。毎フレーム、移流 → 渦度の補強 → 発散計算 → 圧力解法（Jacobi 20 回）→ 速度の補正 → 色の移流。拡散は 0、色の減衰は 0（濁らせない・薄れさせない）
- **数値拡散への対策**：バイリニア補間の移流は毎フレームぼける（パラメータの拡散 0 では防げない）。色の移流は MacCormack（前進 + 後退で誤差を補正）にし、さらに毎フレーム原画へ弱く回帰させる（係数 0.002 程度。減衰ではなく「元の絵に戻ろうとする力」）。最長 3 分後も構図が残ることを S-1 で確認する
- **初期状態**：色 = 絵の画像、速度 = `flow.png` × 強さ。S1 では速度を 1〜2px 相当に抑え、距離が縮むほど強める。S2 / T2 で本来の強さにする
- **シュワシュワ**：S2 / T2 の 3 秒間、縁から内側へ向かって半径 2〜6px の小さな速度 splat を毎秒 200 個打つ。進行は縁からの距離で制御し、絵全体がほどけていくように見せる
- **物語モード**：同じシムの色テクスチャを全画面の平面に描く。T1 の拡大は UV のスケールで行い、中心は主要色の中で最も明るい色の重心。T3 では 10〜20 秒ごとに `flow.png` の別の領域を初期速度として注入し、流れの表情を変える。T4 は元の画像へクロスフェード
- **視線の影響**：S4 で、視線方向に対応する球面上の点に毎フレーム弱い力（splat）を加える。流れが視線に引き寄せられる
- **平面 → 球面**：1 枚のメッシュ（分割 128×64）を用意し、頂点シェーダで `t`（0=平面、1=球面）に応じて位置を補間する。UV は絵の範囲を球面の前方 90°×70° に写し、残りの球面（裏側）は基調色のグラデーション + 流体の流れ込みで埋める。カメラは動かさない
- **文字**：troika の Text を 1 つ。空間モードでは視線方向の 8m 先に置き、6 秒で 2m まで前進、滞在、3 秒で不透明度 0 に。前進中は視線の変化にゆっくり追従（毎秒 30%）。物語モードでは画面中央に、スケール 0.3 → 1.0、ぼかし → くっきり、不透明度 0 → 1 を 6 秒で。縦画面は 14 文字以上で折り返す。文字の背後に柔らかい暗いにじみ（半透明の放射状グラデーション）を置き、どの色の上でも読める（N-13）
- **接近（S1）**：WebXR ではカメラではなくリグ（親 Group）を動かす。トリガー時の頭の位置から絵までの距離で補間し、1.0m で止める。1.2 秒の間、周辺を暗くするビネットを掛けて酔いを抑える（N-08）。`prefers-reduced-motion` なら 0.6 秒 + 強いビネット
- **性能目安**：Quest で 72fps。落ちたら色を 512×512、圧力の反復を 12 回に下げる。段階は `space.json` の `quality` で指定でき、実行時に fps を見て自動で 1 段下げる

## 5. 場面の進行（`space/` と `story/`）

2 つの状態機械。空間モード `S0 → S1 → … → S5 → S0`、物語モード `T0 → T1 → … → T5`。遷移条件と数値は `docs/EXPERIENCE.md` に従う。各場面は `enter / update(dt) / exit` を持ち、流体・音・文字に指示を出すだけで、描画の実装は持たない。流体（`fluid/`）、文字（`text/`）、音（`audio/`）は両モードから同じ API で使う。

## 6. モードの切り替え

「入る」を押したときに決める。

| モード | 判定 | 操作 | 備考 |
| --- | --- | --- | --- |
| 空間（VR） | `navigator.xr.isSessionSupported('immersive-vr')` が true で「VR で入る」を押した | 頭で見回し。絵に向けてトリガー → 1.2 秒で接近（歩く / スティック 0.8m/s でも）。B / Y 長押しで戻る | three.js の `VRButton`。絵への当たり判定はコントローラの向きの Raycaster。接近はカメラ位置の補間で 1.0m に正確に止める |
| 物語（PC） | それ以外で「入る」 | クリックで一時停止、Esc で閉じる | 全画面の平面に流体を描く |
| 物語（スマホ） | 同上 | タップで一時停止、右上で閉じる。傾きで流れが寄る（推奨、`deviceorientation`。iOS は「入る」内で `requestPermission()`） | 縦・横どちらでも |

VR 対応端末でも作品ページは 2D。「VR で入る」は `isSessionSupported('immersive-vr')` かつ UA に `OculusBrowser` のときだけ出す（Android Chrome が Cardboard で true を返す場合があるため。要確認）。`?vr=1` で強制。

### フォールバックの分岐（F-54）

| 検出 | 落ち先 |
| --- | --- |
| WebGL2 なし、または half float の RenderTarget が作れない | 静止画モード：絵の静止画に CSS のクロスフェードとゆらぎ、文字と声はそのまま |
| `webglcontextlost`（iOS でバックグラウンド復帰時に起きる） | その場で静止画モードに切り替え、文字と声は続行 |
| XR セッションの開始に失敗、または拒否 | 物語モードへ |
| `voice.mp3` が無い、または再生に失敗 | 文字だけ。文字の滞在は文字数から |
| `space.json` が 404 | 作品ページの絵とメッセージ（HTML に埋め込み）だけ |
| フォントの読み込みに失敗 | システムフォントで Canvas に描いたスプライト |

## 7. ルーティング、ギャラリー、作品ページ、QR

（11-06 に変更：`/` は受付、ギャラリーは `/gallery/`。正は `docs/ENTRANCE.md`）

| URL | 場面 | 中身 |
| --- | --- | --- |
| `/` | C 受付 | 見出し、キャラクター、会話、おすすめのカード。見出しとキャラクターは HTML で JS を待たない。ページ用 JS は gzip 25KB 以下、体験バンドルは読まない。「この絵を見に行く」→ `/w/<id>/?via=concierge`、「ギャラリーを歩く」→ `/gallery/?from=<id>` |
| `/gallery/` | G ギャラリー | 白い壁に 6 作品を実寸比で。PC は横スクロール、スマホは縦。`?from=<id>` の 1 点が最初。選ぶと `/w/<id>/?via=gallery`。`generate` が作る |
| `/w/<id>/` | S0 作品ページ | 下記のまま。会場の QR は `?from=qr` でここに直接 |
| `/api/recommend` | （API） | Pages Functions。`GET /api/recommend/config` は `{ passphrase: true｜false }` だけ返す |

- ギャラリー：`/`。5 作品を実物の寸法比で並べる。背景に部屋のイメージ 1 枚。選ぶと作品ページへ（11-06 に変更：上の表の `/gallery/`。背景の部屋は取り下げ（D5-2））
- 作品ページ：`/w/<id>/`。ビルド時に生成する静的 HTML。絵（1024px JPEG）、タイトル・寸法・技法・年、販売状況、「入る」、部屋で見る（画像 6〜10 枚と物語、横スクロール）、連絡リンク、共有、他の作品、OGP メタ。絵と部屋の画像は HTML に直接あり JS を待たない。JS バンドル（gzip 300KB 以下）は `defer`。流体の 2048px テクスチャとフォントは「入る」を押してから読む
- 連絡リンク：`work.json` の `contact`（フォームの URL を推奨。`mailto:` は public の HTML に書かない）。無ければ `site.json` の既定値
- 計測（推奨）：Cookie なしのカウンタ（GoatCounter など）に `enter / finished / contact` の 3 イベントと入口（`from=qr` か否か）を送る。IP は保存しない。作品ページに 1 行明記（N-16）（11-06 追加：受付とギャラリーの `concierge_*`、`gallery_pick`、`enter` の `via`。F-73、U-8 次第）
- 言語：`navigator.languages` を順に正規化して、10 言語のうち最初に一致するものを選ぶ。無ければ英語。`?lang=ja` で固定。切り替えは `localStorage` に覚える。正規化：`zh-TW | zh-HK | zh-MO | zh-Hant*` → `zh-Hant`、それ以外の `zh*` → `zh-Hans`、`pt*` → `pt`、その他は言語サブタグ（`en-US` → `en`）。単体テストに含める
- 開発中は `?w=<id>` でも開けるようにし、本番はパス `/w/<id>/`。QR は本番パス + `?from=qr`
- QR の中身は `BASE_URL/w/<id>/`。`BASE_URL` は `.env` で設定

## 8. 言語（`i18n/`）

- メッセージと小さな物語の訳は `space.json` に 10 言語分を埋め込む（1 作品 10 文 + 物語 10 本 × 10 言語でも数十 KB）
- UI 文言（「入る」「戻る」「VR で入る」「他の作品」など 15 個程度）は `src/i18n/ui.json` に 10 言語分
- フォントは言語ごとに 1 つだけ読む：`ja` → Noto Sans JP、`zh-Hans` → SC、`zh-Hant` → TC、`ko` → KR、それ以外 → Noto Sans。**静的 TTF** を使う（troika は独自パーサで、woff2 と可変フォントは要確認）。サブセットは `npm run build` の中で `subset-font`（npm）により毎回作り直す。入力はその言語の全メッセージ + 物語 + UI 文言。出力は `.ttf`、各 300KB 以下
- 言語を切り替えたら、文字の Text・UI・物語だけ差し替える。流体・音はそのまま

## 9. 音

- **ナレーション**：`voice.mp3`（日本語のみ、訳さない）。S3 完了 / T2 完了で再生。**`<audio>` 要素で再生する**（iOS のサイレントスイッチで Web Audio は消音されるが、`<audio>` は鳴る。要確認）。`voiceTime()` は `currentTime`。文字の出現を `messages[].at` に揃える。消音でも文字だけで成立させる
- **環境音**：Web Audio で合成。MVP は `calm` 1 つ（他は余裕があれば）。S1 では絵の位置の `PositionalAudio`、S3 以降と物語モードは全方向
- **泡**：S2 / T2 の 3 秒間、高域のノイズ（-18dB）
- **ドローン**：S2 / T2 で立ち上がり S3 / T3 冒頭で最大、その後落ち着く低い持続音
- すべて「入る」ボタンのクリック内で `AudioContext.resume()` してから開始する

## 10. 開発とデプロイ

- **Day 1 に公開**。`main` への push で GitHub Pages にビルド・配置（Actions）。独自ドメインを当てる。毎日の実機チェックは本番 URL で行う（Claude のセッションはクラウドで、LAN のサーバーは立てられない）（11-06 に変更：GitHub Pages は使わない（決定 37）。下の Cloudflare Pages）
- **配置（11-06〜）**：Cloudflare Pages プロジェクト `enter-the-painting`（サイト + `functions/`）。`npm run generate && npm run build` のあと `CLOUDFLARE_ACCOUNT_ID=<アカウント ID> npx wrangler pages deploy`（Pages の設定は `account_id` を受け付けないので環境変数で渡す）。公開先はいまは `https://enter-the-painting.pages.dev/`。独自ドメインは QR を刷る前に決める（決定 55）
- **Secret**：`npx wrangler pages secret put ANTHROPIC_API_KEY --project-name enter-the-painting`。合言葉を使うなら同じく `PASSPHRASE`（空なら照合しない）。Secret はリポジトリに書かない。入れ直したら配置し直して反映する。モデルは `wrangler.toml` の `vars.CLAUDE_MODEL`
- CI はテストとビルドだけ（`.github/workflows/ci.yml`、決定 37）
- 作家の手元では `npm run dev -- --host` + basic-ssl で LAN の HTTPS でも確認できる（Quest の自己署名証明書の扱いは要確認）
- `?debug=1` でアプリ内に fps と品質段階を表示する（Quest のブラウザに性能表示は無い）
- 生成物（`works/*/generated/`）はコミットする（1 作品あたり部屋の合成を含めて 10MB 程度）。翻訳と物語のキャッシュ（`translations.json`、`stories.json`）もコミットして API 呼び出しを繰り返さない
- 部屋の画像（`rooms/`）は一度作ってコミット。生成に使ったツールとプロンプトを `rooms/README.md` に書く

## 11. モジュールの境界（Day 1 に書き始めるための約束）

両モードが同じものを使う部分は、先にインターフェースを固定する。実装はあとから差し替えられる。

```ts
// fluid/ : GPU 流体シム。どこに描くかは知らない
interface Fluid {
  init(painting: THREE.Texture, flow: THREE.Texture, p: FluidParams, placement: PaintingRect): void;
  // placement: 等距離円筒の領域の中で、絵が占める矩形（0〜1）
  setStrength(v: number): void;            // 0〜1。S1 のかすかな流れ〜本来の強さ
  fizz(progress: number): void;            // シュワシュワ。縁からの進行 0〜1
  splat(uv: [number, number], force: [number, number], radius: number): void;
  injectFlow(region: [number, number, number, number]): void;  // 表情の切り替え
  step(dt: number): void;
  texture: THREE.Texture;                  // 色の出力。球面にも平面にも貼れる
  setQuality(q: 'high' | 'medium' | 'low'): void;
}
interface FluidParams { vorticity: number; speed: number; quality: 'high' | 'medium' | 'low'; restore: number /* 原画への回帰 */ }
interface PaintingRect { x: number; y: number; w: number; h: number }

// text/ : 文字の浮上。置き方だけ 2 種類
interface FloatingText {
  show(sentence: string, lang: Lang): Promise<void>;   // 浮上 → 滞在 → 溶けるまで待つ
  skip(): void;
  setPlacement(p: 'space' | 'screen'): void;
  setGazeDirection(dir: THREE.Vector3): void;         // space のときだけ使う
}

// audio/ : 音。すべて「入る」後に resume() 済みの前提
interface Soundscape {
  unlock(): Promise<void>;                 // 「入る」のハンドラ内で呼ぶ
  playVoice(url: string): Promise<void>;   // 終了で resolve
  voiceTime(): number;                     // 現在秒。文字の同期に使う
  ambient(preset: 'calm' | 'wind' | 'water' | 'drone' | 'none', gainDb: number): void;
  fizz(on: boolean): void;
  drone(gainDb: number): void;
  fadeOutAll(sec: number): void;
}

// 場面の状態機械。space/ と story/ がそれぞれ実装
interface Stage { enter(): void; update(dt: number): void; exit(): void }
interface StageMachine { start(): void; goto(name: string): void; current: string }

// 実行時が読む唯一の定義
interface Space {
  id: string; title: Partial<Record<Lang, string>>; size_cm: [number, number];
  painting: string; palette: string[]; text_color: string; back_color: string;
  flow: { texture: string; strength: number };
  fluid: FluidParams;
  space: { radius_m: number; melt_distance_m: number };
  audio: { voice?: string; ambient: string };
  messages: ({ at: number } & Partial<Record<Lang, string>>)[];
  rooms: { name: string; image: string; wall_width_cm: number; story?: Partial<Record<Lang, string>> }[];
  story?: Partial<Record<Lang, string>>;   // 1 作品 1 本の小さな物語（MVP）
  availability?: 'available' | 'sold' | 'not_for_sale'; contact?: string;
}
type Lang = 'ja' | 'en' | 'zh-Hans' | 'zh-Hant' | 'ko' | 'fr' | 'de' | 'es' | 'it' | 'pt';
```

守ること：`fluid/`・`text/`・`audio/` は `space/`・`story/` を import しない。逆だけ。`ui/` は両方の状態機械を起動するだけで、描画を持たない。

追記（11-04）：`FluidParams` に `drive?: number`（常時の駆動、既定 0.3）と `tempo?: number`（速さのむら、既定 0.6。`docs/EXPERIENCE.md` 8.1）。`vortex(uv, strength, radius)` は両モードの「渦が育つ」にも使う（8.2）。

## 12. 気分から絵をすすめる（`recommend/`、`functions/`。11-04 追加、11-06 Pages Functions に移す）

設計は `docs/RECOMMEND.md`。実行時に外部 API を呼ばない規則の**唯一の例外**。

（11-06：入口はギャラリーではなく受付 `/`。画面は `src/concierge/` に作り直す（E-1）。ツールの入力に `matched_moods`、合言葉の照合と `/api/recommend/config` を足す（E-4、E-5）。`docs/ENTRANCE.md` 3.1、5 節）

| 用途 | 選定 | 理由 |
| --- | --- | --- |
| API キーの置き場 | Cloudflare Pages Functions（`functions/api/recommend.js`、共通は `functions/_lib/`。設定はリポジトリ直下の `wrangler.toml`） | サイト本体と同じ Pages プロジェクト・同じ origin（`/api/recommend`）。キーは Pages の Secret（`docs/ENTRANCE.md` 6 節） |
| Claude API の呼び出し | Pages Functions から `fetch` で直接 | SDK を入れない（依存最小）。ストリーミングは SSE を中継。おすすめはツール `recommend_work`（`strict: true`）で受け取る |
| カタログ | `public/catalog.json`（`npm run generate` が作る） | ブラウザ（ルールだけの版）と Pages Functions（system prompt。同じ配信の `/catalog.json`）が同じものを読む |
| 落ちどころ | `src/recommend/rules.ts` | API 無し・オフライン・拒否で、3 問の選択肢から 3 軸の距離で選ぶ。会場でも動く |

```ts
// recommend/ : ギャラリーの入口。page.ts からは import() で読む
export function mountRecommend(section: HTMLElement, opts: { lang: Lang; api: string | null; catalogUrl: string }): void;
// rules.ts
export function recommendByRules(catalog: Catalog, answers: { time: 'morning'|'day'|'night'; color: 'warm'|'cool'|'vivid'|'soft'; mood: 'quiet'|'lively' }): { id: string; alt: string | null };
// parse.ts
export function splitRecommendation(text: string): { prose: string; json: { recommend: string; alt: string | null } | null };
// functions/_lib/prompt.js（純関数）
export function buildSystem(catalog, lang): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
export function buildBody(catalog, lang, messages, model): object;   // Messages API の本文（stream: true）
```

守ること：`recommend/` は `fluid/`・`story/`・`space/` を import しない。会話の文をどこにも保存しない（構造化した出来事と、送られた感想だけを D1 に残す。`docs/ADMIN.md`）。個人情報を聞かない（system で禁止）。
