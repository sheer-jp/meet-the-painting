# CLAUDE.md

**絵と出会う / Meet the Painting**（旧 Enter the Painting）。作家がいない場所で絵の魅力を伝えるオンラインギャラリー。案内役との会話で一枚に出会い、絵の世界（WebXR）に浸る。考え方の正は `docs/CONCEPT.md`。AI ハッカソンの提出作。

## まず読む（毎回、この 5 つだけ）

- `docs/LOG.md`：作業ログ。先頭の「次にやる」
- `docs/TASKS.md`：当日のタスク。ID を挙げて進める
- `docs/EXPERIENCE.md`：体験仕様。VR の空間モード（S1〜S5）、PC・スマホの物語モード（T0〜T5）、部屋で見る。迷ったらここ
- `docs/CONCEPT.md`：コンセプト（なぜ作るか、どう伝えるか。文言を書く前に）
- `docs/ENTRANCE.md`：入口の設計（正）。受付（C）→ ギャラリー（G）→ 作品ページ（S0）。キャラクター、スマホ、配線、合言葉

## 必要なときに読む

- 実装するとき：`docs/ARCHITECTURE.md`（技術選定、モジュールの境界。ここに無い技術を足すときは理由を docs に書く）、`docs/REQUIREMENTS.md`（要件 ID と受け入れ条件）、`docs/WORK_FORMAT.md`（作品定義ファイル）
- 技術的に詰まったとき：`docs/SPIKES.md`（検証と逃げ道、記録欄）、`docs/RISKS.md`
- 体験や機能を決めるとき：`docs/USERS.md`（誰のどの悩み）、`docs/JOURNEY.md`（離脱点と交差点）、`docs/DECISIONS.md`（決定と未決定）
- 全体を見直すとき：`docs/PLAN.md`、`docs/SCHEDULE.md`、`docs/CHANGELOG.md`
- 作家向け：`docs/CONTENT.md`（撮影、メッセージ、声、部屋のイメージ）、`docs/PITCH.md`（提出）
- ページの見た目を触るとき：`docs/DESIGN.md`（トーン＆マナー。色、書体、レイアウト）
- 作業の型：`docs/ROUTINE.md`

## 役割分担（作家の指示）

- **設計・判断・レビューは Fable（このセッションのモデル）が行う**：仕様、設計書、受け入れ条件、レビュー、作家との対話
- **実装は Opus や Sonnet に振る**：Agent ツールで、1 タスク 1 エージェント（`model: "opus"` か `"sonnet"`）。渡すものは、タスク ID、該当する docs の節、変えてよいファイル、完了の条件、テストの通し方。戻ってきたら Fable がレビューして `/close`
- 小さな修正（数行）や、docs の更新は Fable が直接やってよい
- **エージェントが作業中は `git add -A` を使わない**。自分が変えたファイルだけをパスで指定してコミットする（作業中のコードが混ざった事故があった）

## ルーチン（毎回）

- 作業の最初に `docs/LOG.md` の「次にやる」と `docs/TASKS.md` の当日分を読む。タスク ID を挙げて進める
- 実装は `docs/ARCHITECTURE.md` の「モジュールの境界」のインターフェースに従う。変えるなら docs を先に変える
- 体験や機能を決めるときは `/dig` で「誰のどの悩みに効くか」を確かめてから作る
- 作業の最後は必ず `/close`（テスト → `/code-review` → `/log` → コミット → push）。飛ばした手順はログに理由を書く
- 実機チェック（PC / スマホ / Quest）は毎日 1 回。結果は `docs/LOG.md` と `docs/USERS.md` の記録欄に書く

プロジェクトのスキル：`/log`（ログ追記）、`/close`（終わりのルーチン）、`/dig`（悩みの深掘り）。`.claude/skills/` にある。

## 作業ルール

- **作家の絵を変えない**。流体にして流しはするが、画像生成 AI で描き足さない。絵の画像を生成モデルに入れない（部屋の画像の生成は可。絵は実物の写真を射影で合成）。拡散 0、色の減衰 0（濁らせない）
- 実行時は `works/<id>/generated/space.json` だけを読む。解析と翻訳はすべて `npm run generate` に寄せ、実行時に外部 API を呼ばない。**例外**は 3 つ。1 つ目は受付の会話（「気分から絵をすすめる」。`src/concierge/`・`src/recommend/` → `functions/` の Cloudflare Pages Functions `/api/recommend` → Claude API。`docs/ENTRANCE.md`、`docs/RECOMMEND.md`。11-06 に `worker/` から移した）。会話の文は保存しない（残すのは、押した選択肢や問いのストックなど構造化した出来事を 180 日と、訪れた人が「作家に届ける」を押した感想だけ。`docs/ADMIN.md`）。個人情報は聞かない。API が無ければルールだけの版で成立させる。2 つ目は感想カードの返事（`/api/followup`）で、これも無くても定型文で成立させる。3 つ目は販売状況（`/api/works-status`。sheerarts.com の中継で、取れなければ何もしない）。管理ページの認証は外に問い合わせない（ID とパスワード。`docs/ADMIN.md` 5 節）
- モードは 2 つ。VR は空間（`space/`）、PC・スマホは物語（`story/`）。流体（`fluid/`）・文字（`text/`）・音（`audio/`）は両モードから同じ API で使い、モードで分岐させない
- 場面の遷移（S0〜S5、T0〜T5）はそれぞれの状態機械だけが決める。数値は `docs/EXPERIENCE.md` から取り、変えたら docs も変える
- 部屋のイメージと小さな物語には「AI 生成のイメージ」「物語」と明記し、実在の部屋・出来事と誤認させない
- 音声の開始・ジャイロ許可・XR セッション開始は、必ずユーザー操作（「入る」ボタン）のハンドラ内で行う
- 文字は閲覧者の母語。言語は端末の言語で自動判定し、選ばせない（切り替えはできる）
- 性能の上限：流体の領域は等距離円筒 2:1、品質 high で色 2048×1024 / 速度 512×256、圧力反復 20 回、Quest で 72fps。超えるなら相談
- 数値拡散の対策（MacCormack + 原画への回帰）を外さない。3 分後も構図が残ること
- 声は `<audio>` 要素。消音でも文字だけで成立させる
- フォールバック（静止画モード）を壊さない。`prefers-reduced-motion` を尊重する
- VR のカメラは S2〜S5 で動かさない（酔い対策）。絵の方が動く
- 作品ページは JS を待たずに絵が出る。ページ用 JS は gzip 20KB 以下、体験バンドルは「入る」後に `import()` で gzip 300KB 以下
- 依存は最小に。React などの UI フレームワークは入れない
- コードのコメントと UI 文言は日本語。識別子は英語

## コマンド

```bash
npm install
npm run generate [-- <id>]   # works/<id>/ から流れ場・主要色・翻訳・部屋の合成・QR・作品ページを生成（全作品 or 1 作品）
npm run dev                  # LAN の HTTPS で開発（https://<PCのIP>:5173/w/<id>/）。スマホ / Quest から確認
npm run build                # 静的ビルド（dist/）。generate のあとに
npm test                     # 単体テスト（vitest）
npm run smoke                # ビルド済みの dist を Playwright で確認（作品ページ → 入る → 物語モード、静止画モード、ギャラリー）
npm run typecheck            # tsc
node tests/longrun.mjs <dir> # 流体の長時間の構図の残り方をスクリーンショットで見る
BASE_URL=https://... npm run generate   # QR と OGP の URL（Actions では vars.BASE_URL）
ANTHROPIC_API_KEY=... npm run generate  # 翻訳と小さな物語の下書きも生成（既定モデルは claude-sonnet-5-5。CLAUDE_MODEL で変更）。クラウドのセッションでは ANTHROPIC_API_KEY が空にされるので、環境変数 ENTER_CLAUDE_API_KEY に入れる（同じ扱い）
CLOUDFLARE_ACCOUNT_ID=<アカウント ID> npx wrangler pages deploy   # generate と build のあと。Cloudflare Pages に配置（サイト + functions/）。account_id は環境変数で
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name enter-the-painting   # 受付の API キー（Pages の Secret。リポジトリに書かない）。合言葉は PASSPHRASE（空なら照合しない）。入れ直したら配置し直す
```

生成物は `works/<id>/generated/`（コミットする）、ページは `w/<id>/index.html` と `index.html`（生成物。コミットしない。Actions が作る）。（11-06：ギャラリーは `gallery/index.html` も生成。公開は Actions ではなく `wrangler pages deploy`）

## コードの場所

- `scripts/generate/`：生成パイプライン（JS）。`color.js` 主要色、`flow.js` 流れ場、`rooms.js` 射影合成、`translate.js` 翻訳キャッシュ、`claude.js` Claude API、`pages.js` HTML
- `src/page.ts`：作品ページの小さなスクリプト（言語、入る、共有）。`src/experience/main.ts`：「入る」後に読む体験の入口
- `src/fluid/`：GPU 流体。`src/story/`：物語モード。`src/space/`：VR 空間モード。`src/text/`：文字の浮上。`src/audio/`：音。`src/i18n/`：言語
- `src/recommend/`：気分から絵をすすめる（ルールだけの版）。`src/concierge/`：受付の画面（11-06〜、E-1）。`functions/`：Cloudflare Pages Functions（`api/recommend.js` が Claude API の中継、`_lib/` が共通。11-06 に `worker/` から移した。`worker/` は使わない）。`scripts/generate/catalog.js` → `public/catalog.json`。キャラクターの画像は `public/concierge/`
- `src/followup/`：感想カード（`trigger.ts` がいつ出すか、`index.ts` が本体で `import()`）。`public/admin/` と `functions/api/admin/`：作家の管理ページ（ID とパスワード）。`migrations/`：D1 の表。`docs/ADMIN.md` が正
- `tests/`：`generate.test.ts`（単体）、`smoke.mjs`（Playwright）、`longrun.mjs`

## 状態

2026-11-03：Day 1〜2 相当を実装。生成パイプライン、GPU 流体（等距離円筒、MacCormack、原画回帰、シュワシュワ）、物語モード（T0〜T5、文字、音、一時停止、静止画フォールバック）、VR 空間モード（S1〜S5。実機未確認）、作品ページとギャラリー、10 言語の UI、Playwright のスモーク。GitHub Pages は作家が Settings で有効化する必要あり。サブドメインは `enter.sheerarts.com` を提案中。リモートは https://github.com/sheer-jp/meet-the-painting（public、11-07 に改名）。

2026-11-06：入口を作り直し中（`docs/ENTRANCE.md`、タスク E）。受付が先、白い壁のギャラリー `/gallery/`、Worker → Pages Functions とツール `recommend_work`（済）。置き場は Cloudflare Pages（https://meet.sheerarts.com/ 。プロジェクト名は enter-the-painting のまま、旧 pages.dev も動く。GitHub Pages は使わない）。D5-2 は取り下げ。
