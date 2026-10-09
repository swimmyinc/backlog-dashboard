# 保守工数ダッシュボード

Backlogの課題を取得し、クライアント別の保守工数を集計する社内向けツールです。
HTML・CSS・JavaScriptの画面とCloudflare Workerを同じオリジンで配信します。

```text
ブラウザ → Workerの取得API → Backlog API
                 ↑
     ローカル: .env / 本番: Worker Secret
```

APIキーを画面で入力・保存する機能はありません。Workerだけがキーを読み、
`Backlog-API-Key` ヘッダーに付けてBacklogへ送ります。
1スペース・1キーで、設定した複数のプロジェクトを扱います。

## ローカル起動

Node.js 22以上を使用します。

```sh
npm ci
```

ルートの `.env` に次の値を設定してください。未作成なら `.env.example` をコピーします。
実キーをREADME・ソースコード・チャットへ貼り付ける必要はありません。

```dotenv
BACKLOG_API_KEY=ここに実キーを設定
BACKLOG_SPACE_URL=https://your-space.backlog.com
BACKLOG_ALLOWED_PROJECTS=PROJECT_A,PROJECT_B,123456
```

- `BACKLOG_SPACE_URL` は接続先のHTTPS URLです。パス・クエリ・認証情報は付けません。
- `BACKLOG_ALLOWED_PROJECTS` は許可するIDまたはプロジェクトキーのカンマ区切りです。
  画面にも同じ表記で入力します。例えば `PROJECT_A` を登録した場合、数値IDは別途登録しない限り受け付けません。
- `.env` はGit管理対象外です。`.dev.vars` が存在すると `.env` より優先されるため、併用しません。

```sh
npm run dev
```

[http://127.0.0.1:8787](http://127.0.0.1:8787) を開きます。
開発コマンドは `LOCAL_DEV:true` を起動時だけ渡し、HTTPのループバックURLに限ってAccess認証を省略します。
本番設定に `LOCAL_DEV` を登録しないでください。公開URLではこのフラグがあっても認証を省略しません。
環境変数を変更したら開発サーバーを再起動してください。

画面でクライアントと許可済みプロジェクトを登録し、「この期間で取得」を押します。
接続先はサーバー設定から表示され、画面では変更できません。
APIキー未設定や権限不足の場合は取得エラーになり、管理者による設定確認が必要です。
キーが未設定でも、接続先と許可プロジェクトが設定済みなら画面の登録・サンプル表示は確認できます。

## 本番設定とデプロイ

本番ではCloudflare Accessを必須にしています。設定不足や認証失敗時は、画面・取得APIともに拒否します。
Wranglerからのデプロイには対象Cloudflareアカウントへの認証が必要です。

1. `wrangler.jsonc` のWorker名を確認し、対象アカウントで `npx wrangler login` を実行します。
2. `npm run deploy` でWorkerを作成します。この時点ではAccess未設定のため画面は503になります。
3. Cloudflare Zero Trustで、このWorkerの公開ホスト全体を保護するAccessアプリを作成します。
   社内の利用者だけを許可するポリシーを設定してください。`/api/*` を保護対象から除外しないでください。
   `workers.dev` を使う場合はWorker設定のアクセス制御からAccessを有効にします。
4. Workerの「Settings → Variables and Secrets」で以下を登録し、変更を反映します。

| 設定名 | 種別 | 値 |
| --- | --- | --- |
| `BACKLOG_API_KEY` | Secret | Backlogで発行したAPIキー |
| `BACKLOG_SPACE_URL` | テキスト | `https://your-space.backlog.com` |
| `BACKLOG_ALLOWED_PROJECTS` | テキスト | `PROJECT_A,PROJECT_B` |
| `ACCESS_TEAM_DOMAIN` | テキスト | `https://your-team.cloudflareaccess.com` |
| `ACCESS_AUD` | テキスト | 作成したAccessアプリのApplication Audience (AUD) Tag |

5. 公開URLへAccess経由でログインし、許可したプロジェクトの取得を確認します。
   ログアウト状態や不正なJWTで取得できないことも確認してください。

キーはCLIからも登録・更新できます。値は対話プロンプトで入力します。

```sh
npx wrangler secret put BACKLOG_API_KEY
```

`.env` は本番へアップロードしません。Wrangler設定の `keep_vars: true` により、
ダッシュボードで登録した通常変数も後続デプロイ時に保持します。
Secretは通常のコード更新で毎回登録し直す必要はありません。
キーを交換するときだけ新しい値でSecretを更新してください。

WorkerはAccessのJWTについて署名・発行元・対象アプリ・有効期限を検証します。
同じAccessアプリの利用者は、ここに設定した許可プロジェクトを共通で閲覧できます。
利用者ごとのBacklog権限を引き継ぐOAuth構成ではありません。

## コマンドと構成

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | `.env` を使うローカル開発サーバー |
| `npm run build` | 公開用3ファイルだけを `dist/` にコピー |
| `npm run check` | 構文と自動テストを検証 |
| `npm run deploy:check` | Workerと静的ファイルのデプロイをドライラン |
| `npm run deploy` | 本番へデプロイ |

- `index.html`・`style.css`・`script.js`: 画面と表示・集計処理。
- `worker.js`: 設定取得、Access認証、Backlog取得。任意URLや汎用APIの転送は受け付けません。
- `scripts/build.mjs`: 公開対象を限定するビルド。`.env`・Worker・設定ファイルを混入させません。
- `tests/worker.test.js`: 実キー・外部通信を使わない認証・取得・秘密情報保護の検証。

開発時もHTMLを直接開く代わりに `npm run dev` を使います。
`dist/` は自動生成物です。編集はルートの3ファイルに対して行ってください。

## 維持している集計仕様と制限

- 更新日で期間を絞り込み、「完了」「処理中」「未対応」の課題を100件ずつ取得します。
- 課題種別に「発注」を含むものは除外します。
- 残工数は「契約＋繰越＋追加−完了/処理中の想定−完了/処理中の実績」です。
- 取得前は既存のサンプル課題を表示します。新規クライアントの初期期間も既存仕様のままです。
- 取得成功時に履歴を保存します。処理時間は30秒、ページ数は100ページに制限し、
  上限に達した場合は部分的な集計結果を成功として表示しません。
- クライアント共有ストレージは今回新設していません。`CLIENTS_API_URL` が未設定のため、
  登録内容・取得結果・履歴は再読み込みで失われます。
- 既存の共有ストレージを接続する場合、旧データのトップレベルの `apiKey` は読み込み時に除外します。
  ただし保存先に残った古いキーをサーバー側から消す処理ではありません。既存データの削除と
  共有ストレージ自体のアクセス制御は管理者側で行ってください。

## 参照した公式仕様

- [Backlogの認証と認可](https://developer.nulab.com/ja/docs/backlog/auth/)
- [Workerの環境変数とローカルの.env](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [WorkerのSecret](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Access JWTの検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [静的ファイルの配信設定](https://developers.cloudflare.com/workers/static-assets/binding/)
