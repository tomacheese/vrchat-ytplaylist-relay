# syntax=docker/dockerfile:1

# deno: yt-dlp の --js-runtimes (EJS, External JavaScript Solver) が YouTube の n-parameter/signature 解読・PO token 生成に使う外部 JS ランタイム。
# バージョンは Renovate (renovate.json の customManagers) で自動更新するため latest ではなく固定タグを使う。
# --from にはビルドステージ内で定義した ARG の変数展開が使えない (buildx の制約) ため、
# グローバルスコープで ARG を宣言し FROM で別ステージ化してから COPY --from で取り込む。
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

# ffmpeg: "proxy" 配信モードで映像 (DASH) + 音声 (DASH) を mp4 に結合するために必須。
# ca-certificates: yt-dlp / Node の HTTPS 通信に必要。curl: yt-dlp standalone binary の取得用。
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp は pip ではなく standalone binary (yt-dlp_linux, PyInstaller で固めた self-contained build) を使う。
# 素の "yt-dlp" (拡張子なし) は system Python 依存の zipapp なので、Python を同梱したくないこのイメージでは使えない。
# `yt-dlp -U` による自己更新も standalone binary 同士の差し替えとして完結する。
# バージョンは Renovate (renovate.json の customManagers) で自動更新するため latest ではなく固定タグを使う。
ARG YTDLP_VERSION=2026.08.19
RUN curl -fL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
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
