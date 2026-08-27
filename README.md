# vrchat-ytplaylist-relay

yt-dlp で YouTube Playlist を取得し、VRChat World (`Assets/Tomachi/YamaPlayerRemotePlaylist`)
が消費する `manifest.json` / Media Endpoint を公開する。特定の VRChat 動画プレイヤー実装には依存しない。

## セットアップ (ローカル実行)

```bash
pnpm install
cp .env.example .env   # 必要に応じて編集
cp config/playlists.json.example config/playlists.json   # 対象の Playlist を編集
pnpm run build
pnpm start
# 開発時は pnpm run dev (tsx watch)
```

`config/playlists.json` に対象の YouTube Playlist を列挙する。`ytdlp` は `YTDLP_PATH`
(既定 `yt-dlp`、PATH 上のもの) を使う。

## Media 配信方式 (`MEDIA_DELIVERY_MODE`)

`GET /:playlistId/:position.mp4` の配信方式は `MEDIA_DELIVERY_MODE` で切り替える。

| 値 | 挙動 | 追加要件 |
|---|---|---|
| `redirect` (既定) | `https://www.youtube.com/watch?v=<videoId>` へ 302 Redirect | なし |
| `proxy` | Backend 自身が yt-dlp + ffmpeg でダウンロード・キャッシュし、バイト列を直接配信 | ffmpeg、ディスク容量 |

`redirect` は VRChat 同梱の制限付き yt-dlp (`Tools/yt-dlp.exe`) が googlevideo.com への
直リンク解決に失敗し 403 になることがある既知の問題を抱える。この症状が出る場合は `proxy` に
切り替える。`proxy` は YouTube 動画データを Backend にダウンロード・再配信するため、
利用規約上のリスクを運用者が許容していることが前提。

`proxy` 関連の設定 (`.env.example` 参照): `MEDIA_MAX_HEIGHT` / `MEDIA_CACHE_DIR` /
`MEDIA_CACHE_MAX_BYTES` / `MEDIA_CACHE_TTL_MS` / `MEDIA_DOWNLOAD_TIMEOUT_MS`。

## Docker

`proxy` モードは ffmpeg と、自己更新可能な yt-dlp standalone binary を必要とするため、
Docker Image として提供する。

```bash
docker build -t vrchat-ytplaylist-relay .

docker run -d \
  --name vrchat-ytplaylist-relay \
  -p 8787:8787 \
  -v "$(pwd)/config:/app/config:ro" \
  -v vrchat-ytplaylist-relay-data:/app/data \
  -e MEDIA_DELIVERY_MODE=proxy \
  -e ADMIN_TOKEN=<secret> \
  vrchat-ytplaylist-relay
```

- Entrypoint (`docker/entrypoint.sh`) はコンテナ起動時に `yt-dlp -U` を実行し、以後
  `YTDLP_UPDATE_INTERVAL_HOURS` (既定 24 時間) ごとにバックグラウンドで自己更新し続ける
  (YouTube 側の抽出ロジック変化への追随が `proxy` モードの生命線のため)。
  `YTDLP_AUTO_UPDATE=0` で無効化できる。
- `/app/data` (`DATA_DIR` / `MEDIA_CACHE_DIR` の既定位置) は Volume 化を推奨する。

## テスト

```bash
pnpm test                # ユニット / 統合的な軽量テスト (yt-dlp 実行なし)
pnpm run test:integration  # 実際に yt-dlp / ffmpeg / ネットワークを使う統合テストも含める
pnpm run typecheck
```

`test:integration` は `RUN_INTEGRATION=1` を設定して `pnpm test` と同じテストファイルを実行し、
`{ skip: !shouldRun }` で分岐している実 yt-dlp 呼び出しテスト (Playlist 取得・動画ダウンロード・
`proxy` モードでの Media Endpoint 疎通) も実行する。CI では通常 `pnpm test` のみ実行すればよい。
