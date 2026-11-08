# Meet the Painting

語りかけるオンラインギャラリー（日本語の呼び名は「絵と出会う」）

作家がいなくても、絵に込めた想いに触れられるオンラインギャラリー。オンラインでも、展示の会場（絵の横の QR）でも使えます。by SHEER（現代アーティスト しあ）

**作家がいない場所で、絵の魅力を伝えるのは難しい。** 在廊していない展示でも、オンラインでの販売でも同じです。見る人にとっても、抽象画はどう見ていいのかわかりにくく、家具を選ぶように選んでしまいがちです。込めた思いに共感して、長く一緒に暮らせる一枚に出会ってほしい。そのために、個展で作家がしていることをオンラインで受け持ちます。

| 個展での作家 | ここで | 機能 |
| --- | --- | --- |
| 話を聞いて、絵をすすめる | 出会う | 作家のキャラクターとの会話（Claude API） |
| 込めた思いを語る | 知る | 作品の一文、作家の言葉（10 言語） |
| 絵の前で一緒に過ごす | 浸る | 絵の世界（GPU 流体。PC・スマホ・VR） |
| 飾る場所を一緒に考える | 暮らしを想像する | 部屋で見る、絵を動かす（部屋は AI 生成、絵は実物の写真） |

考え方の正は [docs/CONCEPT.md](docs/CONCEPT.md)。旧名は Enter the Painting（古い GitHub の URL は転送される）。Cloudflare Pages のプロジェクト名は `enter-the-painting` のまま（改名の機能が無いため）。

## 権利

コードは MIT（`LICENSE`）。`works/` の絵・声と `rooms/` の部屋画像は作家の著作物で、権利を留保します。第三者のフォントと手法の出典は `THIRD_PARTY.md`。

## 状態

**公開中**：https://meet.sheerarts.com/ （予備：https://enter-the-painting.pages.dev/ 。Cloudflare Pages + Pages Functions + D1 + KV + R2）。提出動画：https://enter-the-painting.pages.dev/demo/ （2:57、ナレーション VOICEVOX:ずんだもん）。Built with Claude: Japan 2026 の提出作。計画は `docs/`、作業ログは `docs/LOG.md`、決めたことは `docs/DECISIONS.md`。

### いま動いているもの（11-08）

- **扉と受付 `/`**：扉が開くと、作家のミニキャラが手を振って迎え、受付のキャラクターに入れ替わる（`docs/ENTRANCE.md` 3.7）。気持ちを話すと、まず受け止め、問いを重ねて、今のあなたにすすめたい 1 点を選ぶ。会話は Pages Functions → Claude API（ツール `recommend_work`）。会話の文は保存しない。どの端末でもスクロールなしで最初の選択肢が全部見える
- **展示の会場**：絵の横に貼るキャプションを `/exhibit/` から印刷。QR を読み取ると、その絵の作品ページから絵の中へそのまま入れる
- **ギャラリー `/gallery/`**：白い壁の展示室に 6 点を実寸比で
- **作品ページ `/w/<id>/`**：絵、絵に込めた想い、「絵の世界をのぞく」。10 言語
- **絵の中（物語モード、PC・スマホ）**：絵が溶け出して流体になり、作家の言葉が浮かび、元の絵へ戻る。流れ方は絵ごと（`docs/FLUID_PER_WORK.md`）
- **VR（Quest のブラウザ）**：空間モード（`docs/VR_DEPTH.md`）。実機は未確認
- **部屋で見る**：AI 生成の部屋に実物の写真を射影合成（絵は生成モデルに入れない）。実物大の計算は基準物の画素から（`docs/SCALE.md`）。絵をドラッグして動かせる。「ほかの部屋でも見る」
- **購入**：作品ページから Stripe の支払いリンクへ。国内は着払い、海外は送料確定後に Stripe の請求
- **感想と管理ダッシュボード**：見たあとにキャラクターが感想を聞き、「作家に届ける」を押した文だけが `/admin/` に届く。ダッシュボードで訪れた人、受付からの流れ、日ごとの推移、絵ごとの数、会場の QR、感想、会話の流れを見る（`docs/ADMIN.md`）
- **作品の登録（管理画面）**：会話で題名・大きさ・値段・想いを聞き取り、確認カードから下書きに。Mac の `npm run publish-drafts` で生成・確認・配置まで（`docs/REGISTER.md`。Managed Agents と Stripe の MCP での自動化は次の段）

### Claude Code での作り方（7 日間）

- **役割の分担**：設計・判断・レビューは Fable、実装は Opus・Sonnet のサブエージェント（`CLAUDE.md`）。1 作業 = 1 ブランチ = 1 worktree で並行に作り、統合の枝 `integrate` で取り込む
- **検証も別のエージェントに**：コードレビューと、全ページ×11 の画面サイズ×2 ブラウザの「全ボタンを押す」QA を独立したエージェントが行い、見つけた不具合を別のエージェントが直す。スモーク 302 項目と単体テスト 400 件超を毎回通してから配置
- **Skills と MCP**：`/dig`（誰のどの悩みに効くか）、`/close`（テスト→レビュー→ログ→push）、`/log`。Playwright と Chrome で実物の画面を確かめ、Cloudflare と Stripe の設定もブラウザから
- **アプリの中の Claude**：受付の会話（tool use で 1 点を選ぶ）、感想への返事、作品の登録の聞き役（項目ごとの道具を型で縛る）、10 言語の翻訳と小さな物語の下書き

### コマンド

```bash
npm install
npm run generate     # works/<id>/ から流れ場・主要色・翻訳・部屋の合成・QR・OGP・作品ページを生成
BASE_URL=https://meet.sheerarts.com npm run generate   # 配置する前はこちら（QR・OGP の URL を配置先に）
npm run dev          # https://localhost:5173/ （LAN の HTTPS。スマホ / Quest から確認）
npm test && npm run build && npm run smoke
CLOUDFLARE_ACCOUNT_ID=<アカウント ID> npx wrangler pages deploy   # generate と build のあと。Cloudflare Pages に配置（サイト + functions/）
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name enter-the-painting   # 受付の API キー（合言葉を使うなら PASSPHRASE、計測の閲覧に STATS_KEY）
node scripts/translate-fill.mjs --list   # API キーなしで訳を埋めるとき（Claude Code が訳す）
```

### 作品を足すとき

`works/<id>/` に写真と `work.json`（題名、寸法、作家の言葉、気分）を置いて `npm run generate`。流れ場・部屋の合成・翻訳・QR・SNS カード・作品ページが生成され、ギャラリーと受付のカタログに載る（`docs/WORK_FORMAT.md`、`docs/ROUTINE.md`）。部屋を足すときは `rooms/README.md`（画像は Codex で生成、`rooms/PROMPTS.md`）。

| ドキュメント | 内容 |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | 何を・誰のために・なぜ作るか、スコープ、完成の定義 |
| [docs/EXPERIENCE.md](docs/EXPERIENCE.md) | 体験仕様。VR の空間モード、PC・スマホの物語モード、部屋で見る。数値と受け入れ条件 |
| [docs/ENTRANCE.md](docs/ENTRANCE.md) | 入口の設計（正）。受付の会話 → ギャラリー空間 → 絵の中へ。キャラクター、スマホ、配線、合言葉、受け入れ条件 |
| [docs/WORKS_VOICE.md](docs/WORKS_VOICE.md) | 作品ごとの作家の語り（11-06 口述、原典）。`work.json` の messages / moods の元 |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | 要件定義。ID、課題・人・場面との対応、優先度、受け入れ条件 |
| [docs/JOURNEY.md](docs/JOURNEY.md) | ユーザージャーニー。来場者・オンラインの人・持ち主・海外の人・作家の 5 つの旅 |
| [docs/TASKS.md](docs/TASKS.md) | タスク分解。日ごとに 2〜4 時間の単位、誰が、依存、完了の条件 |
| [docs/SPIKES.md](docs/SPIKES.md) | 技術検証。最初に潰す不安 8 つと逃げ道 |
| [docs/CONTENT.md](docs/CONTENT.md) | コンテンツ計画。作品の選び方、撮影、メッセージ、声、部屋のイメージ、UI 文言、音 |
| [docs/PITCH.md](docs/PITCH.md) | 提出と見せ方。ピッチ構成、デモ動画の絵コンテ、想定質問 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 決めたこと（理由つき）と未決定（期限つき） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 技術選定、構成、流体と変形、生成パイプライン、3 環境の入力切替、言語 |
| [docs/WORK_FORMAT.md](docs/WORK_FORMAT.md) | 作品定義ファイル（`works/<id>/work.json`）の仕様 |
| [docs/SCHEDULE.md](docs/SCHEDULE.md) | 7 日間の日程とマイルストーン |
| [docs/RISKS.md](docs/RISKS.md) | リスクと逃げ道 |
| [docs/USERS.md](docs/USERS.md) | 誰のどの悩みに効くか（登場人物、仮説、聞き方、記録） |
| [docs/ROUTINE.md](docs/ROUTINE.md) | 作業ルーチン（テスト → レビュー → ログ → コミット） |
| [docs/FLUID_PER_WORK.md](docs/FLUID_PER_WORK.md) | 絵ごとの流体の性格（語りから数値へ） |
| [docs/VR_DEPTH.md](docs/VR_DEPTH.md) | VR の立体感（3 層、光、床） |
| [docs/PLACEMENT.md](docs/PLACEMENT.md) | 部屋のどこに、どう置くか（掛ける／置く、縮尺） |
| [docs/VIDEO.md](docs/VIDEO.md) | 提出動画の構成と字幕 |
| [docs/LOG.md](docs/LOG.md) | 作業ログ |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 計画の変更履歴（V1 → V2） |
| [CLAUDE.md](CLAUDE.md) | Claude Code 向けの作業ルール |

## 技術

Vite + TypeScript + three.js（WebXR）。GPU 流体（MacCormack + 原画への回帰、拡散 0）。生成パイプラインは Node スクリプト（sharp）。置き場は Cloudflare Pages（サイト + Pages Functions、KV）。Claude API（`claude-sonnet-5-5`）は受付の会話、感想への返事、作品の登録の聞き役、生成時の翻訳に使う。詳細は `docs/ARCHITECTURE.md`。
