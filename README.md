# 保守工数ダッシュボード

Backlogの課題をクライアント別に集計する、招待制の社内ツールです。
HTML・CSS・JavaScriptとCloudflare Workerを同一オリジンで配信し、D1に登録情報・取得結果・履歴を共有保存します。

## 利用者と権限

- 利用者の許可メールアドレスはCloudflare Accessの管理画面で登録します。アプリ内の招待・ユーザー管理はありません。
- `ADMIN_EMAILS` に登録されたメールの管理者だけが、クライアント・許可プロジェクト・契約工数を登録、編集、削除できます。
- 一般利用者は、登録済みの全プロジェクトの閲覧、Backlog取得、履歴閲覧ができます。
- WorkerはAccess JWTの署名・発行元・対象アプリ・有効期限を検証し、そのJWTのメールで管理者を判定します。メールの単独ヘッダーでは権限を判定しません。
- Backlog APIキーは専用ユーザーのもの1つを全員で利用します。個人ごとのBacklog権限は引き継ぎません。

## ローカル起動

Node.js 22以上で実行します。

```sh
npm ci
```

`.env` がなければ `.env.example` をコピーし、値を設定してください。

```dotenv
BACKLOG_API_KEY=専用ユーザーのAPIキー
BACKLOG_SPACE_URL=https://your-space.backlog.com
ADMIN_EMAILS=admin@example.test
LOCAL_USER_EMAIL=admin@example.test
```

- 接続先は1スペースです。HTTPSのオリジンだけを指定します。
- `ADMIN_EMAILS` はカンマ区切りで複数指定できます。空なら管理操作を許可しません。
- `LOCAL_USER_EMAIL` はローカルで再現する利用者です。管理者一覧にないメールを指定すると一般利用者になります。
- `.env` はGit・公開ファイルから除外します。`.dev.vars` は `.env` より優先されるため併用しないでください。
- 旧 `BACKLOG_ALLOWED_PROJECTS` は不要です。許可するプロジェクトは管理者が画面から登録します。

```sh
npm run dev
```

ローカルD1にマイグレーションを適用してから起動します。
[http://127.0.0.1:8787](http://127.0.0.1:8787) を開き、クライアントとプロジェクトキーまたは数値IDを登録してください。
登録時にBacklog APIでアクセス権を確認し、数値IDに統一します。同じプロジェクトの重複登録はできません。
実キーがない場合は画面の表示まで確認できますが、プロジェクト登録・取得は失敗します。

開発コマンドは `LOCAL_DEV:true` を渡します。HTTPのループバックホストに限ってAccess認証を省略します。
`LOCAL_DEV` と `LOCAL_USER_EMAIL` は本番に登録しないでください。環境変数変更後は再起動します。
ローカルデータは `.wrangler/` に保存され、本番D1とは共有されません。

## 本番の準備

以下は管理者による初回設定です。このコード変更だけでは本番環境は作成されません。

1. 対象Cloudflareアカウントで `npx wrangler login` を実行します。
2. `npx wrangler d1 create backlog-dashboard` で本番D1を作成します。
3. `wrangler.jsonc` の `d1_databases[0].database_id` のゼロの仮IDを、返された実IDに置き換えます。バインド名 `DB` は維持します。
4. `npx wrangler d1 migrations apply backlog-dashboard --remote` で本番スキーマを作成します。
5. `npm run deploy` でWorkerを作成します。この段階ではAccess設定不足のため画面は503で閉じます。
6. Cloudflare Zero Trustで公開ホスト全体を保護するAccessアプリを作成します。許可ポリシーの「Emails」に利用者を個別登録し、必要ならOne-time PINを有効にします。`/api/*` も保護対象に含めます。`workers.dev` を利用する場合はWorkerのアクセス制御からAccessを有効にしてください。
7. Workerの「Settings → Variables and Secrets」に次の値を登録して反映します。

| 設定名 | 種別 | 内容 |
| --- | --- | --- |
| `BACKLOG_API_KEY` | Secret | 専用BacklogユーザーのAPIキー1つ |
| `BACKLOG_SPACE_URL` | テキスト | `https://your-space.backlog.com` |
| `ADMIN_EMAILS` | テキスト | 管理者メールのカンマ区切り。Accessでも許可が必要 |
| `ACCESS_TEAM_DOMAIN` | テキスト | `https://your-team.cloudflareaccess.com` |
| `ACCESS_AUD` | テキスト | AccessアプリのApplication Audience (AUD) Tag |

8. 管理者でログインし、画面の「クライアント追加」から許可プロジェクトと契約工数を登録します。
9. 一般利用者での閲覧・取得、管理操作の拒否、許可していないメールのログイン拒否を確認します。

APIキーはWorkerだけが読み、`Backlog-API-Key` ヘッダーでBacklogへ送ります。ブラウザへ渡しません。
CLIで登録する場合は `npx wrangler secret put BACKLOG_API_KEY` の対話入力を利用してください。
`.env` は本番へ送信しません。`keep_vars: true` により管理画面で登録した通常変数を後続デプロイでも保持します。
Secretも通常のコード更新のたびに再登録する必要はありません。

## 共有保存と集計

- 契約・繰越・追加工数、プロジェクト登録、最新の取得結果、期間別履歴をD1に保存します。
- 他の利用者の変更は「一覧を更新」で読み込みます。自動ポーリングはありません。
- 更新番号が古い編集・削除・取得は409で拒否します。「一覧を更新」してから再操作してください。取得中に編集された場合も結果を上書きしません。
- 取得結果と履歴は同一トランザクションで保存します。同じ開始日・終了日の再取得は、その期間の履歴を更新します。
- 履歴表示は共有の最新結果を変更しません。履歴の残工数は取得時点の契約工数を使います。
- プロジェクトや接続スペースを変更すると、旧プロジェクトの取得結果・履歴を削除します。クライアント削除時も履歴を削除します。
- 更新日で期間を絞り、「完了」「処理中」「未対応」を100件ずつ取得し、種別に「発注」を含む課題を除外します。
- 残工数は「契約＋繰越＋追加−完了/処理中の想定−完了/処理中の実績」です。
- 未取得時は空表示です。新規登録の初期期間は当月1日〜当日（UTC基準）です。
- Backlog通信は30秒、100ページまでです。保存JSONが1MBを超える場合も期間の短縮を求めます。途中の結果を成功として保存しません。
- 旧画面のメモリ上の登録や外部ストレージからの自動移行はありません。必要なプロジェクトを新規登録してください。

## コマンドと構成

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | ローカルD1の準備と開発サーバー起動 |
| `npm run db:migrate:local` | ローカルマイグレーションだけ適用 |
| `npm run build` | 公開用3ファイルだけを `dist/` にコピー |
| `npm run check` | 構文、認証、API、画面イベント、ローカルD1のテスト |
| `npm run deploy:check` | デプロイのドライラン |
| `npm run deploy` | 本番へデプロイ |

- `index.html` / `style.css` / `script.js`: 画面、権限表示、API操作。
- `worker.js`: Access認証、管理権限、入力検証、Backlog取得。
- `store.js` / `migrations/`: D1保存、更新競合検出、履歴。
- `tests/`: 実キー・本番通信を使わない検証。D1はMiniflareのローカル実装で検証します。画面イベントのテストはブラウザ描画確認の代替ではありません。

`dist/` は生成物です。編集はルートのファイルで行ってください。

## 公式仕様

- [Backlogの認証](https://developer.nulab.com/ja/docs/backlog/auth/)
- [Workerの環境変数](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [WorkerのSecret](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Access JWTの検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [D1バッチとトランザクション](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1マイグレーション](https://developers.cloudflare.com/d1/reference/migrations/)
