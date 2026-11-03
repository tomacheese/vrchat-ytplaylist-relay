# VRChat YouTube Playlist Relay

A Node.js server that reads YouTube Playlists and returns the JSON manifests and video endpoints used by VRChat worlds. It does not depend on the video player implementation on the world side.

The Playlist order is fetched from YouTube on demand. Each video's `position` never changes after its first assignment, so existing playback URLs keep working after the Playlist is edited.

## Requirements

- Node.js 24 or later
- pnpm 11.23.0
- `yt-dlp` on PATH, or its executable path in `YTDLP_PATH`
- `deno` on PATH as well when running locally and fetching YouTube data
- `ffmpeg` for `proxy`, Live `proxy`, or VOD `relay` that muxes a separate audio rendition

The Dockerfile bundles Node.js, Deno, ffmpeg, and the yt-dlp standalone binary.

## Running locally

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

`pnpm run dev` starts the server with `tsx`. To build and run instead, use the following.

```bash
pnpm run build
pnpm start
```

The default listen port is `8787`. `.env` is optional. All settings and their defaults are listed in [.env.example](.env.example).

Specify numeric settings as plain integers without units. Invalid, negative, or out-of-range values cause a startup error. `PORT` must be `0` to `65535`; `DEFAULT_MAX_SLOTS`, each Playlist's `maxSlots`, and `MEDIA_MAX_HEIGHT` must be positive integers. Timeouts must be `1` to `2147483647` ms; other durations, sizes, and the proxy hop count must be safe integers of `0` or more.

## Restricting Playlists

If `config/playlists.json` does not exist, the Playlist allowlist is disabled and any YouTube Playlist ID can be used.

To restrict the available Playlists, copy the example and edit the `playlists` array.

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

`displayName` is an optional field for administrators and does not appear in the API manifest. If `maxSlots` is omitted, `DEFAULT_MAX_SLOTS` is used. With the allowlist enabled, requesting an unregistered Playlist returns `404`.

## Endpoints

| Method | Path                                | Behavior                                                                                                |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET`  | `/`                                 | Returns the service name, delivery modes, Playlist IDs, and main endpoints                              |
| `GET`  | `/health`                           | Returns the last refresh state of each configured Playlist. HTTP `200` even when the status is degraded |
| `GET`  | `/:playlistId/manifest.json`        | Returns the Playlist manifest                                                                           |
| `GET`  | `/:playlistId/:position.mp4`        | Serves the video for the manifest position using the configured delivery mode                           |
| `GET`  | `/video/:videoId`                   | Takes a YouTube video ID directly, without a Playlist. The trailing `.mp4` is optional                  |
| `GET`  | `/live/:videoId/:file`              | Returns a Live / VOD relay playlist / segment for the given video ID                                    |
| `GET`  | `/:playlistId/:position/live/:file` | Returns a Live / VOD relay playlist / segment via a Playlist position                                   |
| `POST` | `/admin/refresh`                    | Refreshes all known Playlists                                                                           |
| `POST` | `/admin/refresh/:playlistId`        | Refreshes the specified Playlist                                                                        |

`/video/:videoId` and `/live/:videoId/:file` do not go through the Playlist allowlist. The allowlist restricts the manifest and position routes that go through a Playlist, but not the routes that take a video ID directly.

The manifest format is as follows. `tracks` is the current order on YouTube, but each `position` is an immutable number assigned to a video ID. `generation` increases when the Playlist's order, video IDs, or titles change.

```json
{
  "playlistId": "PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "generation": 1,
  "updatedAt": 1710000000000,
  "tracks": [{ "position": 0, "title": "Video title" }]
}
```

Playlist data is fetched with yt-dlp on request and held in memory only for `MANIFEST_CACHE_TTL_MS`. The Playlist order and titles are not stored on disk. `data/` stores each Playlist's position mapping, generation, refresh state, and so on (`slots.json`), plus video data for the selected delivery mode.

If the first fetch fails and no manifest exists yet, `503` is returned. If a previously fetched manifest exists, it is still returned while refresh is failing. If a position has not been assigned yet, the video endpoint refreshes the manifest and tries to resolve it.

After a Playlist fetch fails, public manifest requests do not refetch it for `MANIFEST_RETRY_DELAY_MS` (default `30000` ms). During that time the previous manifest is returned, or `503` if nothing is cached. Explicit refreshes through the admin endpoints and the CLI run even during the wait. If the failure information cannot be saved to disk, the in-memory manifest continues to be served.

The admin endpoints are available only when `ADMIN_TOKEN` is set, and requests need `Authorization: Bearer <token>`. If the token is unset, `/admin` returns `403`. Normal manifest requests refresh automatically according to the cache TTL, so use the admin endpoints only to refresh without waiting for the TTL.

## Refreshing Playlists from the CLI

Run `pnpm refresh` with the same environment settings as the server. Without arguments it refreshes the configured Playlists in order. If the allowlist is disabled, the directory names directly under `DATA_DIR` are treated as Playlist ID candidates, including directories that do not hold position state. So if you place `cache` or `live` inside `DATA_DIR`, use an allowlist, or move those locations outside `DATA_DIR`. With an ID argument, only that Playlist is refreshed.

The CLI is a separate process from the server. Position state is written to disk, but the running server's in-memory manifest cache is not invalidated, so the change appears in the public manifest only after the TTL expires. To reflect it immediately, use the authenticated admin endpoint.

```bash
pnpm refresh
pnpm refresh PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Video delivery modes

VOD and Live are configured separately. `MEDIA_DELIVERY_MODE` applies to VOD and `LIVE_DELIVERY_MODE` to live streams. Both default to `redirect`.

| Value            | Behavior                                                                                                                                                           | Requirements                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `redirect`       | Returns an HTTP `302` to the YouTube watch URL                                                                                                                     | None                                                    |
| `relay`          | `302` to a URL that serves the HLS resolved by server-side yt-dlp. For VOD with a separate audio rendition, the requested segment is muxed with ffmpeg on delivery | yt-dlp. For VOD muxing, ffmpeg and temporary disk space |
| `relay-redirect` | `302` to the YouTube watch URL if relay resolution or preparation fails                                                                                            | Same as `relay`                                         |
| `proxy`          | VOD is downloaded and served from the disk cache. Live HLS is republished locally with ffmpeg                                                                      | yt-dlp, ffmpeg, disk space                              |
| `hybrid`         | VOD only. Serves cached video directly; if not cached, starts the download and returns a relay-equivalent response                                                 | yt-dlp, ffmpeg, disk space                              |

`hybrid` cannot be set for Live. If either mode is `relay-redirect`, set the other to `redirect` or `relay-redirect`. This combination is restricted because a resolver failure happens before the VOD / Live determination.

`proxy` and `hybrid` serve a completed VOD cache before re-resolving the video information. Even after the TTL expires the stale file is served while it is refreshed in the background, and a failed refresh keeps the stale file. If a single video exceeds `MEDIA_CACHE_MAX_BYTES`, the download is treated as failed and the existing file is not replaced. During a download, the size limit passed to yt-dlp and monitoring of the temporary file stop an overrun. The temporary file may exceed the limit between monitoring intervals.

`proxy` and `hybrid` download video data to the server and serve it again. Before operating them, check the rights to the content, the applicable terms of use, and the disk capacity and network bandwidth required.

## Reverse proxy

When using a reverse proxy such as Nginx, set `TRUST_PROXY` to the actual number of proxy hops up to the server. The default is `1`. Express uses this value to resolve the client address from `X-Forwarded-For`. Do not use a value that trusts unconditionally.

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

`/app/data` stores position state and the VOD cache. Live / relay temporary files are also created there. Put this directory on a volume. To use the allowlist, mount `config/playlists.json` read-only at `/app/config/playlists.json`.

By default the container entrypoint updates yt-dlp at startup and then checks for updates every `YTDLP_UPDATE_INTERVAL_HOURS` hours (default 24). Set `YTDLP_AUTO_UPDATE=0` to disable automatic updates. These two variables are read only by `docker/entrypoint.sh`; they are container-entrypoint settings, not part of `AppConfig` or `.env.example`.

The Docker image supports `linux/amd64` and `linux/arm64` and includes the yt-dlp build for each CPU. Within one process, concurrent downloads are limited to one per cache directory. On a yt-dlp timeout the child processes are also terminated, and the temporary download file is deleted after termination is confirmed.

## Logs

Logs go to stdout / stderr as one JSON object per line. Each line has `timestamp`, `level`, `event`, and `message`, plus `request_id`, `operation_id`, duration, and Playlist / video IDs where relevant. The `X-Request-Id` HTTP response header matches the log `request_id`.

`/health` and Live / VOD segment requests omit logs on normal success; failures are logged. Authorization, Cookie, client IP, request body / query, video titles, and full media URLs are not logged. The log sanitizer redacts known credentials, but there is no guarantee that unknown secrets are detected. Do not pass sensitive values to log fields.

```bash
docker logs -f vrchat-ytplaylist-relay
docker logs vrchat-ytplaylist-relay 2>&1 | grep '"event":"playlist.refresh.failed"'
docker logs vrchat-ytplaylist-relay 2>&1 | grep '"request_id":"<X-Request-Id>"'
```

See [docs/logging.md](docs/logging.md) for an overview of log fields and events.

## Development and verification

```bash
pnpm test                 # self-contained tests
pnpm run typecheck
pnpm run lint
pnpm run test:integration # includes tests that use real yt-dlp / ffmpeg / network
```

Integration tests are enabled by `RUN_INTEGRATION=1`. The regular `pnpm test` skips the cases that use external services. CI runs the lightweight tests.
