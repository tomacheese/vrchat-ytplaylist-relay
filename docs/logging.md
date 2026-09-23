# ログ出力設計

## 背景

この設計の目的は、運用者が Docker / 標準出力から障害の発生箇所・対象・結果を特定し、GitHub のコードベースと照合しやすくすることである。

実装前は `src/logger.ts` が `[playlist-server]` を付けて `console.log` / `warn` / `error` を呼ぶだけで、呼び出し元ごとに自由形式のメッセージを組み立てていた。HTTP リクエストの記録、request ID、処理時間、機械検索できる event 名はなく、yt-dlp / ffmpeg の stderr は独立した行またはメッセージ末尾へ出力されていた。

## 目的

- ログを 1 行 1 JSON オブジェクトに統一し、Docker logs や一般的なログ検索ツールで event、severity、対象 ID を絞り込めるようにする。
- HTTP リクエストと、そのリクエストから開始した非同期処理を request ID で結び付ける。
- YouTube / yt-dlp / ffmpeg、cache、playlist refresh、VOD / Live relay の主要な成功・失敗・fallback を調査できる情報と処理時間を記録する。
- API token、Authorization header、署名付き URL 等を出力せず、外部プロセスの複数行出力でログ行を偽装できないようにする。
- 既存の HTTP 応答形式、配信動作、環境変数、依存関係を変えない。

## 対象範囲

- `src/logger.ts` に構造化 logger、共通 context、error 正規化、診断用文字列の安全化を設ける。
- HTTP request middleware を追加する。`GET /health` と高頻度の Live / VOD segment request は通常成功ログを省略し、失敗は記録する。それ以外の request は成功・失敗とも記録する。
- 起動、CLI refresh、refresh / warm-up、yt-dlp の失敗、cache download / eviction / prefetch、media delivery の mode・fallback、Live / VOD relay の準備・終了・cleanup を一貫した event 名で記録する。
- 既存 logger 呼び出しを移行し、`console.*` を直接使う運用ログを残さない。
- logger と request middleware の形式、相関、redaction、HTTP status / duration、代表的な operation failure のテストを追加する。
- README に出力形式、主要 field、Docker での確認例、redaction 方針を説明する。

## 非対象

- OpenTelemetry exporter、metrics、distributed tracing、外部 log collector の追加。
- log level の runtime 設定、ログファイルへのローテーション、永続保存。
- YouTube 側の 302 redirect 後に発生する再生結果の観測。Backend は redirect 後の client 動作を把握できない。
- 動画タイトル、再生 URL、HTTP query string、client IP、Authorization header の記録。

## 設計

### 出力形式と API

標準出力・標準エラー出力へそれぞれ 1 行 1 JSON object を出す。共通 field は次のとおり。

| Field          | 意味                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `timestamp`    | ISO 8601 UTC の記録時刻                                                                            |
| `level`        | `info`、`warn`、`error`                                                                            |
| `event`        | 安定した機械可読 event 名。例: `http.request.completed`                                            |
| `message`      | 人が読める短い説明                                                                                 |
| `request_id`   | HTTP request middleware が発行した ID。request 外の処理では省略                                    |
| `operation`    | `playlist.refresh`、`media.delivery` 等の処理種別。該当時のみ                                      |
| `operation_id` | 非同期 operation の開始・完了・失敗を相関する ID。該当時のみ                                       |
| `duration_ms`  | 対象処理の経過時間。計測対象の開始と完了がある場合のみ                                             |
| `error`        | 失敗時の `{ type, message, stack, code, stderr }`。利用可能な項目のみ。`stderr` は外部診断 text 用 |

logger API は `logger.info(event, message, fields?)` / `warn` / `error` に統一し、非同期処理の境界で operation context を設定する。`fields` は event ごとに明示し、任意 object を丸ごと渡さない。`Error` は `type`、`message`、`stack` を別 field にし、独自 error の `stderr` は専用の診断 field として redaction・長さ制限を通した値だけを付ける。未知の例外値も安全な文字列と型名に変換する。JSON serialization により CR/LF を含む入力を単一物理行へ escape する。

出力先は従来の Node.js Console と同じく `info` は stdout、`warn` / `error` は stderr とする。出力の書き込み完了や同期性はアプリケーション処理の成功条件にしない。

severity は `info` を通常の完了・状態遷移、`warn` を fallback・部分障害・自動回復可能な問題、`error` を要求失敗・処理不能な失敗に使う。成功した HTTP 4xx は通常の client 入力として request event の `warn` 扱いにし、5xx は `error`、2xx/3xx は `info` とする。

### HTTP 相関

- Middleware は `crypto.randomUUID()` で内部 request ID を発行し、`X-Request-Id` response header と AsyncLocalStorage context に設定する。
- request 完了時 (`finish`) に `http.request.completed` を記録する。method、route template (解決できる場合)、status code、duration、request ID を含める。route template が解決しない request では raw path を出さず、`route: "unmatched"` とする。
- `originalUrl`、path、query、headers、body、client IP はログへ出さない。
- `GET /health` と Live / VOD relay segment route (`/live/:videoId/:file`、`/:playlistId/:position/live/:file`) の通常成功ログは出さない。これらを含め status 4xx/5xx、例外で Express error handler へ到達した場合は request event に記録する。
- Promise、timer 等の非同期処理が request middleware 内で開始された場合も AsyncLocalStorage の request ID を継承する。

### Operation event

ログ event 名は安定した `domain.action.result` 形式にする。主要な記録点は以下。

| Domain           | Event 例                                                                                                                                                                                | 記録する情報                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| server / CLI     | `server.started`, `cli.command.failed`                                                                                                                                                  | port、delivery mode、playlist 数、command。秘密値は含めない               |
| playlist refresh | `playlist.refresh.completed`, `playlist.refresh.failed`, `playlist.refresh.cache_served`                                                                                                | playlist ID、generation、track count、duration、結果・stale 使用有無      |
| yt-dlp / warm-up | `ytdlp.operation.failed`, `relay.warmup.failed`                                                                                                                                         | operation、playlist / video ID、timeout / exit code 等の分類、診断 stderr |
| media cache      | `media.cache.downloaded`, `media.cache.download_failed`, `media.cache.evicted`, `media.prefetch.failed`                                                                                 | video ID、size、eviction reason、retry / cooldown の状態                  |
| media delivery   | `media.delivery.completed`, `media.delivery.failed`, `media.delivery.fallback`                                                                                                          | video ID、live/VOD、選択 mode、結果、fallback reason                      |
| Live / VOD relay | `relay.live.lifecycle.started`, `relay.live.lifecycle.stopped`, `relay.live.lifecycle.failed`, `relay.vod.preparation.completed`, `relay.vod.segment.failed`, `relay.vod.cache.evicted` | video ID、segment index、exit code、byte 数、準備時間、停止理由           |

非同期 background operation は開始から完了まで同じ `operation_id` を使い、completion または failure に elapsed time を含める。高頻度 segment request ごとの成功ログは出さず、HTTP request log の `info` を除外する経路と、失敗・relay lifecycle の event のみを記録する。

### 秘密情報・外部出力

- `ADMIN_TOKEN`、Authorization header、cookie、環境変数一覧、完全な media URL、query parameter 値、動画タイトル、playlist 内容は記録しない。
- logger が受け取る全ての動的 string field (`message`、例外 `message` / `stack` / `code`、stderr を含む) に共通の sanitizer を適用する。URL の query 値と fragment、既知の secret field (`token`、`key`、`signature`、`sig`、`auth` 等) の値、Authorization/Bearer 値を伏せる。外部診断 text は最大 4 KiB に制限し、CR/LF と制御文字を escape する。
- Redaction は既知の URL / credential 形式に対する安全策で、未知形式の任意 secret を判定できる保証ではない。したがって call site は credential、HTTP header、環境変数、完全な URL、動画タイトル等を `fields` に渡してはならない。
- 不正な UTF-8 等があっても logger がアプリケーション処理を失敗させない。serialization 不能時は安全な最小 fallback event を出す。
- stderr は `error` object 内の単一 field に格納し、logger が出す JSON line を複数行へ分割しない。

## 互換性と運用

- stdout/stderr は従来通り Docker logging driver が捕捉する。JSON line 化で `docker logs` は引き続き利用できるが、prefix 付き自由文を grep する既存の独自運用があれば JSON field 検索へ変更が必要。
- Logger は標準 Node.js API の範囲で実装し、production dependency を追加しない。
- HTTP response schema、status、redirect、cache 動作は変更しない。
- `timestamp` を含む JSON line はコンテナ側の logging driver の timestamp とは独立したアプリケーション時刻として扱う。

## 受け入れ条件

1. 運用 logger の出力がすべて有効な JSON Lines で、共通 field と severity の規約に従う。
2. HTTP request log から request ID、method、route template または `unmatched`、status、duration を取得でき、response header の request ID と一致する。raw path、query、Authorization、IP は記録されない。
3. request 由来の refresh / media log に同じ request ID が含まれ、request 外の background operation は欠損値を無理に生成しない。
4. playlist refresh、yt-dlp / ffmpeg failure、media mode fallback、cache download/eviction、relay lifecycle の各 failure に event 名、対象 ID、error type/message、利用可能な duration/code が含まれる。成功した状態遷移 event には event 名、対象 ID、該当する mode・結果・byte 数・duration 等が含まれる。
5. URL の secret query 値や Bearer token、CR/LF を含む stderr を与えても秘密値が出ず、ログが複数の物理行に分割されない。診断 text は 4 KiB 以下。
6. `/health` と Live / VOD relay segment route の通常成功 request は出力されず、同 route の失敗は記録される。HTTP response の既存契約と media 動作は維持される。
7. 対応する unit / integration test、typecheck、lint が通り、README に運用者向け形式と確認方法が記載される。

## 前提と根拠

- Issue 本文が空のため、すべての backend operation を網羅するより、HTTP request と主要な playlist/media/relay の失敗経路を共通形式で相関させることを scope とする。
- JSON Lines は stdout/stderr を収集する現在の Docker 運用に適合し、追加サービスや依存関係を必要としない。Node.js Console API は stdout を通常出力、stderr を warning/error 出力に使う。
- OWASP Logging Cheat Sheet はログ入力の sanitization と secret / sensitive data の除外を推奨する。OpenTelemetry の exception convention は型、message、stack trace を分離して記録する field の参考にする。Node.js Console API は stdout / stderr を出力先に使うが、stream によって同期・非同期の性質が異なると説明しているため、出力成功をアプリケーション処理条件にはしない。

参考資料:

- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [OpenTelemetry exception semantic conventions](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/)
- [Node.js Console API](https://nodejs.org/api/console.html)
