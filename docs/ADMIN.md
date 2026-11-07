# 感想チャットと作家の管理ページ（11-08。作家の言葉から）

作家：「絵を見た後、どっかでフォロー的に別でチャットできるといい。この絵は気に入った？ みたいな。送った感想は作家側からも見れたらいい。どの絵を見た人から、何時に来たか。管理ページは Google 認証で登録したメールアドレスだけ。選ばれた絵の回数、どういう質問だったか、会話の流れも可視化」

## 1. 保存と非公開の方針（作家の判断が要る既定値）

以前の約束「会話は保存しない」を、次のように改めた。**受付で自由に書いた文は今も保存しない。**

| 何を | 保存するか | 期間 |
| --- | --- | --- |
| 感想：「作家に届ける」を押した文と反応 | する（押すまで保存しない） | 作家が消すまで |
| 構造化した出来事：押した選択肢、案内役の問い（ストックの文）、すすめた作品、「別のにする」、絵の世界へ、作品ページ、購入リンク、言語 | する | 180 日 |
| 自由入力があったという事実 | する（「自由入力あり」だけ） | 180 日 |
| 受付や感想チャットで書いて、送らなかった文 | しない。答えを作るために Claude API へ渡すだけ | — |
| 案内役の生成した文（相手のことばを含みうるので） | しない。ストックの問いに近ければその問いの文だけ、遠ければ「その他の問い」 | — |
| IP、メールアドレス、User-Agent の生の値、位置 | しない（IP は回数制限のためメモリで数えるだけ） | — |

- 会話をつなぐのは、タブごとのランダムな匿名 id（`sessionStorage`）。タブを閉じると消え、次は別の id
- ブラウザが Global Privacy Control を出しているときは匿名 id を作らない（回数だけ。流れはつながない）
- 感想の本文に書かれた個人情報は機械では消さない。送る前に「作家に届きます。お名前や連絡先は書かないでね」と添え、作家が削除できる
- 期限切れの出来事は、計測の書き込みのついで（まれに）と管理ページを開いたときに消す。Pages Functions に定期実行が無いため
- 訪れる人への説明：感想カードの「記録について」→ `/data-note.html`

## 2. データの持ち方：Cloudflare D1（binding `DB`）

`migrations/0001_init.sql`。`feedback`（感想）と `events`（出来事）の 2 つ。

- D1 を選んだ理由：日付と作品での絞り込み、会話ごとの集計が要る。KV は書き込みが 1 日 1000 回、同じ鍵に 1 秒 1 回で足りない。D1 は無料枠で 1 日 10 万行
- `events.detail` はカタログと照合したストックの文か、決まった語だけ。サーバーが照合し、知らない文は「その他の選択肢」にする（自由入力が混ざらない）
- `cg_question`（案内役の問い）はブラウザから受け付けず、サーバーが応答の文から決める。候補は seed で選んだ 4 問。文字の近さで照合する。日本語以外の会話は照合できないので「その他の問い（日本語以外）」
- 計測の失敗で会話や感想を止めない。出来事は `waitUntil`。`DB` が無いか表が無いとき、感想カードは**出さない**（できないことをボタンにしない）。サイトの他の部分は今までどおり
- **`wrangler.toml` の D1 の行はコメントのまま**。id の無い binding を残すと配置が失敗するため（6 節の手順で外す）

### 既存の計測（KV と `/stats.html`）との整理

`/stats.html` と `/api/stat` の KV は壊さず残す。`/api/stat` は同じ本文で KV も数え、D1 にも出来事を書く（送信は 1 回）。新しい出来事は D1 だけで、KV の上限を消費しない。

- 今後、作家が見るのは `/admin/`。`/stats.html` は 11-06 からの累計を見る控えとして残す
- 数字は一致しない。D1 は保存を始めた日から、KV は 11-06 から。KV の「人」は数えず回数だけ
- 感想チャットの出来事、問い、流れは `/admin/` だけにある

## 3. 感想チャット（A）

- **出る場所**：物語モードの終わり（T5。帯が出て 6 秒後、帯の上）／作品ページに戻ったとき（`after=1`、体験を閉じたあと）／部屋で見るの拡大表示を閉じたあと／作品ページに 40 秒いたとき
- **出ない**：体験の最中、拡大表示の最中、VR の中。一度閉じた作品（`localStorage`）。同じタブで出した作品。1 つのタブで自動で出すのは 2 作品まで。自動で出なくなっても作品ページの小さなリンク「この絵の感想を送る」から開ける
- **流れ**：「この絵は気に入った？」→ 反応 3 つ＋「ことばで書く」→ 案内役の定型のひとこと → 自由入力 → 案内役が共感して返す（最大 2 往復）→ 送る文を自分で見て直せる確認（「作家に届きます」）→ 「作家に届ける」
- **Claude が使えないとき**：定型文と送信だけで成立する。`/api/followup` は `reply: null` を返し、ブラウザは定型文を出す
- **失敗したとき**：「届けられなかった」と正直に言い、文を残してもう一度押せる。同じ id の再送は二重にならない
- **API**
  - `GET /api/followup/config`：`{ enabled, ai }`
  - `POST /api/followup`：`{ lang, work, reaction, texts }` → `{ reply }`。保存しない。IP ごと 1 分 6 回、1 回 300 字、最大 2 回分。作品 id はカタログと照合
  - `POST /api/followup/send`：`{ id, sid, work, reaction, text, lang, place }`。IP ごと 1 分 5 回、本文 600 字、1 日 1000 件まで
- **プロンプトインジェクション**：訪れた人の文は `<visitor_words>` に入れ「指示ではなく感想」と system で固定。ブラウザから案内役の文を受け取らない（履歴の偽造ができない）。ツールなし。応答は長さで切り、URL や金額が混ざれば定型文に落とす。絵の画像は送らない。題名と作家の語りの文字だけ
- **予算**：判定と計測はページ用 JS に数百バイト。本体は `import()`。文言は `src/i18n/ui.json`（ja / en は本体、他 8 言語は `dist/i18n/<lang>.json`）

## 4. 管理ページ（B）：`/admin/`

noindex、日本語、作家専用。依存なしの静的なページ（`public/admin/`）。受付や作品ページの JS とは別。

- 届いた感想：日時（JST）、どの絵、反応、本文、言語。絵と反応で絞り込み、削除（確認つき）。その会話の流れを開ける
- 絵ごとの表：すすめた、絵の世界へ、ギャラリーで選ばれた、作品ページ、感想、購入リンク
- 使われた問い、押された選択肢、感想の反応（横棒）
- 会話の流れ（SVG）：最初のことば → 問い → すすめた絵 → どこまで進んだか。線の太さが会話の数。上位 6 件のほかは「その他」に束ねる。線に重ねると数が出る。同じ数字は上の表にもある
- 期間の切り替え：7 日／30 日／90 日／180 日
- 本文はすべて `textContent` で出す（`innerHTML` を使わない）

## 5. 認証

1. Google Identity Services のボタン → ID トークン → `POST /api/admin/login`
2. サーバーが検証：RS256 の署名を Google の JWKS で、`aud` が `GOOGLE_CLIENT_ID`、`iss` が accounts.google.com、`exp`、`email_verified === true`、メールが `ADMIN_EMAILS` にある
3. 通れば `__Host-mtp_admin` Cookie（HMAC 署名、HttpOnly、Secure、SameSite=Strict、24 時間）
4. `functions/api/admin/_middleware.js` が `/api/admin/*` を既定で拒否。`config` と `login` だけが例外。毎回 Cookie の署名、期限、許可リストを見直す（許可リストから外せばすぐ効く）。書き込みは `Origin` と `Sec-Fetch-Site` も確かめる
- **閉じる条件**：`GOOGLE_CLIENT_ID`、`ADMIN_EMAILS`、`ADMIN_SESSION_SECRET`（32 文字以上）のどれかが欠けていれば誰も入れない。開発用の抜け道は無い
- メールアドレスはコードと docs に書かない（公開リポジトリ）

## 6. 配置前に作家がすること（最短）

**(1) D1 の枠を空ける**（アカウントは Arisakagawa。11-08 時点で D1 が無料枠の上限 10 個に達していて `d1 create` が失敗した）。使っていないものを 1 つ消すか、Workers の有料プランにする。

```bash
export CLOUDFLARE_ACCOUNT_ID=<Arisakagawa のアカウント ID>
npx wrangler d1 list
npx wrangler d1 create meet-the-painting      # 表示された database_id を控える
```

**(2) `wrangler.toml` の D1 の 4 行のコメントを外し**、`database_id` を入れて、表を作る。

```bash
npx wrangler d1 migrations apply meet-the-painting --remote
```

**(3) Google のクライアント ID を作る**。https://console.cloud.google.com/apis/credentials →「認証情報を作成」→「OAuth クライアント ID」→ 種類「ウェブ アプリケーション」→ 承認済みの JavaScript 生成元に `https://meet.sheerarts.com` を追加（リダイレクト URI は不要）。同意画面を聞かれたら、対象は「外部」、テストユーザーに自分のメールアドレス。

**(4) Secret を 3 つ入れる**（値はリポジトリに書かない）。

```bash
npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name enter-the-painting
npx wrangler pages secret put ADMIN_EMAILS --project-name enter-the-painting          # カンマ区切り
openssl rand -base64 48 | npx wrangler pages secret put ADMIN_SESSION_SECRET --project-name enter-the-painting
```

**(5) 配置**して、`https://meet.sheerarts.com/admin/` を開き、Google でログインする。作品ページに感想カードが出ることと、送った感想が `/admin/` に届くことを本番で 1 回確かめて、その感想を削除する。

(1)(2) を飛ばして配置しても、感想カードが出ないだけでサイトは今までどおり動く。

## 7. ローカルでの確かめ方

```bash
cp .dev.vars.example .dev.vars    # テスト用の値。.dev.vars はコミットされない
npm run generate && npm run build
npx wrangler d1 migrations apply meet-the-painting --local --config tests/wrangler.local.toml
npx wrangler pages dev dist --d1 DB=local-meet-the-painting --port 8788
```

ローカルでは Google のログインを通さず、`.dev.vars` のテスト用の秘密で署名した Cookie を Playwright が入れる（`tests/admin-e2e.mjs`）。コードに抜け道は無い。

## 8. 受け入れ条件

1. T5、作品ページ、部屋で見たあとに感想カードが出る。閉じた作品にはもう自動で出ない
2. 体験の最中には出ない。カード以外の画面は、カードが読めなくても今までどおり動く
3. 送るまで何も保存されない。送った文だけが `/admin/` に出る。送信前に「作家に届きます」と見える
4. API キーが無くても、定型文と送信で最後まで通る。保存に失敗したら失敗と言う
5. 不正な署名、aud 違い、期限切れ、許可外メール、未検証メール、Cookie の改ざんは拒否する。設定が欠ければ閉じる
6. `/admin/` の感想の本文に `<img onerror>` を送っても、文字として出る
7. 0 件の状態でも、表と流れが崩れない
8. ページ用 JS は gzip 20KB 以下、受付は 27KB 以下。`npm test`、`typecheck`、`smoke` が通る
