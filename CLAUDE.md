# Project notes for coding assistants

## What this service does

This Node.js service uses yt-dlp to fetch YouTube Playlist entries. It exposes a manifest and media routes for VRChat worlds. The service does not depend on a specific world-side player implementation.

The service fetches the manifest on demand and caches it in memory. `src/manifest-store.ts` assigns each video ID a persistent position. Positions are never reused, so existing media URLs keep their meaning as a Playlist changes. Persisted state contains position mappings and refresh metadata. It does not contain Playlist titles or ordering.

## Where to look

| Area                                           | Files                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| Configuration and validation                   | `src/config.ts`, `.env.example`, `config/playlists.json.example` |
| Express setup and route order                  | `src/app.ts`, `src/routes/`                                      |
| Playlist fetch, cache, and position assignment | `src/ytdlp.ts`, `src/refresh.ts`, `src/manifest-store.ts`        |
| Media mode selection and VOD cache             | `src/media-delivery.ts`, `src/media-cache.ts`                    |
| HLS relay                                      | `src/live-relay.ts`, `src/vod-relay.ts`, `src/hls-filter.ts`     |
| Logs                                           | `src/logger.ts`, `docs/logging.md`                               |
| Tests                                          | `test/`                                                          |

Register specific routes before broad routes in `src/app.ts`. `/video/:videoId` must precede `/:playlistId/:positionFile`. Both routes use two path segments.

## Change guidance

- Pass runtime configuration through `AppConfig`; read environment variables in `src/config.ts`.
- When adding or changing a setting, update `.env.example` and the setup notes in `README.md`.
- When changing an endpoint, manifest field, delivery mode, or persistence behavior, update `README.md`.
- When changing the log contract, update `docs/logging.md`.
- Keep credentials out of source, logs, examples, and test output. The logger redacts common credential formats. Call sites must still avoid passing secrets or full media URLs.
- Preserve route validation and path containment checks when changing media file handling.
- Use the existing TypeScript, ESLint, Prettier, and Vitest setup. Avoid weakening TypeScript checks to silence an error.

## Commands

```bash
pnpm run dev
pnpm run build
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run test:integration
```

`pnpm test` does not run tests that require live yt-dlp, ffmpeg, or network access. `pnpm run test:integration` sets `RUN_INTEGRATION=1` to include those cases.
