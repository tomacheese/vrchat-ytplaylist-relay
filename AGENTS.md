# AGENTS.md

Guidance for coding agents and contributors working in this repository.

## Language

- Write commit message descriptions, PR / Issue titles and bodies, review comments, code comments / docstrings, and documentation in English.
- Exceptions that stay as they are: Japanese test data and fixtures, quotations, technical identifiers, runtime log / error / response text, the Japanese fork-PR approval comment in `.github/workflows/docker.yml` together with its `body-includes` match key (they must keep matching each other), and `package.json`, which is always English.

## Overview

A Node.js (TypeScript, Express) service that uses yt-dlp to fetch YouTube Playlist entries. It exposes a manifest and media routes for VRChat worlds, and does not depend on a specific world-side player implementation.

Manifests are fetched on demand and cached in memory. `src/manifest-store.ts` assigns each video ID a persistent position. Positions are never reused, so existing media URLs keep their meaning as a Playlist changes. Persisted state (`slots.json`) contains position mappings and refresh metadata only, not Playlist titles or ordering.

User-facing setup and endpoint documentation is in `README.md`; log fields and events are in `docs/logging.md`.

## Commands

```bash
pnpm install
pnpm run dev              # tsx watch src/index.ts
pnpm run build            # tsc -p tsconfig.build.json
pnpm run lint             # prettier + eslint + tsc
pnpm run typecheck
pnpm test                 # vitest run; skips tests needing live yt-dlp, ffmpeg, or network
pnpm run test:integration # RUN_INTEGRATION=1 includes those tests
pnpm refresh [playlistId] # CLI refresh (src/cli.ts)
```

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

## Conventions and invariants

- Pass runtime configuration through `AppConfig`; read environment variables only in `src/config.ts`.
- Register specific routes before broad routes in `src/app.ts`. `/video/:videoId` must precede `/:playlistId/:positionFile`, since both have two path segments.
- Keep Playlist and video ID validation (`PLAYLIST_ID_PATTERN`, `VIDEO_ID_PATTERN` in `src/config.ts`) and path containment checks when changing file handling; they prevent path traversal outside `DATA_DIR` and the cache directories.
- Admin endpoints stay behind `ADMIN_TOKEN` with a constant-time comparison, and must not be called from VRChat worlds.
- Keep credentials out of source, logs, examples, and test output. The logger redacts common credential formats, but call sites must still avoid passing secrets or full media URLs.
- Use the existing TypeScript, ESLint, Prettier, and Vitest setup. Do not weaken TypeScript checks to silence an error.

## Keeping docs in sync

- When adding or changing a setting, update `.env.example` and the setup notes in `README.md`.
- When changing an endpoint, manifest field, delivery mode, or persistence behavior, update `README.md`.
- When changing the log contract, update `docs/logging.md`.
