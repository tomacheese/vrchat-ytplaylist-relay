# ログの見方

サーバーと `pnpm refresh` は stdout / stderr に JSON Lines を出力します。1 行が 1 event です。ファイルへのログ保存や外部ログサービスへの送信は行いません。

## 共通 field

| Field                       | 内容                                                           |
| --------------------------- | -------------------------------------------------------------- |
| `timestamp`                 | event を記録した UTC 時刻                                      |
| `level`                     | `info`、`warn`、`error`                                        |
| `event`                     | 検索しやすい event 名。例: `http.request.completed`            |
| `message`                   | 短い説明                                                       |
| `request_id`                | HTTP request ID。response の `X-Request-Id` と同じ値           |
| `operation`、`operation_id` | 非同期処理の種類と相関 ID。該当するときだけ出力                |
| `duration_ms`               | 処理時間。計測対象の完了 event に出力                          |
| `error`                     | 失敗の型・message。利用できる場合は stack、code、stderr も含む |

個々の event に応じて `playlist_id`、`video_id`、`status_code`、`mode`、`track_count`、`size_bytes` などを記録します。`info` は stdout、`warn` と `error` は stderr に出ます。

## HTTP request の追跡

各 request にランダムな ID を割り当て、response の `X-Request-Id` header と同じ ID をログへ付けます。その値で request と、それに起因する refresh や配信処理を検索できます。

`http.request.completed` には method、route template、HTTP status、処理時間が入ります。解決できない route は `unmatched` として記録し、request path は記録しません。処理が完了する前に接続が閉じた場合は `http.request.aborted` が出ます。

`GET /health` と relay segment route の通常成功ログは抑制します。失敗応答は記録します。4xx は `warn`、5xx は `error` です。

```bash
docker logs vrchat-ytplaylist-relay 2>&1 | grep '"request_id":"<X-Request-Id>"'
docker logs vrchat-ytplaylist-relay 2>&1 | grep '"event":"http.request.completed"'
```

## よく使う event

| Event                                                    | 意味                                  |
| -------------------------------------------------------- | ------------------------------------- |
| `playlist.refresh.completed` / `playlist.refresh.failed` | Playlist の取得と position 状態の更新 |
| `playlist.refresh.cache_served`                          | メモリ上の manifest を返した          |
| `media.delivery.completed` / `media.delivery.failed`     | 動画配信 request の結果               |
| `media.delivery.fallback`                                | relay 等から別の応答へ切り替えた      |
| `media.cache.downloaded` / `media.cache.download_failed` | VOD のダウンロード結果                |
| `media.cache.evicted`                                    | 容量確保のためキャッシュを削除した    |
| `relay.live.lifecycle.*`                                 | Live HLS 再公開の開始・終了・失敗     |
| `relay.vod.*`                                            | VOD HLS の準備、segment 作成、cleanup |
| `ytdlp.operation.failed`                                 | yt-dlp の実行に失敗した               |

イベント名は実装に沿った分類です。出力される field は event によって異なります。例えば `media.delivery.completed` には配信 mode、Live 判定、HTTP status、処理時間が入ります。

## 機密情報

Logger は Authorization、Cookie、token、署名など、既知の field 名を伏せます。URL の userinfo、query value、fragment、Bearer token も sanitizer の対象です。`message`、`stack`、`stderr` は 4,096 文字まで残します。超過分は省略表示に置き換えます。改行や制御文字は JSON 文字列内に escape されます。

この処理は既知の形式に対する対策です。未知の secret を検出する保証はありません。Authorization header、環境変数、完全な URL、動画タイトルなどを log field に渡さないでください。
