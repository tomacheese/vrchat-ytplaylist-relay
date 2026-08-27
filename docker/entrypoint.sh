#!/bin/sh
set -e

# yt-dlp を起動前に必ず最新化する (YouTube 側の抽出ロジック変化に追随できないと "proxy" 配信モードの
# ダウンロードが軒並み失敗するため)。失敗してもコンテナ起動自体は止めない (直前のバイナリのまま続行できる)。
update_ytdlp() {
  yt-dlp -U || echo "[entrypoint] yt-dlp self-update failed, continuing with the current version" >&2
}

if [ "${YTDLP_AUTO_UPDATE:-1}" != "0" ]; then
  update_ytdlp

  # cron 相当の依存を増やさないための単純なバックグラウンドループ。既定では 24 時間ごとに再チェックする。
  (
    interval_hours="${YTDLP_UPDATE_INTERVAL_HOURS:-24}"
    while true; do
      sleep "$((interval_hours * 3600))"
      update_ytdlp
    done
  ) &
fi

exec "$@"
