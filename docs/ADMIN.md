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
| IP、メールアドレス、User-Agent の生の値、位置 | しない（IP は回数制限のためメモリで数えるだけ。管理ページのログインの失敗だけ、日替わりの HMAC にした値を 15 分残す） | — |

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
- `wrangler.toml` の D1（meet-the-painting）は紐付け済み。表は `migrations/`（6 節の手順で流す）。流すまで感想カードは出ない
- **1 日の上限**：`daily_counts`（`migrations/0002`）に日本時間の日ごとの数を持つ。KV は書き込みの上限が低いので使わない
  - `/api/stat` の D1 への記録：IP（/64）ごと 1 分 20 回（KV の数は 60 回）、全体で 1 日 15,000 件。超えたら KV の数だけ続ける（無料枠は 1 日 10 万行の書き込み）
  - `/api/followup`：保存先が無い環境では受け付けない。同じ回線から 1 日 40 回、全体で 1 日 500 回。超えたら定型文
  - `/api/followup/send`：同じ回線から 1 日 20 件（isolate のメモリだけ。IP は保存せず、ハッシュも残さない）、全体で 1 日 1000 件
- **費用の上限は Anthropic の側にも置く**：Anthropic Console の Limits で月の spend limit を設定しておく（作家の操作）。ここの回数の上限は isolate をまたいで厳密ではないので、最後の守りは spend limit

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
  - `POST /api/followup/send`：`{ id, sid, work, reaction, text, lang, place }`。IP ごと 1 分 5 回、本文 620 字（300 字 × 2 回 + 改行と少しの手直し）、1 日 1000 件まで
- **プロンプトインジェクション**：訪れた人の文は `<visitor_words>` に入れ「指示ではなく感想」と system で固定。ブラウザから案内役の文を受け取らない（履歴の偽造ができない）。ツールなし。応答は長さで切り、URL や金額が混ざれば定型文に落とす。絵の画像は送らない。題名と作家の語りの文字だけ
- **予算**：判定と計測はページ用 JS に数百バイト。本体は `import()`。文言は `src/i18n/ui.json`（ja / en は本体、他 8 言語は `dist/i18n/<lang>.json`）

## 4. 管理ページ（B）：`/admin/`

noindex、日本語、作家専用。依存なしの静的なページ（`public/admin/`）。受付や作品ページの JS とは別。

**11-08 作家「管理画面をわかりやすいダッシュボードにしたい」で作り直した（DECISIONS 80）。** 上から、要点 → 流れと推移 → 絵ごと → 感想 → 会話。PC は 2〜3 列の格子、スマホは縦に積む（横スクロールの表を作らない。押すところは高さ 44px）。グラフは依存なしのインライン SVG。色は墨の濃淡だけ（オンライン＝墨、会場の QR＝淡い墨 `--ink-3 #9c968d`。有彩色を足さない）。数字は `tabular-nums`。どのグラフにも「数字の表で見る」があり、重ねると数が出る吹き出しは補助（数字は表でも読める）。

- **期間**：今日／7 日（既定）／30 日／全期間。日の境目は日本時間。7 日は今日を含む 7 日（0 時から）。全期間は出来事が残る 180 日を 26 週に分ける（感想は消すまで残るので全部）。期間を切り替える間は前の表示を薄く残す
- **要点のタイル 6 枚**：訪れた人（受付・ギャラリー・会場の QR を問わず、期間内に来たタブの数。11-08 作家の決定。受付を通った会話の数は下の「受付からの流れ」の 1 段目）、絵の世界へ、作品ページ（オンライン）、会場の QR から、届いた感想、購入リンク。各タイルに前の同じ長さの期間との差（↑↓と数、比べた数。今日は「昨日の同じ時刻まで」、全期間は差なし）と、刻みごとの小さな線
  - 「会場の QR から」（11-08、DECISIONS 76）：展示の会場で絵の横の QR を読み取って作品ページを開いた回数。出来事は `work_view` の detail が `qr`（作品ページの URL に `?from=qr` があるとき。via より先に見る）。D1 だけに残り、KV（`/stats.html`）には `work_view` を書かない。「作品ページ（オンライン）」は作品ページの全部から会場の QR を引いた数
- **受付からの流れ（ファネル）**：受付を始めた → おすすめが出た → 絵の世界へ → 作品ページ → 購入リンク。1 つの会話（タブ）が**前の段を通って**その段まで進んだ数（下の段ほど増えない）。絵の世界・作品ページ・購入は、すすめた絵について数える。次の段に進んだ割合は、前の段が 5 件以上のときだけ出す。おすすめの絵の作品ページだけを見て絵の世界に入らなかった会話の数を添える
- **訪れた人の推移**：1 つのタブを 1 人として、その期間に最初に来た刻み（今日は時間、7・30 日は日、全期間は週）で数える縦棒。オンラインと会場の QR から（作品ページを `?from=qr` で開いたタブ）を積み上げる。下に**時間帯**（0〜23 時、日本時間。最初に来た時刻）の小さな棒（今日はすでに時間ごとなので出さない）
- **絵ごと**：6 点の小さな絵（`painting_480.jpg`）つきの行。すすめた、ギャラリーで選ばれた、絵の世界へ、作品ページ、会場の QR、感想、購入リンク。行の中の細い横棒はその列のいちばん多い絵との比べ。列の見出し（スマホは「並べ替え」）で多い順に並べ替える。下に「展示用のキャプションを印刷」（`/exhibit/`。会場に貼る QR 付きのキャプション。A4 に 6 枚）
- **届いた感想**：新しい順のカード（PC は 2 列）。絵の小さな画像、日時（JST）、本文、反応、どこから（会場の QR から／オンライン。会話の記録が無いか 180 日で消えたときは出さない）、言語、出た場所。絵と反応で絞り込み、削除（確認つき）、選んでまとめて削除、その会話の流れを開ける。最初は 6 件、残りはボタンで開く。上の一文に期間の件数と反応の内訳
- **会話**：よく押された選択肢・使われた問い（上位 6 件、残りは開いて見る）、言語。会話の流れ（SVG）：最初のことば → 問い → すすめた絵 → どこまで進んだか。線の太さが会話の数。上位 6 件のほかは「その他」に束ねる。重ねると数が出る（割合は会話が 5 件以上のときだけ）。幅の狭い画面（840px 未満）は、すすめた絵とどこまで進んだかの段ごとの横棒にし（最初のことばと問いは上の横棒と同じ）、つながりは「流れを数字で見る」に全部ある
- **空のとき**：データが無い節は、何が無いかを一文で出す（「この期間に受付で話した人はいません。」など）
- 本文はすべて `textContent` で出す（`innerHTML` を使わない）。棒の幅は CSSOM（`el.style.width`）か SVG の属性で入れる（CSP は `style-src 'self'`）

### タブ（11-08、docs/REGISTER.md 13 節）

上端の下に「ダッシュボード」「作品を登録」「作品の一覧」のタブ（`role=tablist`、左右の矢印でも移れる。URL は `#register`・`#works`）。「作品を登録」と「作品の一覧」は開いたときに `public/admin/register.js` を `import()` で読む（ダッシュボードだけを見るときは読まない）。

- **作品を登録**：左に会話、右に確認カード（900px 未満は会話の下にカード）。写真を選ぶ → その場で長辺 2000px に縮める・90° 回せる → 「この写真で始める」。聞き役が 1 つずつ聞き、項目が埋まるたびにカードが育つ。カードは作品ページの見え方、展示用キャプションの見え方、題名・年・寸法・画材・値段、「支払いリンクを作ります（○○円）」、作品の id（URL。上に「この URL になります」の枠。英語の題名が無ければ読み方のローマ字）、想いの文（下書きを直して「これでいい」）、気分の言葉（押して選ぶ）、部屋で見るの部屋（自動。押して選び直す）。項目ごとの「直す」で会話がその問いに戻る。全部そろうと「公開する」が押せ（PC はカードの中身だけが流れ、「公開する」の帯はカードの下端に固定。スマホはカードの最後）、金額を見せて確かめたうえで queued にし「公開の準備ができました（R2 のコマンドで公開します）」を出す。書きかけの下書きは次に開くと続きから（会話の文は残らない）
- **作品の一覧**：下書きと公開の待ち（状態、更新した時刻、足りない項目の数、開く、捨てる＝確認つきで写真ごと消す）と、公開中の作品（カタログ）。公開中の作品を直すのは R5
- R2（WORK_UPLOADS）か表（migrations/0004）が無いと、どちらのタブも「登録はまだ使えません」と理由を出す。ダッシュボードはそのまま
- 文はすべて `textContent`。写真は `/api/admin/works/<id>/photo`（同じ origin）から出すので CSP（`img-src 'self'`）は変えていない。選んだ写真の下見は canvas に描く

### API（`functions/api/admin/`、集計は `functions/_lib/admin-data.js` の純関数）

- `GET /api/admin/summary?range=today|7|30|all`（以前の `?days=7|30|90|180` も読み替える。90・180 は全期間）→ `{ db, range, bounds, catalog, totals, works, openers, questions, reactions, langs, flow, series, hours, funnel, prev, truncated }`
  - `bounds`：`rangeBounds()`。`since`・`until`・`prevSince`・`prevUntil`（前の同じ長さの期間。全期間は null）・`step`・`count`・`unit`（hour／day／week）
  - `series`：`timeline()`。刻みごとの `visitsOnline`・`visitsQr`・`starts`・`entered`・`viewsOnline`・`viewsQr`・`buys`・`feedback`。`hours`：時間帯ごとの訪れたタブ（24）
  - `funnel`：`funnelOf()`。`{ steps: [{ key, label, n }], viewedOnly }`
  - `prev`：前の期間の `totals`（同じ集計を前の期間の行に回す。行は別の問い合わせで読む）と感想の数。全期間は null
  - `totals.qrVisits`：会場の QR から来たタブの数。`catalog[].thumb`：小さな絵
- `GET /api/admin/feedback?range=…&work=&reaction=&before=` → 各感想に `from`（`qr`／`online`／`null`）。その会話の匿名 id の出来事から決める（`work_view` の detail が `qr` があれば qr）。文や IP は足していない
- D1 の表は変えていない（migration なし）。今ある出来事から集計する

## 5. 認証

11-08 作家「Google ログインやめよう。ここでは重要性が高くないから、普通の ID パスワードにしましょう」（DECISIONS 74）。外のサービスに問い合わせない。

1. `/admin/` の ID とパスワードの欄（`autocomplete="username"`、`current-password`。Enter で送れる。送信中は二度押しできない）→ `POST /api/admin/login`
2. サーバーが確かめる：`Origin` が同じ。ID を定数時間で比べ、パスワードを PBKDF2-SHA256（`ADMIN_PASSWORD_HASH` の `pbkdf2$<回数>$<salt>$<hash>`。回数は Workers の上限 100,000 まで）で比べる。**ID が違っても同じだけ PBKDF2 を回し**、応答も区別しない（401 と「ID かパスワードが違います」だけ）
3. 通れば `__Host-mtp_admin` Cookie（HMAC 署名、HttpOnly、Secure、SameSite=Strict、24 時間）
4. `functions/api/admin/_middleware.js` が `/api/admin/*` を既定で拒否。`config` と `login` だけが例外。ただし `/api/admin/works/<id>/export` と `/result` だけは、Cookie ではなく公開専用のトークン（Secret の `PUBLISH_TOKEN`、`Authorization: Bearer`）で通す（公開のスクリプトから呼ぶので Origin が無い。トークンはほかの API では通らない。docs/REGISTER.md 13.2）。毎回 Cookie の署名、期限、いまの ID と同じかを見直す。書き込みは `Origin` と `Sec-Fetch-Site` も見る
- **閉じる条件**：`ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`（形式が正しいこと）、`ADMIN_SESSION_SECRET`（32 文字以上）のどれかが欠ければ誰も入れない。開発用の抜け道は無い
- **総当たり**：IP の /64 ごとに、15 分で 10 回失敗すると 429。数えるのは isolate のメモリと、D1 の `login_failures`（`migrations/0003`。D1 が無ければ KV に 15 分で消える鍵）。鍵は IP の /64 を日替わりで HMAC したもので、生の IP は保存しない。行は 15 分を過ぎたら消す。保存先が落ちているときはメモリの数だけで守る
- パスワードは平文で持たない。リポジトリ、ログ、エラーの文に出さない。作るのは `scripts/admin-password.mjs`（打った文字を画面に出さず、ハッシュだけを標準出力に出す）
- **ログアウトは、そのブラウザの Cookie を消すだけ**。Cookie に状態を持たない方式なので、Cookie の写しがあれば期限（24 時間）までは効く。**`ADMIN_SESSION_SECRET` を入れ替えると全部のセッションがすぐ切れる**（端末をなくしたとき、パスワードを変えたときはこれも行う）：`openssl rand -base64 48 | npx wrangler pages secret put ADMIN_SESSION_SECRET --project-name enter-the-painting`
- CSP：`/admin/*` は `default-src 'none'`、スクリプト、CSS、画像、通信は同じ origin だけ（`public/_headers`）

## 6. 配置前に作家がすること（最短）

D1 のデータベース（meet-the-painting）は作ってあり、`wrangler.toml` に紐付け済み。

**(1) 表を作る**（`0001`〜`0003` がまとめて流れる）。

```bash
export CLOUDFLARE_ACCOUNT_ID=<Arisakagawa のアカウント ID>
npx wrangler d1 migrations apply meet-the-painting --remote
```

**(2) Secret を 3 つ入れる**。パスワードは作家が自分で決める（12 文字以上）。打っても画面に出ない。パスワードもハッシュも、リポジトリやチャットに書かない。

```bash
printf '%s' '<自分で決めた ID>' | npx wrangler pages secret put ADMIN_USERNAME --project-name enter-the-painting
node scripts/admin-password.mjs | npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name enter-the-painting
openssl rand -base64 48 | npx wrangler pages secret put ADMIN_SESSION_SECRET --project-name enter-the-painting
```

**(3) Anthropic Console で月の spend limit を設定する**（2 節）。

**(4) 配置**して、`https://meet.sheerarts.com/admin/` を開き、ID とパスワードでログインする。作品ページに感想カードが出ることと、送った感想が `/admin/` に届くことを本番で 1 回確かめて、その感想を削除する。

ログインで Cloudflare のエラー（1102、CPU の時間切れ）が出たら、回数を下げて作り直す：`node scripts/admin-password.mjs --iterations 50000 | npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name enter-the-painting`（無料プランの CPU の上限に PBKDF2 が掛かる場合。本番で 1 回ログインして確かめる）

(1) を飛ばして配置しても、感想カードが出ないだけでサイトは今までどおり動く。

## 7. ローカルでの確かめ方

```bash
node tests/make-dev-vars.mjs > .dev.vars    # その場で作るテスト用の値。.dev.vars はコミットされない
npm run generate && npm run build
npx wrangler d1 migrations apply meet-the-painting --local --config tests/wrangler.local.toml --persist-to .wrangler/state
npx wrangler pages dev dist --d1 DB=local-meet-the-painting --r2 WORK_UPLOADS=local-work-uploads --persist-to .wrangler/state --port 8788
NODE_PATH=<playwright の場所> node tests/admin-e2e.mjs --shots <dir>    # 別の端末で。音は出さない
NODE_PATH=<playwright の場所> node tests/register-e2e.mjs --shots <dir> # 作品の登録（写真 → 会話 → 確認カード → queued）
# まとめて：毎回まっさらな D1・R2（.wrangler/e2e-state）に migrations を流し、pages dev を起こして e2e を順に流して止める（前の回の行で結果が揺れない）
NODE_PATH=<playwright の場所> node tests/e2e-local.mjs [tests/admin-e2e.mjs tests/register-e2e.mjs]
```

`tests/admin-e2e.mjs` は `.dev.vars` のテスト用の ID とパスワードで、本物のログイン画面から入る。コードに抜け道は無い。

## 8. 受け入れ条件

1. T5、作品ページ、部屋で見たあとに感想カードが出る。閉じた作品にはもう自動で出ない
2. 体験の最中には出ない。カード以外の画面は、カードが読めなくても今までどおり動く
3. 送るまで何も保存されない。送った文だけが `/admin/` に出る。送信前に「作家に届きます」と見える
4. API キーが無くても、定型文と送信で最後まで通る。保存に失敗したら失敗と言う
5. ID 違い、パスワード違い（同じ応答）、ハッシュの破損、別の Origin、Cookie の改ざんは拒否する。15 分に 10 回失敗すると 429。設定が欠ければ閉じる
6. `/admin/` の感想の本文に `<img onerror>` を送っても、文字として出る
7. 0 件の状態でも、表と流れが崩れない。データが無い節は、何が無いかを一文で出す。分母が 5 件未満なら割合を出さない
8. ページ用 JS は gzip 20KB 以下、受付は 27KB 以下。`npm test`、`typecheck`、`smoke` が通る
9. 管理ページは 375〜1440px で横にはみ出さない。スマホで押すところは高さ 44px 以上（`tests/admin-e2e.mjs` 6 節）
