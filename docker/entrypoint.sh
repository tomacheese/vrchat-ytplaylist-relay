#!/bin/sh
set -e

# Always update yt-dlp before starting: if it falls behind changes in YouTube's extraction logic,
# "proxy" mode downloads fail en masse. A failed update does not block container startup
# (the existing binary keeps working).
update_ytdlp() {
  yt-dlp -U || echo "[entrypoint] yt-dlp self-update failed, continuing with the current version" >&2
}

if [ "${YTDLP_AUTO_UPDATE:-1}" != "0" ]; then
  update_ytdlp

  # A plain background loop, to avoid adding a cron-like dependency. Rechecks every 24 hours by default.
  (
    interval_hours="${YTDLP_UPDATE_INTERVAL_HOURS:-24}"
    while true; do
      sleep "$((interval_hours * 3600))"
      update_ytdlp
    done
  ) &
fi

exec "$@"
