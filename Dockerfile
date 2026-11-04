# syntax=docker/dockerfile:1

# deno: the external JS runtime that yt-dlp's --js-runtimes (EJS, External JavaScript Solver) uses to
# decipher YouTube n-parameter/signatures and generate PO tokens.
# Renovate (customManagers in renovate.json) updates the version, so use a pinned tag, not latest.
# --from cannot expand an ARG defined inside a build stage (a buildx limitation), so declare the ARG
# at global scope, make deno its own stage with FROM, and pull it in with COPY --from.
ARG DENO_VERSION=2.7.11
FROM denoland/deno:bin-${DENO_VERSION} AS deno

FROM node:24-bookworm-slim AS build

RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM node:24-bookworm-slim AS runtime

# ffmpeg: required in "proxy" mode to merge video (DASH) + audio (DASH) into mp4.
# ca-certificates: needed for yt-dlp / Node HTTPS. curl: used to fetch the yt-dlp standalone binary.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Use the yt-dlp standalone binary (yt-dlp_linux, a self-contained PyInstaller build), not pip.
# The plain "yt-dlp" (no extension) is a zipapp that depends on the system Python, which this image avoids bundling.
# Self-update via `yt-dlp -U` also works as a swap between standalone binaries.
# Renovate (customManagers in renovate.json) updates the version, so use a pinned tag, not latest.
ARG YTDLP_VERSION=2026.10.26
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) ytdlp_binary=yt-dlp_linux ;; \
      arm64) ytdlp_binary=yt-dlp_linux_aarch64 ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${ytdlp_binary}" \
  && chmod a+rx /usr/local/bin/yt-dlp

COPY --from=deno /deno /usr/local/bin/deno

RUN corepack enable

WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist
COPY config ./config
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 8787

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
