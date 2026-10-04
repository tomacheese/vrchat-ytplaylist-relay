# VRChat YouTube Playlist Relay

YouTube の Playlist を読み取り、VRChat のワールドが使う JSON manifest と動画 Endpoint を返す Node.js サーバーです。ワールド側の動画プレイヤー実装には依存しません。

Playlist の曲順は要求時に YouTube から取得します。動画ごとの `position` は初回割り当て後に変わらないため、Playlist の編集後も既存の再生 URL を保てます。

## 動作要件

- Node.js 24 以降
- pnpm 11.23.0
- `yt-dlp` を PATH に置くか、`YTDLP_PATH` で実行ファイルを指定
- ローカル実行で YouTube の情報を取得する場合は `deno` も PATH に置く
- `proxy`、Live `proxy`、または音声 rendition を多重化する VOD `relay` には `ffmpeg` が必要

Dockerfile には Node.js、Deno、ffmpeg と yt-dlp standalone binary が含まれます。

## ローカルで起動する

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

`pnpm run dev` は `tsx` でサーバーを起動します。ビルドして実行する場合は次を使います。

```bash
pnpm run build
pnpm start
```

既定の待ち受けポートは `8787` です。`.env` は省略できます。設定の全項目と既定値は [.env.example](.env.example) にあります。

数値設定は単位を付けない整数で指定してください。不正な値、負数、範囲外の値は起動時にエラーになります。`PORT` は `0`～`65535`、`DEFAULT_MAX_SLOTS` と Playlist ごとの `maxSlots`、`MEDIA_MAX_HEIGHT` は正の整数です。timeout は `1`～`2147483647` ms、それ以外の期間・容量・proxy hop 数は `0` 以上の安全な整数を指定します。

## Playlist を制限する

`config/playlists.json` が存在しない場合、Playlist allowlist は無効です。YouTube の Playlist ID を指定すれば利用できます。

利用できる Playlist を限定するには、サンプルをコピーして `playlists` 配列を編集します。

```bash
cp config/playlists.json.example config/playlists.json
```

```json
{
  "playlists": [
    {
      "playlistId": "PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "displayName": "Example Playlist",
      "maxSlots": 1000
    }
  ]
}
```

`displayName` は管理者向けの任意項目で、API の manifest には入りません。`maxSlots` を省略すると `DEFAULT_MAX_SLOTS` を使います。allowlist 有効時に登録していない Playlist を要求すると `404` を返します。

## Endpoint

| Method | Path                                | 動作                                                                    |
| ------ | ----------------------------------- | ----------------------------------------------------------------------- |
| `GET`  | `/`                                 | サービス名、配信方式、Playlist ID、主要 Endpoint を返す                 |
| `GET`  | `/health`                           | Playlist ごとの最終 refresh 状態を返す。状態が degraded でも HTTP `200` |
| `GET`  | `/:playlistId/manifest.json`        | Playlist manifest を返す                                                |
| `GET`  | `/:playlistId/:position.mp4`        | manifest の position に対応する動画を設定済みの方式で配信する           |
| `GET`  | `/video/:videoId`                   | Playlist を経由せず YouTube video ID を指定する。末尾の `.mp4` は任意   |
| `GET`  | `/live/:videoId/:file`              | video ID で指定した Live / VOD relay の playlist / segment を返す       |
| `GET`  | `/:playlistId/:position/live/:file` | Playlist position 経由の Live / VOD relay playlist / segment を返す     |
| `POST` | `/admin/refresh`                    | 既知の全 Playlist を再取得する                                          |
| `POST` | `/admin/refresh/:playlistId`        | 指定 Playlist を再取得する                                              |

`/video/:videoId` と `/live/:videoId/:file` は Playlist allowlist を通りません。allowlist は Playlist 経由の manifest・position route を制限しますが、video ID を直接指定する route は制限しません。

Manifest の形式は次のとおりです。`tracks` は YouTube 上の現在の並び順ですが、各 `position` は動画 ID に割り当てた不変の番号です。`generation` は Playlist の順序・動画 ID・タイトルが変わった場合に増えます。

```json
{
  "playlistId": "PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "generation": 1,
  "updatedAt": 1710000000000,
  "tracks": [{ "position": 0, "title": "Video title" }]
}
```

Playlist の情報は要求時に yt-dlp で取得し、`MANIFEST_CACHE_TTL_MS` の間だけメモリに保持します。Playlist の曲順・タイトルはディスクに保存しません。`data/` には Playlist ごとの position 対応表、generation、refresh 状態など (`slots.json`) と、選択した配信方式に応じた動画データを保存します。

初回取得に失敗して manifest がまだ無い場合は `503` を返します。最後に取得した manifest がある場合、refresh 失敗中もそれを返します。position が未割り当てなら動画 Endpoint は manifest を更新して解決を試みます。

取得に失敗した Playlist は、`MANIFEST_RETRY_DELAY_MS` (既定 `30000` ms) の間、公開 manifest 要求から再取得しません。その間は直前の manifest を返し、キャッシュが無ければ `503` を返します。管理 Endpoint と CLI の明示的な refresh は待機期間中でも実行します。失敗情報をディスクへ保存できない場合も、メモリ上の manifest を継続して返します。

管理 Endpoint は `ADMIN_TOKEN` が設定されている場合だけ使えます。リクエストには `Authorization: Bearer <token>` が必要です。Token が未設定の場合、`/admin` は `403` を返します。通常の manifest 要求はキャッシュ TTL に従って自動更新されるため、TTL を待たずに更新する場合に管理 Endpoint を使います。

## CLI で Playlist を再取得する

サーバーと同じ環境設定を使って `pnpm refresh` を実行します。引数を省略すると、設定済みの Playlist を順番に再取得します。allowlist が無効なら、`DATA_DIR` 直下のディレクトリ名を Playlist ID の候補にします。position state 以外のディレクトリも候補です。そのため、`cache` や `live` を `DATA_DIR` 内に作る設定では allowlist を使ってください。または、それらの保存先を `DATA_DIR` の外へ移してください。ID を指定すると、その Playlist だけを再取得します。

CLI はサーバーとは別プロセスです。position 状態はディスクに反映されます。一方、起動中サーバーの manifest メモリキャッシュは無効になりません。変更が公開 manifest に反映されるのは TTL 切れ後です。すぐに反映するには、認証済みの管理 Endpoint を使ってください。

```bash
pnpm refresh
pnpm refresh PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## 動画の配信方式

VOD と Live は別々に設定します。`MEDIA_DELIVERY_MODE` は VOD、`LIVE_DELIVERY_MODE` は配信中の動画に適用されます。どちらも未設定時は `redirect` です。

| 値               | 動作                                                                                                                                   | 必要なもの                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `redirect`       | YouTube の watch URL に HTTP `302` を返す                                                                                              | なし                                               |
| `relay`          | サーバー側 yt-dlp が解決した HLS を返す URL に `302`。VOD で音声が別 rendition の場合は、要求された segment を ffmpeg で多重化して配信 | yt-dlp。VOD の多重化時は ffmpeg と一時ディスク領域 |
| `relay-redirect` | relay の解決または準備に失敗した場合、YouTube watch URL に `302`                                                                       | `relay` と同じ                                     |
| `proxy`          | VOD は動画をダウンロードしてディスクキャッシュから配信。Live は ffmpeg で HLS をローカルに再公開                                       | yt-dlp、ffmpeg、ディスク領域                       |
| `hybrid`         | VOD 専用。キャッシュ済みなら動画を直接配信し、未キャッシュならダウンロードを始めて relay 相当の応答を返す                              | yt-dlp、ffmpeg、ディスク領域                       |

`hybrid` は Live には設定できません。どちらか一方を `relay-redirect` にする場合、もう一方は `redirect` または `relay-redirect` にしてください。Resolver の失敗は VOD / Live 判定前に起きるため、この組み合わせに制限しています。

`proxy` と `hybrid` は完成済みの VOD キャッシュを動画情報の再解決前に配信します。TTL 切れでも古いファイルを返し、バックグラウンドで更新します。更新失敗時は古いファイルを保持します。動画 1 本が `MEDIA_CACHE_MAX_BYTES` を超える場合はダウンロードを失敗として扱い、既存ファイルを置き換えません。ダウンロード中は yt-dlp のサイズ指定と一時ファイルの監視で上限超過を止めます。監視間隔中に一時ファイルが上限を超える場合があります。

`proxy` と `hybrid` は動画データをサーバーへダウンロードして再配信します。運用する前に、対象コンテンツの権利、適用される利用条件、必要なディスク容量とネットワーク帯域を確認してください。

## リバースプロキシ

Nginx などのリバースプロキシを使う場合は、`TRUST_PROXY` をサーバーまでの実際の proxy hop 数に設定してください。既定値は `1` です。Express はこの値を使って `X-Forwarded-For` から接続元を解決します。無条件に信頼する値は使わないでください。

## Docker

```bash
docker build -t vrchat-ytplaylist-relay .

docker run -d \
  --name vrchat-ytplaylist-relay \
  -p 8787:8787 \
  -v vrchat-ytplaylist-relay-data:/app/data \
  -e MEDIA_DELIVERY_MODE=proxy \
  -e ADMIN_TOKEN='<secret>' \
  vrchat-ytplaylist-relay
```

`/app/data` は position 状態と VOD キャッシュの保存先です。Live / relay の一時ファイルもここに作成します。このディレクトリを volume に置いてください。allowlist を使う場合は、`config/playlists.json` を `/app/config/playlists.json` に read-only で mount します。

Container entrypoint は既定で起動時に yt-dlp を更新し、その後 `YTDLP_UPDATE_INTERVAL_HOURS` ごとに更新を確認します。`YTDLP_AUTO_UPDATE=0` で自動更新を無効にできます。

Docker image は `linux/amd64` と `linux/arm64` に対応し、それぞれの CPU 向け yt-dlp を含みます。同一プロセス内では cache directory ごとに同時ダウンロードを 1 件に制限します。yt-dlp の timeout 時は子プロセスも終了させ、終了確認後に一時ダウンロードファイルを削除します。

## ログ

ログは stdout / stderr に 1 行 1 JSON object で出力します。各行に `timestamp`、`level`、`event`、`message` が入ります。必要に応じて `request_id`、`operation_id`、処理時間、Playlist / video ID なども記録します。HTTP response の `X-Request-Id` はログの `request_id` と一致します。

`/health` と Live / VOD segment 要求は、通常成功時のログを省略します。失敗は記録します。Authorization、Cookie、client IP、request body / query、動画タイトル、完全な media URL は記録しません。ログ sanitizer は既知の認証情報を伏せます。ただし、未知の secret を検出できる保証はありません。機密値をログ field に渡さないでください。

```bash
docker logs -f vrchat-ytplaylist-relay
docker logs vrchat-ytplaylist-relay 2>&1 | grep '"event":"playlist.refresh.failed"'
docker logs vrchat-ytplaylist-relay 2>&1 | grep '"request_id":"<X-Request-Id>"'
```

ログ field と event の概要は [docs/logging.md](docs/logging.md) を参照してください。

## 開発と検証

```bash
pnpm test                 # ローカルで完結するテスト
pnpm run typecheck
pnpm run lint
pnpm run test:integration # 実 yt-dlp / ffmpeg / ネットワークを使うテストを含む
```

統合テストは `RUN_INTEGRATION=1` で有効になります。通常の `pnpm test` は外部サービスを使うケースを skip します。CI は軽量なテストを実行します。
