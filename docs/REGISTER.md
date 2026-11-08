# 作品の登録（管理画面から、会話で）設計 v2

11-08 作家「管理画面から絵をアップロードすると API が動いて登録できるといい。チャット形式くらいで登録したい」「Claude API を使えばいいのでは」「支払いリンクも MCP で追加できるように。一番いい形にして任せた」。この文書は設計で、方針は作家から一任されたので、9 節に決めたことを書く。R1・R2 は 11-08 に作った（13 節「実装の記録」。本番にはまだ出していない）。

## 1. いまの登録と、変えるところ

いまは、作家（か Claude Code）が次を手で行っている。

1. `works/<id>/painting.jpg` と `work.json` を置く（`docs/WORK_FORMAT.md`）
2. `npm run generate -- <id>`：流れ場、主要色、部屋の合成、QR、翻訳、物語の下書き、作品ページ
3. Stripe で支払いリンクを作り、`work.json` の `buy.url` に貼る
4. `npm run build` → 確認 → `wrangler pages deploy` → Git に上げる

2 は `sharp`（画像処理の部品）を使い、数分かかる。Cloudflare の Functions の中では動かない。そこで次の 2 段に分ける。

- **会話で下書きを作る**：Cloudflare（管理画面と Functions）＋ Claude API
- **生成して公開する**：Claude Managed Agents（Anthropic が用意する入れ物の中で Claude が作業する仕組み）。同じ中身を Mac の 1 コマンドでも動かせるようにして、予備にする

## 2. 全体の流れ

```
作家（管理画面「作品を登録」。スマホでも PC でも）
  │ 写真を選ぶ → 会話で項目を埋める → 確認カード → 「公開する」
  ▼
Cloudflare Pages Functions（/api/admin/works/*）
  │ 写真は R2、下書きは D1（work_drafts）
  │ 会話は Claude API（Sonnet 5.5、tool use。写真は送らない）
  │ 「公開する」で Managed Agents のセッションを始める（写真は Files API で渡す）
  ▼
公開の係（Claude Managed Agents。リポジトリを入れ物に取り込み済み）
  │ 1. Stripe の MCP で商品・価格・支払いリンクを作る（すでにあれば使い回す）
  │ 2. scripts/publish-draft.mjs：works/<id>/ を書く → generate → 単体テスト → build → 軽い確認
  │ 3. main にコミットして push → Cloudflare Pages に配置
  │ 4. 結果を書いたファイルを出して終わる
  ▼
Anthropic → 管理 API への webhook（セッションが終わった知らせ）→ D1 の状態を更新
  ▼
管理画面に「公開しました」と、作品ページ、部屋の合成、QR、展示用キャプション、支払いリンクが出る
```

公開の係は、決まった手順のスクリプトを動かすのが仕事で、内容を考えて変える役ではない。スクリプトが止まったら、直そうとせずに止まった理由を書いて終わる（勝手に直して公開しない）。

## 3. 会話（登録の聞き役）

受付の案内役とは別の、作家のための聞き役。Claude API（Sonnet 5.5）を Functions から呼ぶ。口調は短く、1 回に 1 つだけ聞く。答えにくいものは「あとで」で飛ばせる。

| 順 | 聞くこと | 埋まる項目 | 確かめること |
| --- | --- | --- | --- |
| 1 | 写真を選んでください | `painting.jpg` | 長辺 1600px 以上、JPEG／PNG／HEIC、15MB まで。ブラウザで長辺 2000px に縮めてから送る。90 度回転だけその場で直せる |
| 2 | この絵の名前は？ 英語の名前もあれば | `title.ja`、`title.en` | 空なら先に進まない。英語は任意（無ければ訳） |
| 3 | 描いた年は？ | `year` | 4 桁の数 |
| 4 | 大きさは？（号でも cm でも） | `size_cm`、号の表示 | 「F15」なら 65.2 × 53.0、縦横は写真の向きから決める。写真の縦横比と 5% 以上違えば「写真の端が切れていませんか」と聞き直す |
| 5 | 何に描きましたか？ | `medium.ja`（`en` は訳） | 例を 3 つ出す（キャンバスにアクリル、シナベニヤにミクストメディア…） |
| 6 | 値段と、いま買える状態か | `buy.price_jpy`、`availability` | 税込の円。「売れた」「非売品」も選べる。非売品なら支払いリンクは作らない |
| 7 | この絵に込めた想いを、話すように教えてください | `messages`（3〜10 文、1 文 40 字以内）の下書き | 作家の言葉から聞き役が文を整えて並べる。**作家の言葉に無いことは足さない**。並べた文を作家が直して「これでいい」を押すまで確定しない |
| 8 | どんな気分の人に見てほしいですか | `moods.ja`（3〜5 語）、`moods.fit` | 受付の案内役がおすすめの手がかりにする。下書きを出して作家が選ぶ |
| 9 | 確認カード | すべて | 作品ページの見え方、展示用キャプション、寸法、値段、「支払いリンクを作ります（○○円）」を 1 枚で見せる。「直す」で該当の質問へ戻る |

- 聞き役は tool use で、項目ごとの道具（`set_title`、`set_size`、`set_price`、`propose_messages` …）だけを呼べる。道具の入力は型で縛り、サーバー側でもう一度確かめる。会話の文から事実（年、寸法、値段）を推測して埋めない。作家が言ったことだけを入れる
- 支払いリンクは、作家が Stripe で作って貼る必要はない。公開の係が作る（5 節）。すでに作ってあるリンクがあれば、貼れば使い回す
- 写真は聞き役（Claude）に送らない。気分の言葉の下書きに色を使うときは、ブラウザで写真から主要色を数色取り、色の値（#c23a2b など）だけを文として渡す
- 部屋は大きさから自動で選ぶ（`rooms/*.json` の `suits_cm`）。作家は選び直せる
- 物語（小さな物語）は今どおり生成で下書きし、作家が管理画面で読んで「公開する」を押すまで出さない（`story_approved`）
- 会話の途中で閉じても、下書きは D1 に残る。次に開くと続きから

## 4. 保存するもの

| 置き場 | 中身 | 消すとき |
| --- | --- | --- |
| R2（新しく足す。`WORK_UPLOADS`） | 下書きの写真（縮めたもの） | 公開して Git に入ったら 30 日後、下書きを捨てたらすぐ |
| D1 `work_drafts`（新しい表） | id、状態（draft／queued／building／published／failed）、work.json の中身（JSON）、写真の鍵、Stripe の商品・価格・リンクの id、公開の記録（セッション id、コミット、デプロイ、失敗したときの最後の 40 行） | 公開して 90 日後に記録だけ残して中身を消す |
| Anthropic の Files API | 公開の係に渡す写真 | セッションが終わったら消す |

会話の文は保存しない（今の方針どおり）。保存するのは項目の値と、確定した文だけ。

## 5. 公開の係（Claude Managed Agents）

### 5.1 作り

| 部品 | 中身 |
| --- | --- |
| エージェント（1 回作って使い回す） | モデルは Sonnet 5.5。道具は bash・読む・書く（入れ物の中だけ）。MCP は Stripe だけ。システムの指示：決まった手順だけを動かす、写真を読み込んで見ない、止まったら直さず理由を書いて終わる |
| 環境 | 入れ物（Anthropic が用意）。通信は `limited`：npm、GitHub、`api.cloudflare.com`、Stripe の MCP だけ |
| リポジトリ | `sheer-jp/meet-the-painting` を取り込む。GitHub のトークンは入れ物の中に入らず、Anthropic 側で付けられる（このリポジトリの書き込みだけの細かい権限のトークン） |
| 鍵の置き場（vault） | `CLOUDFLARE_API_TOKEN`（Pages の編集だけ）、`ANTHROPIC_API_KEY`（翻訳と物語の下書き用）、Stripe の MCP の鍵。どれも入れ物の中には「仮の値」しか見えず、外へ出る通信のときに本物に差し替わる。決められた宛先にしか使えない |
| 写真 | Files API で 1 セッションだけ渡す。終わったら消す |
| 終わりの知らせ | Anthropic の webhook を `/api/admin/works/hook` で受ける（署名を確かめる）。結果は入れ物の `/mnt/session/outputs/result.json` |

### 5.2 Stripe（支払いリンク）

- Stripe の公式の MCP を使う。鍵は**制限付きの鍵**（restricted key）で、商品・価格・支払いリンクの作成と読み取りだけ。返金、顧客、入金の操作はできない
- 作るもの：商品（題名、作品の写真は付けない）、価格（税込の円、1 点）、支払いリンク（数量 1、住所の入力あり、送料の文言は今の Stripe の文言「国内：送料は着払いです…／海外：送料が確定したら…」をカスタムテキストに入れる、完了画面の文）。メタデータに作品の id を入れる
- 使い回し：同じ作品の id の商品があれば作らない。値段が変わったときは新しい価格とリンクを作り、古いリンクは無効にする（消さない）
- 確かめ：作ったリンクを読み直し、金額と商品名が確認カードと同じかを照らす。違えば公開せずに止まる
- 最初はテストモードの鍵で通しで試し、作家が 1 回確かめてから本番の鍵に替える

### 5.3 公開の手順（`scripts/publish-draft.mjs`）

1. 下書き（API から公開専用のトークンで読む）と写真を受け取る
2. `works/<id>/work.json` と `painting.jpg` を書く。支払いリンクを `buy.url` に入れる
3. `npm ci` → `npm run generate -- <id>` → `npm test` → `npm run build` → 作品ページと部屋の帯が開くかの軽い確認
4. `works/<id>/` だけをパス指定でコミットして main に push（`git add -A` は使わない）
5. `wrangler pages deploy`（`CLOUDFLARE_ACCOUNT_ID` は設定に書く）
6. `result.json`：状態、作品ページの URL、コミット、デプロイの URL、支払いリンク、かかった時間。どこかで止まったら、コミットもデプロイもせず、止まった段と最後の 40 行を書く

同じスクリプトを Mac で `npm run publish-drafts` としても動かせる（予備。Managed Agents が使えないとき）。

### 5.4 なぜこの形か

- スマホだけで、写真を撮るところから公開まで終わる
- GitHub Actions を足さない（課金のガードレールに触れない。決まりごとの承認も要らない）
- 鍵は入れ物の中に置かれず、宛先も絞れる
- 手順はスクリプトに固定し、Claude には「動かして結果を報告する」役だけを持たせるので、毎回同じ結果になる。Stripe の操作だけは MCP で Claude に任せ、作ったあとに金額を照らし合わせる

## 6. 管理画面の見え方

- ダッシュボードの上に「作品を登録」と「作品の一覧」のタブを足す
- 「作品を登録」：左に会話、右に確認カード（スマホは会話の下にカード）。項目が埋まるたびにカードが育つ
- 公開中は段階を出す（支払いリンク → 生成 → 確認 → 配置）。終わったら作品ページ、部屋の合成、QR、展示用キャプション、支払いリンク
- 「作品の一覧」：今の作品と下書き。直す（同じ会話を、今の値を入れた状態で始める）、売れた・値段・リンクの変更は再生成なしで反映（11 節）

## 7. 安全

- 管理の認証（ID とパスワード、HMAC の Cookie、同じ origin からの書き込みだけ）をそのまま使う
- 写真：種類を中身で確かめる（拡張子を信じない）、15MB まで、位置情報（EXIF）を消す
- id（URL になる）は英語の題名から作り、作家が確認する。今の作品と重なれば番号を付ける
- 公開専用のトークンは、下書きを読む・結果を書く、の 2 つしかできない
- 公開は 1 件ずつ（同時に 2 つ走らせない）。1 日 5 件まで（Claude API と Managed Agents の使いすぎを防ぐ）
- 支払いリンクは確認カードで金額を見せたうえで「公開する」を押したときだけ作る
- 戻すとき：その作品のコミットを revert して配置し直す。支払いリンクは Stripe で無効にする

## 8. 作る順（目安）

| 段 | 中身 | できること |
| --- | --- | --- |
| R1 | D1 の表、R2、写真のアップロード、会話（項目の道具）、確認カード、下書きの保存 | 管理画面で下書きまで作れる |
| R2 | `scripts/publish-draft.mjs` と Mac の 1 コマンド | 公開の手順が固まる（予備の道にもなる） |
| R3 | Managed Agents の公開の係、webhook、進み具合の表示 | スマホから公開まで完結 |
| R4 | Stripe の MCP（テストモードで通し → 本番の鍵） | 支払いリンクも自動 |
| R5 | 作品の一覧、直す、売れた（再生成なし）、物語の確認と公開 | 登録後の手入れが管理画面で済む |

## 9. 決めたこと（11-08、作家から一任）

1. **公開**：Claude Managed Agents の公開の係で行う。同じスクリプトを Mac の 1 コマンドでも動かせるようにして予備にする（前の版の「GitHub Actions」は使わない）
2. **写真**：会話の聞き役（Claude）には送らない。公開の係には Files API で渡すが、スクリプトの画像処理（sharp）が使うだけで、係の指示で「読み込んで見ない」とする。気分の言葉の下書きには、ブラウザで取った色の値だけを渡す
3. **想いの文**：作家の話した言葉を聞き役が 3〜10 文に整え、作家が直して確定する。作家の言葉に無いことは足さない
4. **支払いリンク**：公開の係が Stripe の MCP で作る。制限付きの鍵、テストモードで通してから本番、作ったあとに金額を照らす
5. **公開前の確認**：毎回、確認カードで「公開する」を押す。自動では公開しない

作家にお願いすること（作るときに）：Anthropic Console での Managed Agents の有効化と webhook の登録、Stripe の制限付きの鍵（テスト用と本番用）、Cloudflare の Pages 用の API トークン、GitHub の細かい権限のトークン。どれもチャットやリポジトリには書かず、それぞれの鍵の置き場に作家が入れる。

## 10. 費用の目安

- 会話（Claude API、Sonnet 5.5）：登録 1 件で 20 往復ほど、数円〜十数円
- 公開の係（Managed Agents）：1 回 5〜10 分。入れ物の時間とモデルの料金で、1 件あたり数十円〜百数十円の見込み（作るときに実測して書き直す）
- 翻訳と物語の下書き（generate）：数十円
- R2：写真 1 枚 1〜2MB。無料枠の中
- Stripe：支払いリンクの作成は無料（売れたときの手数料だけ）

## 11. 再生成の要らない変更

売れた・値段・Stripe のリンクのように、作品ページの見た目や流体に関わらない値は、D1 の `work_overrides` に持ち、実行時に `/api/works-status` と同じ形で上書きする。これなら公開の係を通さず、数秒で反映できる（今の sheerarts.com の中継とどちらを正にするかは R5 で決める）。

## 12. 確かめておくこと（作る前の小さな試し）

- `wrangler` が `CLOUDFLARE_API_TOKEN` の「仮の値」を受け付けるか（手元で形を確かめる道具だと、差し替わる前に弾かれる）。弾かれたら、Cloudflare Pages の直接アップロードの API を curl で呼ぶ形にする
- Stripe の MCP の道具の名前と、制限付きの鍵で通る権限
- 入れ物の中で `sharp` が入るか（npm から。通信の許可で `allow_package_managers`）

## 13. 実装の記録（R1・R2。11-08）

R1（下書きまで）と R2（公開の手順のスクリプト）を作った。R3（Managed Agents の公開の係、webhook）、R4（Stripe の MCP）、R5（直す・売れた・物語の確認）はまだ。**本番にはまだ出していない**（下の「本番に出す前に」を作家の確認のあとで行う）。

### 13.1 置き場

| 置き場 | 中身 |
| --- | --- |
| D1 `work_drafts`（`migrations/0004_work_drafts.sql`） | `id`（ランダム）、`work_id`（URL。英語の題名から作り、重なれば番号。カードで直せる）、`status`（draft／queued／building／published／failed）、`data`（JSON：`work` は確定した値で work.json の形、`proposed` は作家の確認待ちの想いの文と気分の言葉、`skipped` は「あとで」、`colors` はブラウザで取った色の値）、写真の鍵と縦横・大きさ、Stripe の id（R4 用）、公開の記録（コミット、配置の URL、作品ページの URL、失敗したときの最後の 40 行）、時刻 |
| R2 `WORK_UPLOADS`（`drafts/<id>/painting`） | ブラウザで長辺 2000px に縮め、サーバーで EXIF などを消した写真。下書きを捨てるとすぐ消す |

会話の文はどこにも保存しない（ブラウザのメモリにだけあり、毎回送る。ログにも出さない）。`wrangler.toml` の R2 はコメントのまま（無いバケットの binding は配置を壊すので。D1 と同じ考え方）。R2 か表が無いと、管理画面は「登録はまだ使えません」と理由を出し、ダッシュボードはそのまま動く。

### 13.2 API（`functions/api/admin/works/`。門番は `functions/api/admin/_middleware.js`）

| API | 中身 |
| --- | --- |
| `GET /api/admin/works/config` | `{ ready, reason, message, ai, publish }`。reason：no_db／no_table／no_bucket |
| `GET /api/admin/works` | 下書き（新しい順。足りない項目つき）と公開中の作品（カタログ） |
| `POST /api/admin/works` | 下書きを作る（書きかけは 30 件まで） |
| `GET・PATCH・DELETE /api/admin/works/<id>` | 読む／確認カードからの変更（`confirm` で想いの文・気分の言葉を確定、`rooms`、`work_id`、`tool`＋`input` で会話と同じ道具・同じ検査で 1 項目、`reopen` で queued から下書きに戻す）／捨てる（写真もすぐ消す。building・published は消せない） |
| `PUT・GET /api/admin/works/<id>/photo` | 写真。中身で種類を決める（JPEG・PNG だけ。HEIC はブラウザで JPEG にしてから送る。読めないブラウザでは「JPEG か PNG で」）、15MB まで、長辺 1600〜2048px、JPEG は APP1（EXIF・XMP）・APP13・COM を、PNG は eXIf・tEXt・iTXt・zTXt・tIME を落として置く（色の情報 ICC は残す） |
| `POST /api/admin/works/chat` | `{ id, messages, colors?, focus? }` → `{ reply, mode（ai／rules）, draft, view, errors }`。1 分 30 回、Claude に聞くのは 1 日 300 回まで（超えたら決まった順の版） |
| `POST /api/admin/works/<id>/queue` | 「公開する」。項目がそろっていなければ 422。1 日 5 件まで。R1 では状態を queued にするだけ |
| `GET /api/admin/works/<id>/export` | **公開専用のトークンだけ**。`<id>` が `next` ならいちばん古い queued（無ければ 204）。work.json の形と写真（base64） |
| `POST /api/admin/works/<id>/result` | **公開専用のトークンだけ**。`building`（queued から。ほかに building があれば 409）、`published`（building から）、`failed`。コミット、URL、最後の 40 行 |

- 書き込みはすべて管理の認証（Cookie）と同じ origin の検査を通る。`export` と `result` だけは `Authorization: Bearer <PUBLISH_TOKEN>` で通し、Cookie では通さない。トークンはほかの API では通らない。Secret が無いか 32 文字未満なら誰も通さない。比べるのは SHA-256 にしてから定数時間で
- 確認カードの材料（足りない項目、次の問い、支払いの一行、部屋）はサーバーが `view` として返す

### 13.3 聞き役と道具（`functions/_lib/register.js`、`register-chat.js`）

Claude API（`CLAUDE_MODEL`、既定 `claude-sonnet-5-5`。effort low、`fallbacks: "default"`、`tool_choice: auto`）。1 回の作家の発言につき、道具の往復は 4 回まで。応答は思考の塊も変えずに次の往復へ渡し、結果は 1 つの user にまとめる。拒否（refusal）と途中切れ（max_tokens）のときは道具を当てない。文が無ければ決まった問いで続ける。写真は送らない（色の値だけ）。system の 2 つ目の塊に、いまの下書きの様子（済んだ項目、写真の縦横、選べる部屋）を入れる。

| 道具（すべて `strict: true`） | 入力 | サーバーの検査 |
| --- | --- | --- |
| `set_title` | ja, en\|null | 1〜60 字（英語 80 字）、制御文字・向きを変える文字を消す |
| `set_year` | year（整数） | 1900〜来年 |
| `set_size` | gou\|null, width_cm\|null, height_cm\|null, confirm_mismatch | 号は表にあるものだけ。縦横は写真の向きで決める。cm を長辺から言っても写真に合わせて入れ替える。写真の縦横比と 5% 以上違えば記録せずに聞き直す（作家が「合っています」と言えば記録） |
| `set_medium` | ja, en\|null | 1〜60 字 |
| `set_price` | price_jpy（整数） | 1,000〜1 億円（税込） |
| `set_availability` | available／sold／not_for_sale | — |
| `set_buy_url` | url\|null | `https://buy.stripe.com/…` だけ |
| `propose_messages` | messages[] | 3〜10 文、1 文 40 字以内。下書き（作家が「これでいい」で確定） |
| `propose_moods` | words[], fit\|null | 3〜5 語、1 語 16 字、fit 40 字。下書き |
| `set_rooms` | rooms[] | 一覧にあって使える部屋だけ、1〜6 室 |
| `skip_field` | field | 「あとで」。公開に要る項目は、ほかが済んだら最後にもう一度聞く。気分の言葉は「あとで」のままでも公開できる |

- 範囲と長さ（minimum・maxLength など）は strict の型に書けないので、サーバーで確かめる
- **決まった順に聞く版**（鍵が無い、上流の失敗、1 日の上限）：写真 → 題名 → 年 → 大きさ → 画材 → 値段 → 想い → 気分の順に聞き、答えを同じ道具に直して同じ検査を通す。想いは句点と改行で 40 字以内の文に分けるだけ（整えない）。貼られた Stripe のリンクはどの問いの途中でも拾う
- **号数の表**：F・P・M・S の 0・1・2・3・4・5・6・8・10・12・15・20・25・30 号と SM。同じ号は長辺が同じ。作品台帳の F0・F4・F10・F15 とテストで照らしてある
- **部屋**：大きさから `scripts/generate/rooms.js` と同じ決め方で自動（`work.json` の `rooms` は作家が選び直したときだけ書く）。Functions から `rooms/` は読めないので、`functions/_lib/rooms-list.js` に写しを持つ（rooms/*.json と違えばテストが落ちる）

### 13.4 公開の手順（`scripts/publish-draft.mjs`、中身は `scripts/publish-lib.js`）

```bash
PUBLISH_TOKEN=<公開専用のトークン> npm run publish-draft -- <下書きの id> --dry-run            # generate・test・build・確かめで止める（コミットも配置もしない）
PUBLISH_TOKEN=... npm run publish-draft -- <id> --dry-run --cleanup                             # 試しのあと、作った works/<id>/ と生成で変わったファイルを戻す
PUBLISH_TOKEN=... CLOUDFLARE_ACCOUNT_ID=<アカウント ID> npm run publish-drafts                   # queued を古い順に 1 件ずつ（main から。失敗したらそこで止める）
npm run publish-draft -- x --json <下書き.json> --photo <painting.jpg> --dry-run                  # 手元の JSON（export の形か下書きの行）と写真から
```

段取り：作業ツリーがきれいか（変更があれば始めない。push・配置は main からだけ）→ 下書きを受け取る → building の札（配置するときだけ）→ `works/<id>/work.json` と `painting.jpg` → `npm run generate -- <id>`（`BASE_URL=https://meet.sheerarts.com`）→ `npm test` → `npm run build` → 作品ページ・絵・部屋の画像・QR があるか → `works/<id>/` だけをパス指定でコミット → `git push origin main` → `npx wrangler pages deploy` → 結果（published、コミット、URL）。どこかで止まったら、コミットも配置もせず、止まった段と最後の 40 行を result に書き、`result.json` を出す（`--result` で場所を決める）。

- `--no-push`、`--no-deploy`、`--allow-branch`（main 以外へのコミット。試しのとき）、`--ci`（`npm ci` を先に。worktree の node_modules が共有のときは使わない）、`--skip-tests`
- dry-run と `--no-deploy` は下書きの状態（queued）を動かさない
- `buy.url` は下書きにあれば使う（Stripe で作るのは R4）。無いときは値段だけが work.json に入り、作品ページに購入のボタンは出ない

### 13.5 本番に出す前に（作家の確認のあとで Fable が行う）

1. 表：`npx wrangler d1 migrations apply meet-the-painting --remote`（0004 だけが流れる）
2. 写真の置き場：`npx wrangler r2 bucket create meet-work-uploads`、そのあと `wrangler.toml` の `[[r2_buckets]]` の 3 行のコメントを外す
3. Secret：`openssl rand -base64 48 | npx wrangler pages secret put PUBLISH_TOKEN --project-name enter-the-painting`（同じ値を公開を動かす Mac の環境変数 PUBLISH_TOKEN に。リポジトリやチャットに書かない）
4. 配置して、管理画面の「作品を登録」で写真から queued まで 1 回通し、`npm run publish-draft -- <id> --dry-run` で確かめてから本当の公開を 1 回

### 13.6 まだのこと・気になること

- R3〜R5（Managed Agents の公開の係、webhook と進み具合、Stripe の MCP、直す・売れた・物語の確認）
- 公開でコミットするのは `works/<id>/` だけ（この設計のとおり）。generate は `public/catalog.json`、`public/works.json`、`public/og/gallery.png` と `rooms/check/*_<id>.jpg` も書き換えるので、それらは作業ツリーに残る（配置にはビルドの中身が使われるので公開には効くが、Git の正本とずれる）。どこまでコミットに含めるかは決めておく
- 写真を差し替えたあと、前に決めた寸法の縦横比は確かめ直さない（カードで作家が見る）
- 公開済みの下書きの中身を 90 日で消す、R2 の写真を 30 日で消す（4 節）はまだ。Pages Functions に定期実行が無いので、R3 の webhook か公開のスクリプトのついでに行う
- 1 日の上限（Claude 300 回、公開 5 件）は D1 の `daily_counts` で数える。回数の制限（1 分 30 回）は isolate のメモリだけ
