# 絵と出会う / Meet the Painting

作家がいなくても、絵の思いに触れられるオンラインギャラリー。by SHEER（現代アーティスト しあ）

**作家がいない場所で、絵の魅力を伝えるのは難しい。** 在廊していない展示でも、オンラインでの販売でも同じです。見る人にとっても、抽象画はどう見ていいのかわかりにくく、家具を選ぶように選んでしまいがちです。込めた思いに共感して、長く一緒に暮らせる一枚に出会ってほしい。そのために、個展で作家がしていることをオンラインで受け持ちます。

| 個展での作家 | ここで | 機能 |
| --- | --- | --- |
| 話を聞いて、絵をすすめる | 出会う | 案内役との会話（Claude API） |
| 込めた思いを語る | 知る | 作品の一文、作家の言葉（10 言語） |
| 絵の前で一緒に過ごす | 浸る | 絵の世界（GPU 流体。PC・スマホ・VR） |
| 飾る場所を一緒に考える | 暮らしを想像する | 部屋で見る、絵を動かす（部屋は AI 生成、絵は実物の写真） |

考え方の正は [docs/CONCEPT.md](docs/CONCEPT.md)。旧名は Enter the Painting（古い GitHub の URL は転送される）。Cloudflare Pages のプロジェクト名は `enter-the-painting` のまま（改名の機能が無いため）。

## 権利

コードは MIT（`LICENSE`）。`works/` の絵・声と `rooms/` の部屋画像は作家の著作物で、権利を留保します。第三者のフォントと手法の出典は `THIRD_PARTY.md`。

## 状態

**公開中**：https://meet.sheerarts.com/ （Cloudflare Pages + Pages Functions。旧 URL の enter-the-painting.pages.dev も動く。AI ハッカソン提出に向けて作り込み中）。計画は `docs/`、作業ログは `docs/LOG.md`、決めたことは `docs/DECISIONS.md`。

### いま動いているもの（11-07）

- **受付 `/`**：キャラクター（作家のメタファーの女の子、Codex 生成）との会話。最初はボタン 3 つ＋「自分のことばで書く」。2〜3 往復で「今日のあなたへの 1 点」をカードで差し出す（くるんと回って現れる）。会話は Pages Functions `/api/recommend` → Claude API（ツール `recommend_work`）。会話の文は保存しない。キャラクターの後ろは、同じ世界観のイラストの「絵のあるカフェ」（壁の絵は実物の写真を合成）
- **ギャラリー `/gallery/`**：白い壁に 6 点を実寸比で。スマホは幅いっぱい
- **作品ページ `/w/<id>/`**：絵、作家の言葉、「絵の世界をのぞく」。題名は日本語では日本語を大きく、それ以外の言語では英語を大きく（10 言語）
- **絵の中（物語モード、PC・スマホ）**：絵が溶け出して流体になり、作家の言葉が流れ、静かに元の絵へ戻る。流れの性格は作品ごと（`docs/FLUID_PER_WORK.md`。頂は渦になって落ち着く、New Chapter は粒が跳ねる、花は滲む）
- **VR（Quest のブラウザ）**：空間モード。3 層（絵の層・手前の粒・奥の光）と床の反射（`docs/VR_DEPTH.md`）。実機は未確認
- **部屋で見る**：AI 生成の部屋に実物の写真を射影合成（絵は生成モデルに入れない）。小さな絵は壁に掛けず、机やサイドボードの**卓上イーゼル**、棚への**立てかけ**で置く（`docs/PLACEMENT.md` 6 節）。暗い部屋は使わない。拡大表示では**絵をドラッグして部屋の中で動かせる**（大きさは縮尺のまま。壁の範囲だけ、家具の手前には出ない）
- **感想チャットと管理ページ**：絵を見たあとに案内役が「この絵は気に入った？」と聞く。「作家に届ける」を押した文だけが作家の `/admin/`（ID とパスワード）に届く。会話の流れは、押した選択肢やストックの問いなど構造化した出来事だけで見る（[docs/ADMIN.md](docs/ADMIN.md)、訪れる人への説明は `/data-note.html`）
- **計測**：会話の回数と作品ごとの閲覧を KV で数える（`/stats.html`。今後の主は `/admin/`）。Cloudflare Web Analytics
- **SNS カード・ファビコン**：`npm run generate` が合成（白い壁に 6 点、作品ごとの 1 点）
- **提出動画**：`_meta/development/enter-the-painting/video/v4/`（2:59、BGM「花を手向ける」、字幕入り。声は未収録）

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

Vite + TypeScript + three.js（WebXR）。GPU 流体（MacCormack + 原画への回帰、拡散 0）。生成パイプラインは Node スクリプト（sharp）。置き場は Cloudflare Pages（サイト + Pages Functions、KV）。受付の会話だけ Claude API（`claude-sonnet-5-5`）。詳細は `docs/ARCHITECTURE.md`。
