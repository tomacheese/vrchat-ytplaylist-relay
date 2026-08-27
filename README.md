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

`config/playlists.json` は任意。無い場合は allowlist が無効になり、要求された任意の
playlistId をそのまま取得・配信する (事前登録不要)。特定の Playlist だけに絞りたい場合や
Playlist ごとに `maxSlots` を上書きしたい場合は `cp config/playlists.json.example
config/playlists.json` して編集する。設定すると、一覧に無い playlistId は 404 になる。

## Media 配信方式 (`MEDIA_DELIVERY_MODE`)

`GET /:playlistId/:position.mp4` の配信方式は `MEDIA_DELIVERY_MODE` で切り替える。

| 値 | 挙動 | 追加要件 |
|---|---|---|
| `redirect` (既定) | `https://www.youtube.com/watch?v=<videoId>` へ 302 Redirect | なし |
| `proxy` | Backend 自身が yt-dlp + ffmpeg でダウンロード・キャッシュし、バイト列を直接配信 | ffmpeg、ディスク容量 |
| `hybrid` | キャッシュ済みなら `proxy` と同様に配信、未キャッシュなら裏でダウンロードを開始しつつ即座に `redirect` する | ffmpeg、ディスク容量 |

`redirect` は VRChat 同梱の制限付き yt-dlp (`Tools/yt-dlp.exe`) が googlevideo.com への
直リンク解決に失敗し 403 になることがある既知の問題を抱える。`proxy` はこれを回避できるが、
ダウンロード完了まで応答をブロックするため Client 側の Timeout に間に合わないことがある。
`hybrid` は未キャッシュ時に即座に `redirect` 応答を返しつつ裏でダウンロードを進めるため、
Client が Timeout 後に再リクエストしてくる頃にはキャッシュが出来ていて `proxy` 相当の配信に
切り替わる想定の折衷案。`proxy` / `hybrid` はいずれも YouTube 動画データを Backend にダウンロード・
再配信するため、利用規約上のリスクを運用者が許容していることが前提。

`proxy` / `hybrid` はいずれも、キャッシュが `MEDIA_CACHE_TTL_MS` を超えて再ダウンロードが走って
いる間も、直前まで有効だった完了済みキャッシュファイルを Seek 可能な状態のまま配信し続ける
(stale-while-revalidate)。`proxy` はブロックせず、`hybrid` は `redirect` フォールバックせずに
即座に配信し、再ダウンロードが完了すると次回以降のリクエストから新しいファイルに切り替わる。

`proxy` / `hybrid` 関連の設定 (`.env.example` 参照): `MEDIA_MAX_HEIGHT` / `MEDIA_CACHE_DIR` /
`MEDIA_CACHE_MAX_BYTES` / `MEDIA_CACHE_TTL_MS` / `MEDIA_DOWNLOAD_TIMEOUT_MS`。

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
