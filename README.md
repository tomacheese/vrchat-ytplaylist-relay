# vrchat-ytplaylist-relay

yt-dlp で YouTube Playlist を取得し、VRChat World (`Assets/Tomachi/YamaPlayerRemotePlaylist`)
が消費する `manifest.json` / Media Endpoint を公開する。特定の VRChat 動画プレイヤー実装には依存しない。

## セットアップ (ローカル実行)

```bash
pnpm install
cp .env.example .env   # 必要に応じて編集
pnpm run build
pnpm start
# 開発時は pnpm run dev (tsx watch)
```

`ytdlp` は `YTDLP_PATH` (既定 `yt-dlp`、PATH 上のもの) を使う。

yt-dlp は YouTube 抽出に外部 JS ランタイム deno を必須とする (`--js-runtimes deno`) ため、ローカル実行時は PATH 上に `deno` をインストールしておく必要がある (Docker 実行時は Image に同梱済み)。

## ログ

サーバーと CLI は標準出力 / 標準エラー出力へ 1 行 1 JSON object のログを出す。共通 field は `timestamp`、`level`、`event`、`message` で、処理に応じて `request_id`、`operation`、`operation_id`、`duration_ms`、対象の playlist / video ID、`error` の型・message・stack を含む。`info` は標準出力、`warn` と `error` は標準エラー出力へ出る。

HTTP request にはランダムな `request_id` が割り当てられ、response の `X-Request-Id` とログ field の値が一致する。request completion event には route template、HTTP status、処理時間が入り、失敗 event には status と例外情報が入る。`/health` の通常成功ログは省略する。たとえば Docker では次のように JSON event や request ID を検索できる。

```bash
docker logs -f vrchat-ytplaylist-relay
docker logs vrchat-ytplaylist-relay 2>&1 | grep '"event":"playlist.refresh.failed"'
docker logs vrchat-ytplaylist-relay 2>&1 | grep '"request_id":"<X-Request-Id value>"'
```

Authorization header、cookie、client IP、request body / query、完全な media URL、動画タイトルは記録しない。例外と yt-dlp / ffmpeg の診断文字列から URL query / fragment、既知の token / signature / Bearer 値を伏せ、改行を escape して診断文字列を最大 4 KiB に制限する。redaction は既知の credential 形式を対象にするため、ログ event に秘密情報を渡さないこと。

`config/playlists.json` は任意。無い場合は allowlist が無効になり、要求された任意の
playlistId をそのまま取得・配信する (事前登録不要)。特定の Playlist だけに絞りたい場合や
Playlist ごとに `maxSlots` を上書きしたい場合は `cp config/playlists.json.example
config/playlists.json` して編集する。設定すると、一覧に無い playlistId は 404 になる。

## リバースプロキシ配下での実行 (`TRUST_PROXY`)

Nginx 等のリバースプロキシ配下で稼働させる場合、Express の `trust proxy` 設定
(`TRUST_PROXY` 環境変数、既定値 `1`) を実際のプロキシ段数に合わせる必要がある。
設定が実際の段数と異なると `express-rate-limit` が `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`
を出力したり、rate limit のクライアント識別 (`req.ip`) が意図せずプロキシの IP に
なったりする。`app.set('trust proxy', true)` のような無条件信頼は行わない。

## Media 配信方式 (`MEDIA_DELIVERY_MODE` / `LIVE_DELIVERY_MODE`)

`GET /:playlistId/:position.mp4` の配信方式は、解決した動画が VOD (通常動画) か
Live (配信中) かで別々の環境変数から選ばれる。VOD は `MEDIA_DELIVERY_MODE`、Live は
`LIVE_DELIVERY_MODE` で切り替える (両方とも未設定なら従来通り `redirect`)。

| 値                | 挙動                                                                                                                                                                                                                                                                      | VOD | Live              | 追加要件                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------- | ----------------------------------------------------------- |
| `redirect` (既定) | `https://www.youtube.com/watch?v=<videoId>` へ 302 Redirect                                                                                                                                                                                                               | ✅  | ✅                | なし                                                        |
| `relay`           | Backend 自身の yt-dlp が解決した HLS manifest URL へ 302 Redirect (音声込みの AVC1 variant を優先選択)。VOD で音声込みの単一 variant が無い場合は、再生範囲の segment を ffmpeg で 1 個ずつ AVC1 + 音声の MPEG-TS に多重化して配信 (再エンコードなし、視聴分のみ一時保存) | ✅  | ✅                | 単一 variant があればなし。無い VOD は ffmpeg、ディスク容量 |
| `relay-redirect`  | `relay` を試し、解決・relay 準備が失敗して 502 になる場合は YouTube watch URL へ 302 Redirect。proxy の動画ダウンロード・キャッシュは行わない                                                                                                                             | ✅  | ✅                | relay と同じ                                                |
| `proxy`           | VOD: yt-dlp + ffmpeg でダウンロード・キャッシュしバイト列を直接配信。Live: ffmpeg で HLS をローカル再公開し配信                                                                                                                                                           | ✅  | ✅                | ffmpeg、ディスク容量                                        |
| `hybrid`          | キャッシュ済みなら `proxy` と同様に配信、未キャッシュなら裏でダウンロードを開始しつつ `relay` 相当の応答を返す (解決失敗、および VOD の多重化の準備に失敗した場合は `redirect`)                                                                                           | ✅  | ❌ (起動時エラー) | ffmpeg、ディスク容量                                        |

`redirect` は VRChat 同梱の制限付き yt-dlp (`Tools/yt-dlp.exe`) が googlevideo.com への
直リンク解決に失敗し 403 になることがある既知の問題を抱える。`relay` は Backend 自身の
(最新版) yt-dlp が解決した HLS master manifest URL へ Redirect するためこの問題を回避でき、
音声込みの単一 variant が取れる場合は ffmpeg やディスクキャッシュも不要 (ステートレス)。YouTube の VOD は音声が別 rendition の master で返ることが多く、AVPro (Windows Media Foundation) は別 rendition の音声を再生できず無音になるため、その場合は、元の映像 playlist の segment 長から `#EXT-X-ENDLIST` 付きの完全な VOD playlist を最初に返し (プレイヤーが VOD と判定でき Seek バーが出る)、segment は要求されたときに映像 segment と音声 segment を ffmpeg (`-c copy`) で 1 個ずつ MPEG-TS に多重化して返す (次の segment は先読み。全編のダウンロードや ffmpeg の常駐は無い)。多重化済み segment は `LIVE_RELAY_OUT_DIR` に一時保存し、`LIVE_RELAY_IDLE_TTL_MS` でディレクトリごと削除する。`proxy` は動画データそのものを Backend
経由で配信することで同じ問題を回避できるが、VOD ではダウンロード完了まで応答をブロックする
ため Client 側の Timeout に間に合わないことがあり、Live では ffmpeg による HLS 再公開
(後述) を常駐させる。`hybrid` (VOD 専用) は未キャッシュ時に即座に `relay` 相当の 302 応答を
返しつつ裏でダウンロードを進めるため、Client が Timeout 後に再リクエストしてくる頃には
キャッシュが出来ていて `proxy` 相当の配信に切り替わる想定の折衷案。`proxy` / `hybrid` は
いずれも YouTube 動画データを Backend にダウンロード・再配信するため、利用規約上のリスクを
運用者が許容していることが前提。

`relay-redirect` は relay で応答を作れない場合の代替として YouTube URL を返す。302 を返した後に
YouTube または Client 側で発生するエラーは検出できないため、fallback の対象外。
resolver failure では VOD/Live の判別前に fallback するため、どちらか一方で `relay-redirect` を使う場合、
もう一方は `redirect` にする (両方を `relay-redirect` にする設定も可能)。

VOD の `proxy` / `hybrid` はいずれも、キャッシュが `MEDIA_CACHE_TTL_MS` を超えて再ダウンロードが走っている間も、直前まで有効だった完了済みキャッシュファイルを Seek 可能な状態のまま配信し続ける (stale-while-revalidate)。
`proxy` はブロックせず、`hybrid` は redirect フォールバックせずに即座に配信し、再ダウンロードが完了すると次回以降のリクエストから新しいファイルに切り替わる。

VOD `proxy` / `hybrid` 関連の設定 (`.env.example` 参照): `MEDIA_MAX_HEIGHT` / `MEDIA_CACHE_DIR` /
`MEDIA_CACHE_MAX_BYTES` / `MEDIA_CACHE_TTL_MS` / `MEDIA_DOWNLOAD_TIMEOUT_MS`。
Live `proxy` 関連の設定: `LIVE_RELAY_OUT_DIR` (再公開先ディレクトリ) /
`LIVE_RELAY_MAX_BYTES` (VOD の多重化済み segment の合計サイズの上限 (Live は対象外)、既定 10 GiB。VOD の多重化済み segment は idle TTL まで保持するため、新規起動時と、約 15 秒間隔の周期スイープで評価し、超過していれば最終アクセスが最も古いものから停止する。単一動画だけで上限を超える場合はその再生も停止する。周期スイープは idle TTL を過ぎた再公開の削除も行い、起動時には前回プロセスが残したディレクトリを削除する。削除対象は名前が videoId 形式で、中身が再公開の生成ファイルだけのディレクトリに限られ、`LIVE_RELAY_OUT_DIR` 内のそれ以外のエントリには触れない) /
`LIVE_RELAY_IDLE_TTL_MS` (最終アクセスからの ffmpeg 停止猶予、既定 5 分。視聴者がいなくなった
Live 配信の ffmpeg プロセスを早めに止めるため、VOD の `MEDIA_CACHE_TTL_MS` より大幅に短い)。
Live `proxy` では videoId ごとに ffmpeg プロセスが 1 つ常駐し、複数視聴者は同じ再公開ファイル
(playlist + segment) を fetch するだけなので、視聴者が増えても Backend 側の追加コストは
静的ファイル配信のリクエスト数のみで済む。

> [!WARNING]
> **破壊的変更**: VOD `hybrid` モードの未キャッシュ時フォールバック先が `redirect`
> (`youtube.com` への 302) から `relay` (解決済み HLS master manifest URL への 302、
> 解決に失敗した場合のみ従来通り `redirect`) に変更された。`hybrid` を使っている既存の
> デプロイは、この挙動の変化を踏まえて動作確認すること。

## 任意の videoId を直接指定する Endpoint (`GET /video/:videoId`)

`GET /:playlistId/:position.mp4` と同様の配信方式判定 (`MEDIA_DELIVERY_MODE` /
`LIVE_DELIVERY_MODE`) を、Playlist/position を経由せず任意の YouTube videoId に対して直接使う
Endpoint。`GET /video/:videoId` と `GET /video/:videoId.mp4` のどちらの形式でもアクセスできる
(拡張子は任意)。`playlistId` の allowlist (`config/playlists.json`) を経由しないため、`proxy` /
`hybrid` モードでは allowlist 外の動画にもアクセスできる点に注意すること。

> [!WARNING]
> `config/playlists.json` に `playlistId: "video"` を設定しないこと。この Endpoint は
> `GET /:playlistId/:position.mp4` より前に登録されており、`playlistId` が文字列 `"video"`
> と一致すると、この Endpoint に奪われ Playlist 経由でアクセスできなくなる。

Live `proxy` モードの再公開ファイルは `GET /:playlistId/:position/live/:file` とは別に
`GET /live/:videoId/:file` からも配信される (`relay` モードは YouTube 自体の HLS manifest URL へ
直接 302 するため、この Endpoint は使わない)。

## Docker

`proxy` / `hybrid` モードは ffmpeg と、自己更新可能な yt-dlp standalone binary を必要とするため、
Docker Image として提供する。

```bash
docker build -t vrchat-ytplaylist-relay .

docker run -d \
  --name vrchat-ytplaylist-relay \
  -p 8787:8787 \
  -v vrchat-ytplaylist-relay-data:/app/data \
  -e MEDIA_DELIVERY_MODE=proxy \
  -e ADMIN_TOKEN=<secret> \
  vrchat-ytplaylist-relay
```

- Entrypoint (`docker/entrypoint.sh`) はコンテナ起動時に `yt-dlp -U` を実行し、以後
  `YTDLP_UPDATE_INTERVAL_HOURS` (既定 24 時間) ごとにバックグラウンドで自己更新し続ける
  (YouTube 側の抽出ロジック変化への追随が `proxy` / `hybrid` モードの生命線のため)。
  `YTDLP_AUTO_UPDATE=0` で無効化できる。
- `/app/data` (`DATA_DIR` / `MEDIA_CACHE_DIR` の既定位置) は Volume 化を推奨する。
- allowlist (対象 Playlist の絞り込み) を使う場合のみ `-v
  "$(pwd)/config:/app/config:ro"` で `config/playlists.json` をマウントする。

## テスト

```bash
pnpm test                # ユニット / 統合的な軽量テスト (yt-dlp 実行なし)
pnpm run test:integration  # 実際に yt-dlp / ffmpeg / ネットワークを使う統合テストも含める
pnpm run typecheck
```

`test:integration` は `RUN_INTEGRATION=1` を設定して `pnpm test` と同じテストファイルを実行し、
`{ skip: !shouldRun }` で分岐している実 yt-dlp 呼び出しテスト (Playlist 取得・動画ダウンロード・
`proxy` モードでの Media Endpoint 疎通) も実行する。CI では通常 `pnpm test` のみ実行すればよい。
